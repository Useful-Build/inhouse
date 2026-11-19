// The OS side of the pool, on a temp folder (no root here: ownership changes are recorded, not made). Ways it could
// fail, written first:
// - the session folder isn't 1770 to the session's group, or `.claude/` and `.mcp.json` aren't root's with the stubs;
// - a symlink the session left is followed (a chown or a recursion through it reaches outside the folder);
// - a symlink or file squatting on `inputs`, `outputs`, `.home` or `.claude` survives the take-over;
// - a file someone other than a session user owns is handed to the session;
// - a parked folder stays open to the last session's group;
// - the wipe removes another user's files, follows a symlink, or misses the user's files deeper down;
// - killAll returns while a process of the uid is still alive (zombies aside), or loops forever on one that won't die;
// - killAll skips its kill(-1) because the first listing looked empty, or calls a zombie leader whose other threads
//   still run dead (a main thread that called pthread_exit);
// - the /proc parser misses the saved or filesystem uid or the thread count, or calls a dead process alive;
// - the wipe runs as root by path (a swapped symlink steers root's delete), misses /dev/mqueue, or leaves the uid's
//   SysV objects;
// - a hard-linked file is handed to the next user (it could be another uid's file);
// - inputs/ or outputs/ are the session's to rename (and swap for a symlink);
// - the work root lists the chat ids to sessions; a folder left from before a restart stays open.
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KillError,
  SHARED_WRITABLE,
  STUB_DIRS,
  STUB_FILES,
  createSessionHost,
  parkAllFolders,
  parseStatus,
  runAsUser,
  wipeOwned,
  type ProcEntry,
  type RunAsUser,
} from '../../src/guards/host.ts'
import type { PoolUser } from '../../src/guards/users.ts'

const me = process.getuid!()
const myGid = process.getgid!()
const user: PoolUser = { user: 's01', uid: 30001, gid: 30001 }
let dir: string
let root: string
let chowns: [string, number, number][]

const host = (poolUids: number[] = [me]) =>
  createSessionHost({
    workRoot: root,
    poolUids: new Set(poolUids),
    rootUid: me,
    chown: async (p, u, g) => void chowns.push([p, u, g]),
    lchown: async (p, u, g) => void chowns.push([p, u, g]),
  })
const mode = (p: string) => lstatSync(p).mode & 0o7777
const lastOwner = (p: string) => chowns.filter(([q]) => q === p).at(-1)?.slice(1)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guards-host-'))
  root = join(dir, 'work')
  mkdirSync(root)
  chmodSync(root, 0o711)
  chowns = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('session folders', () => {
  it('makes the stubs layout for the session user', async () => {
    const { workDir, home } = await host().prepareFolder('chat1', user)
    expect(workDir).toBe(join(root, 'chat1'))
    expect(home).toBe(join(workDir, '.home'))
    expect(mode(workDir)).toBe(0o1770)
    expect(lastOwner(workDir)).toEqual([0, user.gid])
    expect(mode(join(workDir, '.claude'))).toBe(0o755)
    expect(lastOwner(join(workDir, '.claude'))).toEqual([0, 0])
    for (const d of STUB_DIRS) expect(lstatSync(join(workDir, '.claude', d)).isDirectory()).toBe(true)
    for (const [f, text] of Object.entries(STUB_FILES)) {
      expect(readFileSync(join(workDir, '.claude', f), 'utf8')).toBe(text)
      expect(lastOwner(join(workDir, '.claude', f))).toEqual([0, 0])
    }
    expect(readFileSync(join(workDir, '.mcp.json'), 'utf8')).toBe('{}')
    expect(lastOwner(join(workDir, '.mcp.json'))).toEqual([0, 0])
    // inputs/ and outputs/ are root's, open to the session's group: the session can't rename them (sticky parent).
    for (const d of ['inputs', 'outputs']) {
      expect(mode(join(workDir, d))).toBe(0o1770)
      expect(lastOwner(join(workDir, d))).toEqual([0, user.gid])
    }
    for (const d of ['.home', '.tmp']) {
      expect(mode(join(workDir, d))).toBe(0o700)
      expect(lastOwner(join(workDir, d))).toEqual([user.uid, user.gid])
    }
  })

  it('never hands over a hard-linked file', async () => {
    const h = host()
    const { workDir } = await h.prepareFolder('chat1', user)
    writeFileSync(join(workDir, 'outputs', 'a'), 'x')
    linkSync(join(workDir, 'outputs', 'a'), join(workDir, 'outputs', 'b'))
    writeFileSync(join(workDir, 'outputs', 'c'), 'x')
    chowns = []
    await h.prepareFolder('chat1', { user: 's02', uid: 30002, gid: 30002 })
    expect(lastOwner(join(workDir, 'outputs', 'a'))).toBeUndefined()
    expect(lastOwner(join(workDir, 'outputs', 'b'))).toBeUndefined()
    expect(lastOwner(join(workDir, 'outputs', 'c'))).toEqual([30002, 30002])
  })

  it('refuses a work root that lists its folders to sessions', async () => {
    chmodSync(root, 0o755)
    await expect(host().prepareFolder('chat1', user)).rejects.toThrow(/0711/)
  })

  it('hands what the last session made to the new user, without following symlinks', async () => {
    const h = host()
    const { workDir } = await h.prepareFolder('chat1', user)
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret'), 'x')
    writeFileSync(join(workDir, 'outputs', 'report.pdf'), 'x')
    symlinkSync(outside, join(workDir, 'outputs', 'link'))
    symlinkSync(outside, join(workDir, 'loose-link'))
    chowns = []
    const next: PoolUser = { user: 's02', uid: 30002, gid: 30002 }
    await h.prepareFolder('chat1', next)
    expect(lastOwner(join(workDir, 'outputs', 'report.pdf'))).toEqual([next.uid, next.gid])
    // The links themselves change hands; nothing behind them is touched.
    expect(lastOwner(join(workDir, 'outputs', 'link'))).toEqual([next.uid, next.gid])
    expect(chowns.some(([p]) => p.startsWith(outside))).toBe(false)
    expect(lastOwner(join(workDir, '.claude'))).toEqual([0, 0])
  })

  it('leaves a file no session user owns as it is', async () => {
    const { workDir } = await host().prepareFolder('chat1', user)
    writeFileSync(join(workDir, 'outputs', 'roots'), 'x')
    chowns = []
    // `me` is not in the pool here, so every file looks like someone else's.
    await host([30001]).prepareFolder('chat1', user)
    expect(lastOwner(join(workDir, 'outputs', 'roots'))).toBeUndefined()
  })

  it('replaces whatever squats on the names root and the session rely on', async () => {
    const workDir = join(root, 'chat1')
    mkdirSync(workDir, { mode: 0o700 })
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(workDir, 'outputs'))
    writeFileSync(join(workDir, 'inputs'), 'not a dir')
    symlinkSync(outside, join(workDir, '.claude'))
    symlinkSync(join(outside, 'x.json'), join(workDir, '.mcp.json'))
    await host().prepareFolder('chat1', user)
    for (const d of ['inputs', 'outputs', '.claude']) expect(lstatSync(join(workDir, d)).isDirectory(), d).toBe(true)
    expect(lstatSync(join(workDir, '.mcp.json')).isFile()).toBe(true)
    expect(readdirSync(outside)).toEqual([])
  })

  it('parks a folder closed to every session user, and parking a missing folder is fine', async () => {
    const h = host()
    const { workDir } = await h.prepareFolder('chat1', user)
    await h.parkFolder('chat1')
    expect(mode(workDir)).toBe(0o700)
    expect(lastOwner(workDir)).toEqual([0, 0])
    await expect(h.parkFolder('nothing-here')).resolves.toBeUndefined()
  })

  it('refuses an unsafe key and a work root that is a symlink', async () => {
    await expect(host().prepareFolder('../x', user)).rejects.toThrow()
    rmSync(root, { recursive: true })
    mkdirSync(join(dir, 'real'))
    symlinkSync(join(dir, 'real'), root)
    await expect(host().prepareFolder('chat1', user)).rejects.toThrow(/owned by root/)
  })
})

describe('the wipe', () => {
  const self: PoolUser = { user: 'me', uid: me, gid: myGid }

  it("removes the user's files at any depth and nothing else, without following symlinks (real find, as this uid)", async () => {
    const tmp = join(dir, 'tmp')
    const outside = join(dir, 'outside')
    mkdirSync(join(tmp, 'a', 'b'), { recursive: true })
    mkdirSync(join(tmp, 'locked'))
    writeFileSync(join(tmp, 'locked', 'f'), 'x')
    chmodSync(join(tmp, 'locked'), 0o000)
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'x')
    writeFileSync(join(tmp, 'a', 'b', 'f'), 'x')
    symlinkSync(outside, join(tmp, 'link'))
    // Not the uid we wipe: everything stays.
    await wipeOwned(tmp, { ...self, uid: me + 1 }, (_u, cmd, args) => runAsUser(self, cmd, args))
    expect(existsSync(join(tmp, 'a', 'b', 'f'))).toBe(true)
    await wipeOwned(tmp, self, runAsUser)
    expect(readdirSync(tmp)).toEqual([])
    expect(readdirSync(outside)).toEqual(['keep'])
    await expect(wipeOwned(join(dir, 'missing'), self, runAsUser)).resolves.toBeUndefined()
  })

  it('throws when something of the uid is still there after the delete', async () => {
    const stuck: RunAsUser = async (_u, _cmd, args) => ({ code: 0, stdout: args.includes('-quit') ? '/tmp/stuck\n' : '' })
    await expect(wipeOwned('/tmp', self, stuck)).rejects.toThrow(/stuck/)
  })

  it('runs every step as the uid itself, never as root by path', async () => {
    const calls: [PoolUser, string, string[]][] = []
    const sysv = join(dir, 'proc', 'sysvipc')
    mkdirSync(sysv, { recursive: true })
    const h = createSessionHost({
      workRoot: root,
      poolUids: new Set(),
      procDir: join(dir, 'proc'),
      runAsUser: async (u, cmd, args) => (calls.push([u, cmd, args]), { code: 0, stdout: '' }),
    })
    await h.wipeUserFiles(user)
    expect(calls.length).toBeGreaterThan(0)
    for (const [u] of calls) expect(u).toEqual(user)
    const finds = calls.filter(([, cmd]) => cmd === 'find')
    for (const d of SHARED_WRITABLE) {
      const mine = finds.filter(([, , a]) => a[0] === d)
      expect(mine.some(([, , a]) => a.includes('-delete')), d).toBe(true)
      for (const [, , a] of mine) expect(a).toEqual(expect.arrayContaining(['-xdev', '-user', String(user.uid)]))
    }
    expect(SHARED_WRITABLE).toContain('/dev/mqueue')
    expect(calls.some(([, cmd, a]) => cmd === 'ipcrm' && a.includes('--all'))).toBe(true)
  })

  it("throws when one of the uid's SysV objects survives", async () => {
    const sysv = join(dir, 'proc', 'sysvipc')
    mkdirSync(sysv, { recursive: true })
    writeFileSync(join(sysv, 'shm'), '       key      shmid perms       size  cpid  lpid nattch   uid   gid  cuid  cgid\n         0          7   600       4096    10    10      0 30001 30001 30001 30001\n')
    writeFileSync(join(sysv, 'sem'), '       key      semid perms      nsems   uid   gid  cuid  cgid\n         0          3   600          1 30002 30002 30002 30002\n')
    const h = createSessionHost({ workRoot: root, poolUids: new Set(), procDir: join(dir, 'proc'), runAsUser: async () => ({ code: 0, stdout: '' }) })
    await expect(h.wipeUserFiles(user)).rejects.toThrow(/SysV/)
    await expect(h.wipeUserFiles({ ...user, uid: 30003 })).resolves.toBeUndefined()
  })

  it('the real runner starts the command as the given uid', async () => {
    await expect(runAsUser(self, 'true', [])).resolves.toMatchObject({ code: 0 })
    // Not root here: switching to another uid is refused, which shows the uid is really set.
    await expect(runAsUser({ user: 'x', uid: me + 1, gid: myGid }, 'true', [])).rejects.toThrow(/EPERM/)
  })
})

describe('parking every folder at start', () => {
  it('parks every folder and closes the work root to listing', () => {
    mkdirSync(join(root, 'a'), { mode: 0o770 })
    mkdirSync(join(root, 'b'), { mode: 0o1770 })
    chmodSync(root, 0o755)
    parkAllFolders({ workRoot: root, rootUid: me, lchownSync: (p, u, g) => void chowns.push([p, u, g]) })
    for (const d of ['a', 'b']) {
      expect(mode(join(root, d))).toBe(0o700)
      expect(lastOwner(join(root, d))).toEqual([0, 0])
    }
    expect(mode(root)).toBe(0o711)
  })

  it('refuses to start on anything in the work root that is not a root folder', () => {
    symlinkSync(dir, join(root, 'link'))
    expect(() => parkAllFolders({ workRoot: root, rootUid: me, lchownSync: () => {} })).toThrow(/link/)
  })
})

describe('killAll', () => {
  function table(procs: (ProcEntry & { immortal?: boolean })[]) {
    const live = new Map(procs.map((p) => [p.pid, p]))
    let clock = 0
    let kills = 0
    return {
      live,
      kills: () => kills,
      deps: {
        workRoot: root,
        poolUids: new Set<number>(),
        listProcs: async () => [...live.values()],
        killPid: (pid: number) => {
          const p = live.get(pid)
          if (!p) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
          if (!p.immortal) live.delete(pid)
        },
        // kill(-1) as the user: everything of its uid that can die, dies (a zombie leader with live threads too).
        killAsUser: async (u: PoolUser) => {
          kills++
          for (const [pid, p] of live) if (p.uids.includes(u.uid) && !p.immortal && (!p.zombie || p.threads > 1)) live.delete(pid)
        },
        pause: async (ms: number) => void (clock += ms),
        now: () => clock,
        killDeadlineMs: 100,
      },
    }
  }

  it('returns only once no process of the uid is left; zombies and other uids are ignored', async () => {
    const t = table([
      { pid: 10, uids: [30001, 30001, 30001, 30001], zombie: false, threads: 1 },
      { pid: 11, uids: [0, 0, 30001, 0], zombie: false, threads: 1 },
      { pid: 12, uids: [30001, 30001, 30001, 30001], zombie: true, threads: 1 },
      { pid: 13, uids: [30002, 30002, 30002, 30002], zombie: false, threads: 1 },
    ])
    await createSessionHost(t.deps).killAll(user)
    expect([...t.live.keys()].sort()).toEqual([12, 13])
  })

  it('counts a zombie leader whose other threads still run as alive, and kills it', async () => {
    const t = table([{ pid: 10, uids: [30001, 30001, 30001, 30001], zombie: true, threads: 3 }])
    await createSessionHost(t.deps).killAll(user)
    expect(t.live.size).toBe(0)
  })

  it('sends kill(-1) as the user once even when the first listing shows nothing', async () => {
    const t = table([])
    await createSessionHost(t.deps).killAll(user)
    expect(t.kills()).toBe(1)
  })

  it('kills by pid when kill(-1) as the user fails', async () => {
    const t = table([{ pid: 10, uids: [30001, 30001, 30001, 30001], zombie: false, threads: 1 }])
    await createSessionHost({ ...t.deps, killAsUser: async () => Promise.reject(new Error('EAGAIN')) }).killAll(user)
    expect(t.live.size).toBe(0)
  })

  it('throws, after the deadline, on a process that will not die', async () => {
    const t = table([{ pid: 10, uids: [30001, 30001, 30001, 30001], zombie: false, threads: 1, immortal: true }])
    await expect(createSessionHost(t.deps).killAll(user)).rejects.toThrow(KillError)
  })
})

describe('parseStatus', () => {
  const status = (state: string, uid: string, threads = 1) =>
    `Name:\tbash\nState:\t${state}\nTgid:\t7\nPid:\t7\nUid:\t${uid}\nGid:\t30001\t30001\t30001\t30001\nThreads:\t${threads}\n`
  it('reads all four uids, the zombie state and the thread count', () => {
    expect(parseStatus(7, status('S (sleeping)', '0\t0\t30001\t0'))).toEqual({ pid: 7, uids: [0, 0, 30001, 0], zombie: false, threads: 1 })
    expect(parseStatus(7, status('Z (zombie)', '30001\t30001\t30001\t30001', 4))?.threads).toBe(4)
    expect(parseStatus(7, status('Z (zombie)', '30001\t30001\t30001\t30001'))?.zombie).toBe(true)
    expect(parseStatus(7, 'garbage')).toBeNull()
  })
})
