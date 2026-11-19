// The OS side of the session pool (src/guards/users.ts), run by the root runner as root: session folders in the S2
// `stubs` layout, killing every process of a uid, and wiping what a uid left in the shared writable places.
//
// Session folder (/work/<key>):
//   /work/<key>            root:<group> 1770   sticky: the session can add entries, never rename or remove root's
//   /work/<key>/.claude/   root 0755           with the names the sandbox protects pre-created (root-owned)
//   /work/<key>/.mcp.json  root 0644 "{}"
//   /work/<key>/inputs/    <user> 0700
//   /work/<key>/outputs/   <user> 0700
//   /work/<key>/.home/     <user> 0700         the session's HOME
// Between sessions a folder is parked: root:root 0700, so no session user can reach it, whoever had it before.
import { spawn } from 'node:child_process'
import { chmod, chown, lchown, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HOME, INPUTS, OUTPUTS, WORK_ROOT, sessionPaths } from './paths.ts'
import type { PoolUser, SessionHost } from './users.ts'

/** The sandbox mounts over these in `.claude/`; they must exist and be root's (P0 S2, problem 2). */
export const STUB_DIRS = ['skills', 'agents', 'commands', 'hooks', 'workflows', 'routines', 'worktrees', 'checkpoints', 'mailbox']
export const STUB_FILES: Record<string, string> = {
  'settings.json': '{}',
  'settings.local.json': '{}',
  'scheduled_tasks.json': '[]',
  'scheduled_tasks.lock': '',
  'agent-registry.json': '{}',
}
/** Root's own entries in a session folder; everything else in it is the session's. */
export const ROOT_ENTRIES = new Set(['.claude', '.mcp.json'])
/** The session's own folders, remade on every take-over. */
export const USER_DIRS = [INPUTS, OUTPUTS, HOME]
/** Writable by any user outside the work tree (checked by the image probe in PR B). */
export const SHARED_WRITABLE = ['/tmp', '/var/tmp', '/dev/shm', '/run/lock']

export type ProcEntry = { pid: number; uids: number[]; zombie: boolean }

export type HostDeps = {
  workRoot?: string
  sharedWritable?: string[]
  procDir?: string
  /** Every pool uid: a file in a session folder owned by anyone else (root, say) is never handed to a session. */
  poolUids: ReadonlySet<number>
  lchown?: (path: string, uid: number, gid: number) => Promise<void>
  chown?: (path: string, uid: number, gid: number) => Promise<void>
  /** Sends SIGKILL to every process the user may signal (kill(-1) as that user). */
  killAsUser?: (user: PoolUser) => Promise<void>
  killPid?: (pid: number) => void
  listProcs?: () => Promise<ProcEntry[]>
  /** Waits between checks while killed processes go; grows with each round. */
  pause?: (ms: number) => Promise<void>
  killDeadlineMs?: number
  now?: () => number
  /** The owner every root entry must have: 0, except in tests that can't be root. */
  rootUid?: number
}

export class KillError extends Error {}

export function createSessionHost(deps: HostDeps): SessionHost {
  const workRoot = deps.workRoot ?? WORK_ROOT
  const shared = deps.sharedWritable ?? SHARED_WRITABLE
  const procDir = deps.procDir ?? '/proc'
  const doLchown = deps.lchown ?? lchown
  const doChown = deps.chown ?? chown
  const listProcs = deps.listProcs ?? (() => readProcs(procDir))
  const killAsUser = deps.killAsUser ?? killAllAsUser
  const killPid = deps.killPid ?? ((pid: number) => process.kill(pid, 'SIGKILL'))
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = deps.killDeadlineMs ?? 5_000
  const now = deps.now ?? Date.now
  const rootUid = deps.rootUid ?? 0
  const mustBeRootDir = async (path: string) => {
    const st = await lstat(path)
    if (!st.isDirectory() || st.uid !== rootUid) throw new Error(`${path} must be a directory owned by root`)
  }

  async function killAll(user: PoolUser) {
    const started = now()
    for (let round = 0; ; round++) {
      const left = (await listProcs()).filter((p) => !p.zombie && p.uids.includes(user.uid))
      if (left.length === 0) return
      if (now() - started > deadline) throw new KillError(`${left.length} processes of uid ${user.uid} survived SIGKILL`)
      // kill(-1) as the user reaches every process it owns at once, forks included; it may fail when the user is at
      // its process limit, so each listed process is also killed by pid.
      await killAsUser(user).catch(() => {})
      for (const p of left) {
        try {
          killPid(p.pid)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
        }
      }
      await pause(Math.min(2 ** round, 50))
    }
  }

  async function wipeUserFiles(user: PoolUser) {
    for (const dir of shared) await wipeOwned(dir, user.uid)
  }

  async function prepareFolder(sessionKey: string, user: PoolUser) {
    const p = sessionPaths(sessionKey, workRoot)
    await mustBeRootDir(workRoot)
    await mkdir(p.workDir, { recursive: false, mode: 0o700 }).catch(existsOk)
    await mustBeRootDir(p.workDir)
    // Closed while it's rebuilt, then opened to the session's group.
    await doChown(p.workDir, 0, 0)
    await chmod(p.workDir, 0o700)

    const claude = join(p.workDir, '.claude')
    await rebuildRootTree(claude)
    const mcp = join(p.workDir, '.mcp.json')
    await rm(mcp, { recursive: true, force: true })
    await writeFile(mcp, '{}', { mode: 0o644, flag: 'wx' })
    await doChown(mcp, 0, 0)

    for (const name of await readdir(p.workDir)) {
      if (!ROOT_ENTRIES.has(name)) await handOver(join(p.workDir, name), user)
    }
    for (const name of USER_DIRS) {
      const dir = join(p.workDir, name)
      const st = await lstat(dir).catch(() => null)
      // Anything that isn't a real directory there (a symlink, a file) is replaced.
      if (st !== null && !st.isDirectory()) await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { mode: 0o700 }).catch(existsOk)
      await doLchown(dir, user.uid, user.gid)
      await chmod(dir, 0o700)
    }
    await doChown(p.workDir, 0, user.gid)
    await chmod(p.workDir, 0o1770)
    return { workDir: p.workDir, home: p.home }
  }

  async function parkFolder(sessionKey: string) {
    const p = sessionPaths(sessionKey, workRoot)
    const st = await lstat(p.workDir).catch(() => null)
    if (st === null) return
    await mustBeRootDir(p.workDir)
    await doChown(p.workDir, 0, 0)
    await chmod(p.workDir, 0o700)
  }

  /** Root's `.claude/`: removed if it's anything but what we made, then the stubs (re)made. */
  async function rebuildRootTree(claude: string) {
    const st = await lstat(claude).catch(() => null)
    if (st !== null && (!st.isDirectory() || st.uid !== rootUid)) await rm(claude, { recursive: true, force: true })
    await mkdir(claude, { mode: 0o755 }).catch(existsOk)
    await doChown(claude, 0, 0)
    await chmod(claude, 0o755)
    for (const d of STUB_DIRS) {
      const dir = join(claude, d)
      await mkdir(dir, { mode: 0o755 }).catch(existsOk)
      await doChown(dir, 0, 0)
      await chmod(dir, 0o755)
    }
    for (const [f, text] of Object.entries(STUB_FILES)) {
      const file = join(claude, f)
      await rm(file, { recursive: true, force: true })
      await writeFile(file, text, { mode: 0o644, flag: 'wx' })
      await doChown(file, 0, 0)
    }
  }

  /** Gives a session's own entry (and everything under it) to the new user. Never follows a symlink. */
  async function handOver(path: string, user: PoolUser) {
    const st = await lstat(path)
    // Only what a session user made changes hands: a file of root's (or anyone else's) in there stays as it is.
    if (deps.poolUids.has(st.uid)) await doLchown(path, user.uid, user.gid)
    if (st.isDirectory() && !st.isSymbolicLink()) {
      for (const name of await readdir(path)) await handOver(join(path, name), user)
    }
  }

  return { killAll, wipeUserFiles, prepareFolder, parkFolder }
}

function existsOk(e: NodeJS.ErrnoException) {
  if (e.code !== 'EEXIST') throw e
}

/** Removes everything the uid owns under `dir`, without following symlinks. A missing dir is fine. */
export async function wipeOwned(dir: string, uid: number): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw e
  }
  for (const name of names) {
    const path = join(dir, name)
    const st = await lstat(path).catch(() => null)
    if (st === null) continue
    if (st.uid === uid) await rm(path, { recursive: true, force: true })
    else if (st.isDirectory()) await wipeOwned(path, uid)
  }
}

/** Every process in `/proc`: its real, effective, saved and filesystem uids, and whether it's a zombie. */
export async function readProcs(procDir = '/proc'): Promise<ProcEntry[]> {
  const out: ProcEntry[] = []
  for (const name of await readdir(procDir)) {
    if (!/^\d+$/.test(name)) continue
    let text: string
    try {
      text = await readFile(join(procDir, name, 'status'), 'utf8')
    } catch {
      // Gone between the listing and the read.
      continue
    }
    const entry = parseStatus(Number(name), text)
    if (entry !== null) out.push(entry)
  }
  return out
}

export function parseStatus(pid: number, text: string): ProcEntry | null {
  const uidLine = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(text)
  const state = /^State:\s+(\S)/m.exec(text)
  if (!uidLine || !state) return null
  return { pid, uids: uidLine.slice(1, 5).map(Number), zombie: state[1] === 'Z' || state[1] === 'X' }
}

/** kill(-1, SIGKILL) as the user: every process it owns, in every namespace below this one. The helper dies too. */
export function killAllAsUser(user: PoolUser): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.kill(-1, 9)'], { uid: user.uid, gid: user.gid, env: {}, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', () => resolve())
  })
}
