// The OS side of the session pool (src/guards/users.ts), run by the root runner as root: session folders in the S2
// `stubs` layout, killing every process of a uid, and wiping what a uid left in the shared writable places.
//
// Session folder (/work/<key>, under a 0711 work root that no session can list):
//   /work/<key>            root:<group> 1770   sticky: the session can add entries, never rename or remove root's
//   /work/<key>/.claude/   root 0755           with the names the sandbox protects pre-created (root-owned)
//   /work/<key>/.mcp.json  root 0644 "{}"
//   /work/<key>/inputs/    root:<group> 1770   root's, so the session can't swap it for a symlink; it adds files in it
//   /work/<key>/outputs/   root:<group> 1770   the same
//   /work/<key>/.home/     <user> 0700         the session's HOME
//   /work/<key>/.tmp/      <user> 0700         the session's TMPDIR
// Anything root reads or writes inside inputs/ or outputs/ (the session's entries) opens it with O_NOFOLLOW or does it
// as the session's uid: a session can put a symlink there.
// Between sessions a folder is parked: root:root 0700, so no session user can reach it, whoever had it before.
import { spawn } from 'node:child_process'
import { chmodSync, lchownSync, lstatSync, readdirSync } from 'node:fs'
import { chmod, chown, lchown, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HOME, INPUTS, OUTPUTS, TMP, WORK_ROOT, sessionPaths } from './paths.ts'
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
/** root:<group> 1770: the session adds files in them but can't rename them. Remade on every take-over. */
export const GROUP_DIRS = [INPUTS, OUTPUTS]
/** The session's own folders, <user> 0700, remade on every take-over. */
export const USER_DIRS = [HOME, TMP]
/** Writable by any user outside the work tree (checked by the image probe in PR B). */
export const SHARED_WRITABLE = ['/tmp', '/var/tmp', '/dev/shm', '/dev/mqueue', '/run/lock']

/** A process: its four uids, whether its leader is a zombie, and how many threads it still has. */
export type ProcEntry = { pid: number; uids: number[]; zombie: boolean; threads: number }

/** Runs a command as the user (its uid and gid, no supplementary groups). Rejects only when it can't be started. */
export type RunAsUser = (user: PoolUser, cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>

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
  /** Runs the wipe's commands as the uid being wiped. */
  runAsUser?: RunAsUser
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
  const runAs = deps.runAsUser ?? runAsUser
  const mustBeRootDir = async (path: string) => {
    const st = await lstat(path)
    if (!st.isDirectory() || st.uid !== rootUid) throw new Error(`${path} must be a directory owned by root`)
  }

  async function killAll(user: PoolUser) {
    const started = now()
    // Once before the first look: a listing can miss a process that's forking, and kill(-1) can't.
    await killAsUser(user).catch(() => {})
    for (let round = 0; ; round++) {
      // A zombie leader is still alive while it has other threads (its main thread called pthread_exit).
      const left = (await listProcs()).filter((p) => (!p.zombie || p.threads > 1) && p.uids.includes(user.uid))
      if (left.length === 0) return
      if (now() - started > deadline) throw new KillError(`${left.length} processes of uid ${user.uid} survived SIGKILL`)
      // kill(-1) as the user reaches every process it owns at once, forks included; it may fail when the user is at
      // its process limit, so each listed process is also killed by pid (which kills its whole thread group).
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
    for (const dir of shared) await wipeOwned(dir, user, runAs)
    await wipeSysV(user, runAs, join(procDir, 'sysvipc'))
  }

  async function prepareFolder(sessionKey: string, user: PoolUser) {
    const p = sessionPaths(sessionKey, workRoot)
    await mustBeRootDir(workRoot)
    if (((await lstat(workRoot)).mode & 0o777) !== 0o711) throw new Error(`${workRoot} must be 0711: sessions must not list it`)
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
    for (const name of [...GROUP_DIRS, ...USER_DIRS]) {
      const dir = join(p.workDir, name)
      const st = await lstat(dir).catch(() => null)
      // Anything that isn't a real directory there (a symlink, a file) is replaced.
      if (st !== null && !st.isDirectory()) await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { mode: 0o700 }).catch(existsOk)
      const mine = USER_DIRS.includes(name)
      await doLchown(dir, mine ? user.uid : 0, user.gid)
      await chmod(dir, mine ? 0o700 : 0o1770)
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
    // Only what a session user made changes hands: a file of root's (or anyone else's) in there stays as it is. A
    // regular file with another name somewhere else may be another uid's file linked in, so it never changes hands.
    const linked = st.isFile() && st.nlink > 1
    if (deps.poolUids.has(st.uid) && !linked) await doLchown(path, user.uid, user.gid)
    if (st.isDirectory() && !st.isSymbolicLink()) {
      for (const name of await readdir(path)) await handOver(join(path, name), user)
    }
  }

  return { killAll, wipeUserFiles, prepareFolder, parkFolder }
}

function existsOk(e: NodeJS.ErrnoException) {
  if (e.code !== 'EEXIST') throw e
}

/**
 * Removes everything the uid owns under `dir`, as the uid itself: a folder swapped for a symlink mid-walk reaches only
 * what that uid could delete anyway. `find -P` (the default) never follows a symlink, `-xdev` stays on one filesystem.
 * Throws when anything of the uid is still there afterwards. A missing dir is fine.
 */
export async function wipeOwned(dir: string, user: PoolUser, run: RunAsUser): Promise<void> {
  const mine = [dir, '-xdev', '-mindepth', '1', '-user', String(user.uid)]
  // Its own folders it closed to itself first (find tests each before going in), then everything it owns, deepest
  // first. Both exit non-zero on folders of other users they can't read; the check below is what counts.
  await run(user, 'find', [...mine, '-type', 'd', '!', '-perm', '-u=rwx', '-exec', 'chmod', 'u+rwx', '{}', ';'])
  await run(user, 'find', [...mine, '-delete'])
  const left = await run(user, 'find', [...mine, '-print', '-quit'])
  if (left.stdout.trim() !== '') throw new Error(`uid ${user.uid} still owns ${left.stdout.trim()} after the wipe`)
}

/**
 * Removes the uid's SysV IPC objects (shared memory, queues, semaphores): `ipcrm --all` as the uid removes exactly what
 * it may, then /proc/sysvipc must show nothing it owns or created. A kernel without SysV IPC has no such files.
 */
export async function wipeSysV(user: PoolUser, run: RunAsUser, sysvDir = '/proc/sysvipc'): Promise<void> {
  await run(user, 'ipcrm', ['--all'])
  for (const kind of ['shm', 'msg', 'sem']) {
    let text: string
    try {
      text = await readFile(join(sysvDir, kind), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw e
    }
    const [head = '', ...rows] = text.split('\n').filter((l) => l.trim() !== '')
    const cols = head.trim().split(/\s+/)
    const at = [cols.indexOf('uid'), cols.indexOf('cuid')]
    if (at.includes(-1)) throw new Error(`/proc/sysvipc/${kind} has no uid columns`)
    const owned = rows.filter((r) => {
      const f = r.trim().split(/\s+/)
      return at.some((i) => Number(f[i]) === user.uid)
    })
    if (owned.length > 0) throw new Error(`uid ${user.uid} still owns ${owned.length} SysV ${kind} objects after the wipe`)
  }
}

/** The real `RunAsUser`: the command as the user, empty environment, stdout collected, stderr dropped. */
export function runAsUser(user: PoolUser, cmd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { uid: user.uid, gid: user.gid, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout }))
  })
}

export type ParkAllDeps = { workRoot?: string; rootUid?: number; lchownSync?: (path: string, uid: number, gid: number) => void }

/**
 * At start: closes the work root to listing (0711) and parks every folder in it, whatever a run before a restart left
 * open. Anything in it that isn't a folder of root's means someone else wrote there: the runner refuses to start.
 */
export function parkAllFolders(deps: ParkAllDeps = {}): void {
  const workRoot = deps.workRoot ?? WORK_ROOT
  const rootUid = deps.rootUid ?? 0
  const doLchown = deps.lchownSync ?? lchownSync
  const root = lstatSync(workRoot)
  if (!root.isDirectory() || root.uid !== rootUid) throw new Error(`${workRoot} must be a directory owned by root`)
  chmodSync(workRoot, 0o711)
  for (const name of readdirSync(workRoot)) {
    const path = join(workRoot, name)
    const st = lstatSync(path)
    if (!st.isDirectory() || st.uid !== rootUid) throw new Error(`${path} is not a session folder of root's; refusing to start`)
    doLchown(path, 0, 0)
    chmodSync(path, 0o700)
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
  const threads = /^Threads:\s+(\d+)\s*$/m.exec(text)
  if (!uidLine || !state) return null
  // No thread count (never on Linux): counted as still running, so a kill that can't be confirmed fails loudly.
  const count = threads ? Number(threads[1]) : Number.MAX_SAFE_INTEGER
  return { pid, uids: uidLine.slice(1, 5).map(Number), zombie: state[1] === 'Z' || state[1] === 'X', threads: count }
}

/** kill(-1, SIGKILL) as the user: every process it owns, in every namespace below this one. The helper dies too. */
export function killAllAsUser(user: PoolUser): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.kill(-1, 9)'], { uid: user.uid, gid: user.gid, env: {}, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', () => resolve())
  })
}
