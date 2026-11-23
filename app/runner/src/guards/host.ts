// The OS side of the session pool (src/guards/users.ts), run by the root runner as root: session folders in the S2
// `stubs` layout, killing every process of a uid, and wiping what a uid left in the shared writable places.
//
// Session folder (/work/<key>, under a 0711 work root that no session can list):
//   /work/<key>            root:<group> 1770   sticky: the session can add entries, never rename or remove root's
//   /work/<key>/.claude/   root 0755           with the names the sandbox protects pre-created (root-owned)
//   /work/<key>/.mcp.json  root 0644 "{}"
//   /work/<key>/inputs/    root:<group> 1770   root's, so the session can't swap it for a symlink; it adds files in it
//   /work/<key>/outputs/   root:<group> 1770   the same
// Anything root reads or writes inside inputs/ or outputs/ (the session's entries) opens it with O_NOFOLLOW or does it
// as the session's uid: a session can put a symlink there.
// Between sessions a folder is parked: root:root 0700, so no session user can reach it, whoever had it before.
//
// Each pool user's own folders, outside the work tree (why: src/guards/paths.ts, USERS_ROOT):
//   /users                 root 0755
//   /users/<user>/         root 0755           root's, so the session can't rename or swap what's in it
//   /users/<user>/home/    <user> 0700         the session's HOME
//   /users/<user>/tmp/     <user> 0700         the session's TMPDIR
//   /users/<user>/brand-plugin/  root 0755     the run's brand skills (`brand:<name>`), its files root 0644
// They belong to the uid, not the chat: the wipe empties both (as the uid itself), so a uid's next session finds
// nothing of the last one. What a chat keeps is its session folder, and its transcript in the session store.
import { spawn } from 'node:child_process'
import { chmodSync, lchownSync, lstatSync, readdirSync } from 'node:fs'
import { chmod, chown, lchown, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BRAND_PLUGIN_NAME, brandSkillNameProblem, renderSkillFile, type BrandSkillFile } from '../../../shared/protocol/brand-skills.ts'
import { INPUTS, OUTPUTS, USERS_ROOT, WORK_ROOT, sessionPaths, userPaths } from './paths.ts'
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
/** Writable by any user outside the work tree (checked by the image probe in PR B). */
export const SHARED_WRITABLE = ['/tmp', '/var/tmp', '/dev/shm', '/dev/mqueue', '/run/lock']

/** A process: its four uids, whether its leader is a zombie, and how many threads it still has. */
export type ProcEntry = { pid: number; uids: number[]; zombie: boolean; threads: number }

/** Runs a command as the user (its uid and gid, no supplementary groups). Rejects only when it can't be started. */
export type RunAsUser = (user: PoolUser, cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>
/** Runs a command as the root runner itself. The wipe uses it only to look, never to change anything. */
export type RunAsRoot = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>

export type HostDeps = {
  workRoot?: string
  usersRoot?: string
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
  /** Runs the wipe's read-only look afterwards, as root. */
  runAsRoot?: RunAsRoot
}

export class KillError extends Error {}

export function createSessionHost(deps: HostDeps): SessionHost {
  const workRoot = deps.workRoot ?? WORK_ROOT
  const usersRoot = deps.usersRoot ?? USERS_ROOT
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
  const runRoot = deps.runAsRoot ?? runAsRoot
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
    // Every place is tried before it throws: a uid that fails (and is quarantined) leaves as little behind as it can.
    const failed: string[] = []
    const own = userPaths(user.user, usersRoot)
    for (const dir of [own.home, own.tmp]) await emptyOwn(dir, user, runAs, runRoot).catch((e: unknown) => void failed.push(String(e instanceof Error ? e.message : e)))
    for (const dir of shared) await wipeOwned(dir, user, runAs, runRoot).catch((e: unknown) => void failed.push(String(e instanceof Error ? e.message : e)))
    await wipeSysV(user, runAs, join(procDir, 'sysvipc')).catch((e: unknown) => void failed.push(String(e instanceof Error ? e.message : e)))
    if (failed.length > 0) throw new Error(failed.join('; '))
  }

  async function prepareFolder(sessionKey: string, user: PoolUser) {
    const p = sessionPaths(sessionKey, workRoot)
    await mustBeRootDir(workRoot)
    if (((await lstat(workRoot)).mode & 0o777) !== 0o711) throw new Error(`${workRoot} must be 0711: sessions must not list it`)
    const own = await ownFolders(user)
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
    for (const name of GROUP_DIRS) {
      const dir = join(p.workDir, name)
      const st = await lstat(dir).catch(() => null)
      // Anything that isn't a real directory there (a symlink, a file) is replaced.
      if (st !== null && !st.isDirectory()) await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { mode: 0o700 }).catch(existsOk)
      await doLchown(dir, 0, user.gid)
      await chmod(dir, 0o1770)
    }
    await doChown(p.workDir, 0, user.gid)
    await chmod(p.workDir, 0o1770)
    return { workDir: p.workDir, home: own.home }
  }

  /**
   * The user's own home and temp folder (see the top). Root makes them in a folder of its own, so no session can swap
   * one for a symlink, and closes each to everyone else again: its owner may have opened it. It never empties them:
   * that's the wipe's, done as the uid.
   */
  async function ownFolders(user: PoolUser) {
    const own = userPaths(user.user, usersRoot)
    await mustBeRootDir(usersRoot)
    await mkdir(own.dir, { mode: 0o755 }).catch(existsOk)
    await mustBeRootDir(own.dir)
    await chmod(own.dir, 0o755)
    for (const dir of [own.home, own.tmp]) {
      await mkdir(dir, { mode: 0o700 }).catch(existsOk)
      if (!(await lstat(dir)).isDirectory()) throw new Error(`${dir} must be a directory`)
      await doLchown(dir, user.uid, user.gid)
      await chmod(dir, 0o700)
    }
    return own
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

  /**
   * The run's brand skills, as a plugin: removed whole and made again, every folder root 0755 and every file root
   * 0644, so the session (another uid) can read them and change nothing. Its parent is root's 0755 (`ownFolders`), so
   * no session can put anything in its place. The names were checked on the wire (one plain segment each).
   */
  async function writeBrandPlugin(user: PoolUser, skills: readonly BrandSkillFile[]) {
    for (const s of skills) {
      if (brandSkillNameProblem(s.name) !== null) throw new Error('invalid brand skill name')
    }
    const own = await ownFolders(user)
    await rm(own.brandPlugin, { recursive: true, force: true })
    const dirs = [own.brandPlugin, join(own.brandPlugin, '.claude-plugin'), join(own.brandPlugin, 'skills'), ...skills.map((s) => join(own.brandPlugin, 'skills', s.name))]
    for (const dir of dirs) {
      await mkdir(dir, { mode: 0o755 })
      await doChown(dir, 0, 0)
      await chmod(dir, 0o755)
    }
    const files: [string, string][] = [
      [join(own.brandPlugin, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: BRAND_PLUGIN_NAME, description: "This brand's own skills, made in its chats." })}\n`],
      ...skills.map((s): [string, string] => [join(own.brandPlugin, 'skills', s.name, 'SKILL.md'), renderSkillFile(s)]),
    ]
    for (const [file, text] of files) {
      await writeFile(file, text, { mode: 0o644, flag: 'wx' })
      await doChown(file, 0, 0)
      await chmod(file, 0o644)
    }
  }

  return { killAll, wipeUserFiles, prepareFolder, parkFolder, writeBrandPlugin }
}

function existsOk(e: NodeJS.ErrnoException) {
  if (e.code !== 'EEXIST') throw e
}

/**
 * Removes everything the uid owns under `dir`, as the uid itself: a folder swapped for a symlink mid-walk reaches only
 * what that uid could delete anyway. `find -P` (the default) never follows a symlink, `-xdev` stays on one filesystem.
 * Throws when anything of the uid is still there afterwards. A missing dir is fine.
 *
 * The look afterwards is root's, and it only reads: the uid can't see into a folder another uid closed, so its own
 * look would miss a file it left there. Only root can give a file away, but another session can still put one of this
 * uid's files in its own path: a hard link to it (anywhere on the same filesystem it can write), or a rename of it in a
 * folder without the sticky bit. A hit is this uid's own doing only while `fs.protected_hardlinks` is 1 (no link to a
 * file you don't own) and every shared writable folder is sticky (no rename of another uid's entry); PR B's image probe
 * checks both.
 */
export async function wipeOwned(dir: string, user: PoolUser, run: RunAsUser, runRoot: RunAsRoot): Promise<void> {
  const mine = [dir, '-xdev', '-mindepth', '1', '-user', String(user.uid)]
  // Its own folders it closed to itself first (find tests each before going in), then everything it owns, deepest
  // first. Both exit non-zero on folders of other users they can't read; the check below is what counts.
  await run(user, 'find', [...mine, '-type', 'd', '!', '-perm', '-u=rwx', '-exec', 'chmod', 'u+rwx', '{}', ';'])
  await run(user, 'find', [...mine, '-delete'])
  // Only what it prints counts, never its exit code: a live session deleting its own files mid-walk makes find exit
  // non-zero, and that must not fail another uid's wipe.
  const left = await runRoot('find', [...mine, '-print', '-quit'])
  if (left.stdout.trim() !== '') throw new Error(`uid ${user.uid} still owns ${left.stdout.trim()} after the wipe`)
}

/**
 * Empties one of the uid's own folders (its home or its temp folder), as the uid itself, and throws when anything is
 * still in it afterwards. Everything in it goes, whoever owns it: the folder is this uid's alone, the next chat on the
 * uid must find nothing in it, and a file another uid put there (in a folder this one opened to it) counts too. The
 * folder itself stays: it sits in root's folder, where the uid can't remove it. The look afterwards is root's and only
 * reads. A missing folder is fine: the uid hasn't served a session yet.
 */
export async function emptyOwn(dir: string, user: PoolUser, run: RunAsUser, runRoot: RunAsRoot): Promise<void> {
  // The folders it closed to itself first: this one (it's in root's folder, so the name is the folder root made), then
  // the ones in it (find tests each before going in). Then everything in it, deepest first. `find -P` never follows a
  // symlink.
  await run(user, 'chmod', ['u+rwx', dir])
  await run(user, 'find', [dir, '-xdev', '-mindepth', '1', '-type', 'd', '!', '-perm', '-u=rwx', '-exec', 'chmod', 'u+rwx', '{}', ';'])
  await run(user, 'find', [dir, '-xdev', '-mindepth', '1', '-delete'])
  const left = await runRoot('find', [dir, '-xdev', '-mindepth', '1', '-print', '-quit'])
  if (left.stdout.trim() !== '') throw new Error(`uid ${user.uid}'s own folder still holds ${left.stdout.trim()} after the wipe`)
}

/** /proc/sysvipc's files, the column each keeps its ids in, and the `ipcrm` flag that removes one by id. */
const SYSV_KINDS = [
  ['shm', 'shmid', '-m'],
  ['msg', 'msqid', '-q'],
  ['sem', 'semid', '-s'],
] as const
/** Ids per `ipcrm` run: a session can make tens of thousands of objects, and one command line can't carry them all. */
export const SYSV_BATCH = 500

type SysVRow = { id: number; uid: number; cuid: number }

/** Every object of one kind, as root sees it (all of them, whatever their mode). Null on a kernel without SysV IPC. */
async function readSysV(sysvDir: string, kind: string, idColumn: string): Promise<SysVRow[] | null> {
  let text: string
  try {
    text = await readFile(join(sysvDir, kind), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  const [head = '', ...rows] = text.split('\n').filter((l) => l.trim() !== '')
  const cols = head.trim().split(/\s+/)
  const at = [cols.indexOf(idColumn), cols.indexOf('uid'), cols.indexOf('cuid')] as const
  if (at.includes(-1)) throw new Error(`/proc/sysvipc/${kind} has no ${idColumn}, uid or cuid columns`)
  return rows.map((r) => {
    const f = r.trim().split(/\s+/)
    const [id, uid, cuid] = at.map((i) => Number(f[i])) as [number, number, number]
    if (![id, uid, cuid].every(Number.isInteger)) throw new Error(`/proc/sysvipc/${kind} has a row that can't be read: ${r.trim()}`)
    return { id, uid, cuid }
  })
}

/**
 * Removes the uid's SysV IPC objects (shared memory, queues, semaphores), then fails if anything it created is still
 * there. The kernel's rules this follows (ipc/util.c):
 * - an object has an owner (`uid`) and a creator (`cuid`). The creator is whoever made it and never changes. The owner
 *   is whatever uid the creator (or the last owner) named with IPC_SET, which needs no privilege: a process of one
 *   uid can name any other uid the owner of its own objects.
 * - the owner and the creator may each remove an object, whatever its mode. A segment still attached somewhere is only
 *   marked by that, and stays in the table (and attachable by its id) until its last detach.
 *
 * So the removal covers every object the uid owns or created, and runs as the uid itself, by id from root's listing:
 * `ipcrm --all` would stat each object first and skip the ones the uid made unreadable to itself. The check counts the
 * creator only. A row that merely names the uid as owner is another session's doing, and counting it would let one live
 * session fail every other uid's wipe and drain the pool; a row the uid created can only be its own session's doing
 * (its processes are dead by now, so no new one appears), and one that survives would be open to the next chat on the
 * uid, so it fails the wipe. A kernel without SysV IPC has no such files.
 */
export async function wipeSysV(user: PoolUser, run: RunAsUser, sysvDir = '/proc/sysvipc'): Promise<void> {
  const stuck: string[] = []
  for (const [kind, idColumn, flag] of SYSV_KINDS) {
    const its = (await readSysV(sysvDir, kind, idColumn))?.filter((r) => r.uid === user.uid || r.cuid === user.uid) ?? []
    if (its.length === 0) continue
    for (let i = 0; i < its.length; i += SYSV_BATCH) {
      await run(user, 'ipcrm', its.slice(i, i + SYSV_BATCH).flatMap((r) => [flag, String(r.id)]))
    }
    const left = (await readSysV(sysvDir, kind, idColumn))?.filter((r) => r.cuid === user.uid) ?? []
    if (left.length > 0) stuck.push(`${left.length} SysV ${kind} (ids ${left.slice(0, 5).map((r) => r.id).join(', ')})`)
  }
  // Every kind is tried before this, so a uid that fails here leaves as little behind as it can.
  if (stuck.length > 0) throw new Error(`uid ${user.uid} created ${stuck.join(' and ')} still there after the wipe`)
}

function runCommand(cmd: string, args: string[], ids: { uid?: number; gid?: number }): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...ids, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout }))
  })
}

/** The real `RunAsUser`: the command as the user, empty environment, stdout collected, stderr dropped. */
export const runAsUser: RunAsUser = (user, cmd, args) => runCommand(cmd, args, { uid: user.uid, gid: user.gid })

/** The real `RunAsRoot`: the same, as the runner itself (root in the image). */
export const runAsRoot: RunAsRoot = (cmd, args) => runCommand(cmd, args, {})

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
