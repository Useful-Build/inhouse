// The files a run makes and the chat's files it needs (P3, "Files a run makes"). Runs in the session process, as the
// session's user, in its work folder; every call goes through the loopback proxy's `/files/*` route, which adds the
// run's token (so the Worker scopes it to the run's chat).
//
// - At the run's start: `inputs/` and `outputs/` exist, and the chat's files (attachments, earlier outputs) that aren't
//   here yet are brought in, up to `maxRestoreBytes`; the rest are named in `leftOut`.
// - At the run's end: every new or changed regular file under `outputs/` is saved, within the caps (size per file,
//   count per run, type by magic bytes); everything else is refused with a reason.
//
// The agent can write both folders, so nothing here follows a symlink (src/files/safe-dir.ts): not `inputs/` or
// `outputs/` themselves, not a folder under them, not a file or a temp name. This holds without R2's ownership of the
// two folders (`root:<gid> 1770`), which only stops the agent replacing them.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { FileListing, type FileCaps, type RunEventBody } from '../../../shared/protocol/index.ts'
import { badProxyPath } from '../proxy/server.ts'
import type { Fetch } from '../store/adapter.ts'
import { NotFollowed, closeDir, inDir, list, lstatIn, openBelow, openChild, openDir, readFileIn, type Dir } from './safe-dir.ts'
import { sniffType } from './sniff.ts'

export const INPUTS = 'inputs'
export const OUTPUTS = 'outputs'
/** The most entries walked under `outputs/` at a run's end; past it the rest aren't looked at (logged). */
export const OUTPUTS_MAX_WALK = 10_000
/** `file_refused` events sent per run; past it they're counted, and one `file_refused_more` says how many. */
export const REFUSALS_MAX = 50
/** The most names in `files_restored.leftOut` (the schema's cap): past it, the last one says how many more. */
export const LEFT_OUT_MAX = 1000

type FileEvent = Extract<RunEventBody, { type: 'file_saved' | 'file_refused' | 'file_refused_more' | 'files_restored' }>
type Refusal = Extract<FileEvent, { type: 'file_refused' }>

/**
 * The URL path for a file under the proxy's `/files/` route, every segment `encodeURIComponent`-encoded; null for a
 * name the proxy can't carry (`#` or `\` anywhere, a `.` or `..` segment, an empty segment, an unpaired surrogate).
 */
export function filesPath(path: string): string | null {
  const segments = path.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('#') || s.includes('\\'))) return null
  let encoded: string
  try {
    encoded = `/files/${segments.map(encodeURIComponent).join('/')}`
  } catch {
    return null // URIError: an unpaired surrogate
  }
  return badProxyPath(encoded) ? null : encoded
}

/** A snapshot of `outputs/`: path -> size, mtime and inode, to tell new and changed files at the run's end. */
export type Snapshot = Map<string, string>

const sig = (s: { size: number; mtimeMs: number; ino: number }) => `${s.size}:${s.mtimeMs}:${s.ino}`

/** Splits `a/b/c` into its folders and its name. */
function split(rel: string) {
  const parts = rel.split('/')
  return { folders: parts.slice(0, -1), name: parts.at(-1)! }
}

/** Walks the real folders under `root` (never a symlinked one): regular files, and everything else. */
async function walk(root: Dir, limit: number): Promise<{ files: string[]; others: string[]; truncated: boolean }> {
  const files: string[] = []
  const others: string[] = []
  const stack = ['']
  let seen = 0
  while (stack.length > 0) {
    const rel = stack.pop()!
    let entries
    try {
      const dir = await openBelow(root, rel === '' ? [] : rel.split('/'))
      try {
        entries = await list(dir)
      } finally {
        await closeDir(dir)
      }
    } catch (e) {
      // Swapped for a symlink since its parent was listed: never followed, nothing under it saved.
      if (e instanceof NotFollowed && rel !== '') others.push(rel)
      continue
    }
    for (const e of entries) {
      if (++seen > limit) return { files, others, truncated: true }
      const p = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) files.push(p)
      else others.push(p) // symlinks, sockets, fifos: never followed, never saved
    }
  }
  return { files, others, truncated: false }
}

/** `outputs/`, opened as a real folder; null (logged) when it's missing, a symlink or not a folder. */
async function openOutputs(cwd: string, log: (entry: Record<string, unknown>) => void): Promise<Dir | null> {
  try {
    return await openDir(join(cwd, OUTPUTS))
  } catch (e) {
    log({ type: 'outputs_not_a_folder', error: String(e instanceof Error ? e.message : e).slice(0, 200) })
    return null
  }
}

export async function snapshotOutputs(cwd: string, log: (entry: Record<string, unknown>) => void = () => {}): Promise<Snapshot> {
  const snap: Snapshot = new Map()
  const root = await openOutputs(cwd, log)
  if (root === null) return snap
  try {
    for (const f of (await walk(root, OUTPUTS_MAX_WALK)).files) {
      const { folders, name } = split(f)
      const dir = await openBelow(root, folders).catch(() => null)
      if (dir === null) continue
      try {
        const st = await lstatIn(dir, name).catch(() => null)
        if (st?.isFile()) snap.set(f, sig(st))
      } finally {
        await closeDir(dir)
      }
    }
  } finally {
    await closeDir(root)
  }
  return snap
}

/** Thrown when a save is cut by its signal (a stop's deadline). */
class Cut extends Error {}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return p
  if (signal.aborted) return Promise.reject(new Cut())
  return new Promise<T>((res, rej) => {
    const onAbort = () => rej(new Cut())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => (signal.removeEventListener('abort', onAbort), res(v)),
      (e) => (signal.removeEventListener('abort', onAbort), rej(e)),
    )
  })
}

/** Makes the folder `name` in `dir` (if missing) and opens it; it must be a real folder. */
async function makeChild(dir: Dir, name: string): Promise<Dir> {
  await mkdir(inDir(dir, name)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e
  })
  return openChild(dir, name)
}

/** At most `max` names; past it the last one says how many more were left out. */
export function capLeftOut(names: string[], max = LEFT_OUT_MAX): string[] {
  return names.length <= max ? names : [...names.slice(0, max - 1), `and ${names.length - max + 1} more`]
}

export function createFiles(deps: { fetch: Fetch; proxyUrl: string; cwd: string; caps: FileCaps; log: (entry: Record<string, unknown>) => void }) {
  const base = deps.proxyUrl.replace(/\/$/, '')
  const { cwd, caps, log } = deps

  /** Makes the work folder's `inputs/` and `outputs/`, then brings in the chat's files that aren't here yet. */
  async function restore(): Promise<Extract<FileEvent, { type: 'files_restored' }>> {
    const tops = new Map<string, Dir>()
    try {
      for (const top of [INPUTS, OUTPUTS]) {
        await mkdir(join(cwd, top), { recursive: true })
        // Must be a real folder: a symlinked `inputs/` or `outputs/` fails the restore (and the run, as `files`).
        tops.set(top, await openDir(join(cwd, top)))
      }
      const res = await deps.fetch(`${base}/files/`, { method: 'GET' })
      if (!res.ok) throw new Error(`file listing: ${res.status}`)
      const listing = FileListing.parse(await res.json())
      let restored = 0
      let bytes = 0
      const leftOut: string[] = []
      for (const f of listing.files) {
        const url = filesPath(f.path)
        if (localPath(cwd, f.path) === null || url === null) {
          log({ type: 'file_restore_skipped', reason: 'bad path', bytes: f.bytes })
          continue
        }
        const [top, ...rest] = f.path.split('/')
        const { folders, name } = split(rest.join('/'))
        const opened: Dir[] = []
        try {
          let dir = tops.get(top!)!
          try {
            for (const s of folders) {
              dir = await makeChild(dir, s)
              opened.push(dir)
            }
          } catch (e) {
            if (!(e instanceof NotFollowed)) throw e
            log({ type: 'file_restore_skipped', reason: 'symlink on the way', bytes: f.bytes })
            continue
          }
          // lstat: a symlink here is not "already here", and is replaced below, never written through.
          const here = await lstatIn(dir, name).catch(() => null)
          if (here?.isFile() && here.size === f.bytes) continue
          if (bytes + f.bytes > caps.maxRestoreBytes) {
            leftOut.push(f.path)
            continue
          }
          const got = await deps.fetch(`${base}${url}`, { method: 'GET' })
          if (!got.ok) throw new Error(`file download: ${got.status}`)
          const body = new Uint8Array(await got.arrayBuffer())
          // The listing's size is what the budget counted; a body past it would overrun the cap.
          if (body.length !== f.bytes) throw new Error(`file download: ${body.length} bytes, listed as ${f.bytes}`)
          // A fresh random name, created exclusively (a file or symlink planted there fails it, never written
          // through), then renamed over the target (which replaces a symlink there rather than following it).
          const tmp = `.restoring-${randomBytes(12).toString('hex')}`
          await writeFile(inDir(dir, tmp), body, { flag: 'wx' })
          try {
            await rename(inDir(dir, tmp), inDir(dir, name))
          } catch (e) {
            await unlink(inDir(dir, tmp)).catch(() => undefined)
            log({ type: 'file_restore_skipped', reason: 'could not be put in place', error: String((e as NodeJS.ErrnoException).code ?? e).slice(0, 100), bytes: f.bytes })
            continue
          }
          restored++
          bytes += body.length
        } finally {
          for (const d of opened) await closeDir(d)
        }
      }
      return { type: 'files_restored', restored, bytes, leftOut: capLeftOut(leftOut) }
    } finally {
      for (const d of tops.values()) await closeDir(d)
    }
  }

  // What this run's saves have done so far: a stop's deadline can cut one save, and a later one picks up from there.
  const handled = new Set<string>()
  let count = 0
  let refusals = 0
  let unsent = 0

  /**
   * Saves every new or changed regular file under `outputs/` since `before`, within the caps. Never throws. Returns
   * false when `signal` cut it short; a later call saves what this one didn't get to.
   */
  async function save(before: Snapshot, emit: (e: FileEvent) => unknown, signal?: AbortSignal): Promise<boolean> {
    const refuse = async (e: Refusal) => {
      handled.add(e.path)
      if (refusals++ < REFUSALS_MAX) await emit(e)
      else unsent++
    }
    const root = await openOutputs(cwd, log)
    if (root === null) return true
    try {
      const { files, others, truncated } = await walk(root, OUTPUTS_MAX_WALK)
      if (truncated) log({ type: 'outputs_walk_truncated', limit: OUTPUTS_MAX_WALK })
      for (const o of others.sort()) {
        const path = `${OUTPUTS}/${o}`.slice(0, 1024)
        if (!handled.has(path)) await refuse({ type: 'file_refused', path, reason: 'type_not_allowed' })
      }
      for (const rel of files.sort()) {
        if (signal?.aborted) return false
        const path = `${OUTPUTS}/${rel}`
        if (handled.has(path.slice(0, 1024))) continue
        try {
          await saveOne(root, rel, path, before, refuse, emit, signal)
        } catch (e) {
          if (e instanceof Cut) return false
          throw e
        }
      }
      return true
    } finally {
      await closeDir(root)
      if (unsent > 0) {
        await emit({ type: 'file_refused_more', count: unsent })
        unsent = 0
      }
    }
  }

  async function saveOne(
    root: Dir,
    rel: string,
    path: string,
    before: Snapshot,
    refuse: (e: Refusal) => Promise<void>,
    emit: (e: FileEvent) => unknown,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const shown = path.slice(0, 1024)
    const { folders, name } = split(rel)
    let dir: Dir
    try {
      dir = await openBelow(root, folders)
    } catch {
      // A folder on the way was swapped for a symlink (or went away) since the walk.
      return refuse({ type: 'file_refused', path: shown, reason: 'save_failed' })
    }
    try {
      const st = await lstatIn(dir, name).catch(() => null)
      if (st === null) return
      if (!st.isFile()) return refuse({ type: 'file_refused', path: shown, reason: 'type_not_allowed' })
      if (before.get(rel) === sig(st)) return void handled.add(shown)
      const url = filesPath(path)
      if (url === null || path.length > 1024) return refuse({ type: 'file_refused', path: shown, reason: 'bad_name', bytes: st.size })
      // A second link could be a file from anywhere the session's user can read.
      if (st.nlink > 1) return refuse({ type: 'file_refused', path, reason: 'type_not_allowed', bytes: st.size })
      if (st.size > caps.maxFileBytes) return refuse({ type: 'file_refused', path, reason: 'too_large', bytes: st.size })
      if (count >= caps.maxFilesPerTurn) return refuse({ type: 'file_refused', path, reason: 'too_many', bytes: st.size })
      let body: Uint8Array
      try {
        body = await readFileIn(dir, name, st)
      } catch {
        // It changed while being read (or went away, or was swapped): what was checked isn't what would be saved.
        return refuse({ type: 'file_refused', path, reason: 'save_failed', bytes: st.size })
      }
      const contentType = sniffType(body, rel)
      if (!caps.allowedTypes.includes(contentType)) return refuse({ type: 'file_refused', path, reason: 'type_not_allowed', bytes: body.length })
      count++
      try {
        const res = await untilAborted(
          deps.fetch(`${base}${url}`, {
            method: 'PUT',
            headers: { 'content-type': contentType, 'x-inhouse-sha256': createHash('sha256').update(body).digest('hex') },
            body,
            signal,
          }),
          signal,
        )
        if (!res.ok) throw new Error(String(res.status))
      } catch (e) {
        if (e instanceof Cut) {
          count-- // not sent: a later save tries it again
          throw e
        }
        log({ type: 'file_save_failed', error: String(e instanceof Error ? e.message : e).slice(0, 200) })
        return refuse({ type: 'file_refused', path, reason: 'save_failed', bytes: body.length })
      }
      handled.add(path)
      await emit({ type: 'file_saved', path, bytes: body.length, contentType })
    } finally {
      await closeDir(dir)
    }
  }

  return { restore, save }
}

/** The local path for a listed file: under `inputs/` or `outputs/` of the work folder, or null. */
export function localPath(cwd: string, path: string): string | null {
  const segments = path.split('/')
  if (segments.length < 2 || (segments[0] !== INPUTS && segments[0] !== OUTPUTS)) return null
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\0') || s.includes('\\'))) return null
  const full = resolve(cwd, ...segments)
  const rel = relative(resolve(cwd), full)
  if (rel.startsWith('..') || rel.split(sep)[0] !== segments[0]) return null
  return full
}
