// The files a run makes and the chat's files it needs (P3, "Files a run makes"). Runs in the session process, as the
// session's user, in its work folder; every call goes through the loopback proxy's `/files/*` route, which adds the
// run's token (so the Worker scopes it to the run's chat).
//
// - At the run's start: `inputs/` and `outputs/` exist, and the chat's files (attachments, earlier outputs) that aren't
//   here yet are brought in, up to `maxRestoreBytes`; the rest are named in `leftOut`.
// - At the run's end: every new or changed regular file under `outputs/` is saved, within the caps (size per file,
//   count per run, type by magic bytes); everything else is refused with a reason.
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { FileListing, type FileCaps, type RunEventBody } from '../../../shared/protocol/index.ts'
import { badProxyPath } from '../proxy/server.ts'
import type { Fetch } from '../store/adapter.ts'
import { sniffType } from './sniff.ts'

export const INPUTS = 'inputs'
export const OUTPUTS = 'outputs'
/** The most entries walked under `outputs/` at a run's end; past it the rest aren't looked at (logged). */
export const OUTPUTS_MAX_WALK = 10_000

type FileEvent = Extract<RunEventBody, { type: 'file_saved' | 'file_refused' | 'files_restored' }>

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

async function walk(root: string, limit: number): Promise<{ files: string[]; others: string[]; truncated: boolean }> {
  const files: string[] = []
  const others: string[] = []
  const stack = ['']
  let seen = 0
  while (stack.length > 0) {
    const rel = stack.pop()!
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
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

export async function snapshotOutputs(cwd: string): Promise<Snapshot> {
  const root = join(cwd, OUTPUTS)
  const snap: Snapshot = new Map()
  for (const f of (await walk(root, OUTPUTS_MAX_WALK)).files) {
    try {
      snap.set(f, sig(await lstat(join(root, f))))
    } catch {
      // Gone since the walk.
    }
  }
  return snap
}

export function createFiles(deps: { fetch: Fetch; proxyUrl: string; cwd: string; caps: FileCaps; log: (entry: Record<string, unknown>) => void }) {
  const base = deps.proxyUrl.replace(/\/$/, '')
  const { cwd, caps } = deps

  /** Makes the work folder's `inputs/` and `outputs/`, then brings in the chat's files that aren't here yet. */
  async function restore(): Promise<Extract<FileEvent, { type: 'files_restored' }>> {
    await mkdir(join(cwd, INPUTS), { recursive: true })
    await mkdir(join(cwd, OUTPUTS), { recursive: true })
    const res = await deps.fetch(`${base}/files/`, { method: 'GET' })
    if (!res.ok) throw new Error(`file listing: ${res.status}`)
    const listing = FileListing.parse(await res.json())
    let restored = 0
    let bytes = 0
    const leftOut: string[] = []
    for (const f of listing.files) {
      const target = localPath(cwd, f.path)
      const url = filesPath(f.path)
      if (target === null || url === null) {
        deps.log({ type: 'file_restore_skipped', reason: 'bad path', bytes: f.bytes })
        continue
      }
      const here = await stat(target).catch(() => null)
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
      await mkdir(dirname(target), { recursive: true })
      const tmp = `${target}.restoring`
      await writeFile(tmp, body)
      await rename(tmp, target)
      restored++
      bytes += body.length
    }
    return { type: 'files_restored', restored, bytes, leftOut }
  }

  /** Saves every new or changed regular file under `outputs/` since `before`, within the caps. Never throws. */
  async function save(before: Snapshot, emit: (e: FileEvent) => unknown): Promise<void> {
    const root = join(cwd, OUTPUTS)
    const { files, others, truncated } = await walk(root, OUTPUTS_MAX_WALK)
    if (truncated) deps.log({ type: 'outputs_walk_truncated', limit: OUTPUTS_MAX_WALK })
    for (const o of others.sort()) await emit({ type: 'file_refused', path: `${OUTPUTS}/${o}`.slice(0, 1024), reason: 'type_not_allowed' })
    let count = 0
    for (const rel of files.sort()) {
      const path = `${OUTPUTS}/${rel}`
      const full = join(root, rel)
      let st
      try {
        st = await lstat(full)
      } catch {
        continue
      }
      if (!st.isFile() || before.get(rel) === sig(st)) continue
      const url = filesPath(path)
      if (url === null || path.length > 1024) {
        await emit({ type: 'file_refused', path: path.slice(0, 1024), reason: 'bad_name', bytes: st.size })
        continue
      }
      if (st.size > caps.maxFileBytes) {
        await emit({ type: 'file_refused', path, reason: 'too_large', bytes: st.size })
        continue
      }
      if (count >= caps.maxFilesPerTurn) {
        await emit({ type: 'file_refused', path, reason: 'too_many', bytes: st.size })
        continue
      }
      let body: Uint8Array
      try {
        body = await readWhole(full, st.size)
      } catch {
        // It changed while being read (or went away): what was checked isn't what would be saved.
        await emit({ type: 'file_refused', path, reason: 'save_failed', bytes: st.size })
        continue
      }
      const contentType = sniffType(body, rel)
      if (!caps.allowedTypes.includes(contentType)) {
        await emit({ type: 'file_refused', path, reason: 'type_not_allowed', bytes: body.length })
        continue
      }
      count++
      try {
        const res = await deps.fetch(`${base}${url}`, {
          method: 'PUT',
          headers: { 'content-type': contentType, 'x-inhouse-sha256': createHash('sha256').update(body).digest('hex') },
          body,
        })
        if (!res.ok) throw new Error(String(res.status))
        await emit({ type: 'file_saved', path, bytes: body.length, contentType })
      } catch (e) {
        deps.log({ type: 'file_save_failed', error: String(e instanceof Error ? e.message : e).slice(0, 200) })
        await emit({ type: 'file_refused', path, reason: 'save_failed', bytes: body.length })
      }
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

/** Reads a file of `size` bytes (already checked against the cap), refusing one whose size changed since. */
async function readWhole(path: string, size: number): Promise<Uint8Array> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(size + 1)
    let n = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n)
      if (bytesRead === 0) break
      n += bytesRead
      if (n > size) throw new Error('grew while being read')
    }
    if (n !== size) throw new Error('shrank while being read')
    return buf.subarray(0, n)
  } finally {
    await fh.close()
  }
}
