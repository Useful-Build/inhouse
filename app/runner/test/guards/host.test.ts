// The OS side of the pool, on a temp folder (no root here: ownership changes are recorded, not made). Ways it could
// fail, written first:
// - the session folder isn't 1770 to the session's group, or `.claude/` and `.mcp.json` aren't root's with the stubs;
// - a symlink the session left is followed (a chown or a recursion through it reaches outside the folder);
// - a symlink or file squatting on `inputs`, `outputs`, `.home` or `.claude` survives the take-over;
// - a file someone other than a session user owns is handed to the session;
// - a parked folder stays open to the last session's group;
// - the wipe removes another user's files, follows a symlink, or misses the user's files deeper down;
// - killAll returns while a process of the uid is still alive (zombies aside), or loops forever on one that won't die;
// - the /proc parser misses the saved or filesystem uid, or calls a dead process alive.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KillError, STUB_DIRS, STUB_FILES, createSessionHost, parseStatus, wipeOwned, type ProcEntry } from '../../src/guards/host.ts'
import type { PoolUser } from '../../src/guards/users.ts'

const me = process.getuid!()
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
  mkdirSync(root, { mode: 0o755 })
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
    for (const d of ['inputs', 'outputs', '.home']) {
      expect(mode(join(workDir, d))).toBe(0o700)
      expect(lastOwner(join(workDir, d))).toEqual([user.uid, user.gid])
    }
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

describe('wipeOwned', () => {
  it("removes the user's files at any depth and nothing else, without following symlinks", async () => {
    const tmp = join(dir, 'tmp')
    const outside = join(dir, 'outside')
    mkdirSync(join(tmp, 'a', 'b'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'x')
    writeFileSync(join(tmp, 'a', 'b', 'f'), 'x')
    symlinkSync(outside, join(tmp, 'link'))
    // Not the uid we wipe: everything stays.
    await wipeOwned(tmp, me + 1)
    expect(existsSync(join(tmp, 'a', 'b', 'f'))).toBe(true)
    await wipeOwned(tmp, me)
    expect(readdirSync(tmp)).toEqual([])
    expect(readdirSync(outside)).toEqual(['keep'])
    await expect(wipeOwned(join(dir, 'missing'), me)).resolves.toBeUndefined()
  })
})

describe('killAll', () => {
  function table(procs: (ProcEntry & { immortal?: boolean })[]) {
    const live = new Map(procs.map((p) => [p.pid, p]))
    let clock = 0
    return {
      live,
      deps: {
        workRoot: root,
        poolUids: new Set<number>(),
        listProcs: async () => [...live.values()],
        killPid: (pid: number) => {
          const p = live.get(pid)
          if (!p) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
          if (!p.immortal) live.delete(pid)
        },
        // kill(-1) as the user: everything of its uid that can die, dies.
        killAsUser: async (u: PoolUser) => {
          for (const [pid, p] of live) if (p.uids.includes(u.uid) && !p.immortal && !p.zombie) live.delete(pid)
        },
        pause: async (ms: number) => void (clock += ms),
        now: () => clock,
        killDeadlineMs: 100,
      },
    }
  }

  it('returns only once no process of the uid is left; zombies and other uids are ignored', async () => {
    const t = table([
      { pid: 10, uids: [30001, 30001, 30001, 30001], zombie: false },
      { pid: 11, uids: [0, 0, 30001, 0], zombie: false },
      { pid: 12, uids: [30001, 30001, 30001, 30001], zombie: true },
      { pid: 13, uids: [30002, 30002, 30002, 30002], zombie: false },
    ])
    await createSessionHost(t.deps).killAll(user)
    expect([...t.live.keys()].sort()).toEqual([12, 13])
  })

  it('kills by pid when kill(-1) as the user fails', async () => {
    const t = table([{ pid: 10, uids: [30001, 30001, 30001, 30001], zombie: false }])
    await createSessionHost({ ...t.deps, killAsUser: async () => Promise.reject(new Error('EAGAIN')) }).killAll(user)
    expect(t.live.size).toBe(0)
  })

  it('throws, after the deadline, on a process that will not die', async () => {
    const t = table([{ pid: 10, uids: [30001, 30001, 30001, 30001], zombie: false, immortal: true }])
    await expect(createSessionHost(t.deps).killAll(user)).rejects.toThrow(KillError)
  })
})

describe('parseStatus', () => {
  const status = (state: string, uid: string) => `Name:\tbash\nState:\t${state}\nTgid:\t7\nPid:\t7\nUid:\t${uid}\nGid:\t30001\t30001\t30001\t30001\n`
  it('reads all four uids and the zombie state', () => {
    expect(parseStatus(7, status('S (sleeping)', '0\t0\t30001\t0'))).toEqual({ pid: 7, uids: [0, 0, 30001, 0], zombie: false })
    expect(parseStatus(7, status('Z (zombie)', '30001\t30001\t30001\t30001'))?.zombie).toBe(true)
    expect(parseStatus(7, 'garbage')).toBeNull()
  })
})
