// The session user pool. Ways it could fail, written first:
// - under some interleaving of allocate and release, one uid serves two live sessions, or sits on the free list while
//   a session still has it;
// - a uid goes back to the free list before its processes are gone and its folder is parked, or after a failed cleanup;
// - a uid gets lost (in no list) after a failure, so the pool shrinks without a trace;
// - allocate prepares a folder before the uid's leftovers are killed and wiped;
// - an exhausted pool shares a uid instead of refusing; the refusal isn't typed;
// - the same key gets two users, or a key mid-release gets the user being torn down;
// - release of a session that isn't live (or with the wrong uid) succeeds quietly;
// - a failed kill leaves the folder open to the uid's group (it isn't parked), or a quarantine goes unlogged or
//   uncounted (the root's /health reads `quarantined()`);
// - a folder whose last user's processes survived the kill is walked by root again (a survivor still has it open and
//   can swap a folder for a symlink under root's path walk), or a kill that failed before any session ran closes a chat;
// - the pool reader accepts a missing member, a root or system uid, a login shell, or a shared uid or gid.
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { InvalidSessionKeyError } from '../../src/guards/paths.ts'
import { SessionFolderParkedError, SessionPoolExhaustedError, SessionReleaseError, createSessionPool, poolUserName, readPool, type PoolUser, type SessionHost } from '../../src/guards/users.ts'
import type { SessionUser } from '../../src/session/seam.ts'

const pool = (n: number): PoolUser[] => Array.from({ length: n }, (_, i) => ({ user: poolUserName(i), uid: 30000 + i, gid: 30000 + i }))

type Op = { op: keyof SessionHost; key?: string; uid?: number }

/** A host whose every step is a scheduled point (so fast-check picks the interleaving) and may fail. */
function scheduledHost(s: fc.Scheduler, fail: (op: Op) => boolean) {
  const log: Op[] = []
  const step = <T>(op: Op, value: T) =>
    s.schedule(Promise.resolve(), `${op.op} ${op.key ?? op.uid}`).then(() => {
      log.push(op)
      if (fail(op)) throw new Error(`${op.op} failed`)
      return value
    })
  const host: SessionHost = {
    killAll: (u) => step({ op: 'killAll', uid: u.uid }, undefined),
    wipeUserFiles: (u) => step({ op: 'wipeUserFiles', uid: u.uid }, undefined),
    prepareFolder: (key, u) => step({ op: 'prepareFolder', key, uid: u.uid }, { workDir: `/work/${key}`, home: `/work/${key}/.home` }),
    parkFolder: (key) => step({ op: 'parkFolder', key }, undefined),
  }
  return { host, log }
}

function checkInvariants(p: ReturnType<typeof createSessionPool>, all: number[]) {
  const { free, live, quarantined } = p.state()
  const liveUids = [...live.values()]
  // One uid, one place: never two live sessions, never live and free, never free and quarantined, never lost.
  expect(new Set(liveUids).size).toBe(liveUids.length)
  expect(new Set(free).size).toBe(free.length)
  const places = [...free, ...liveUids, ...quarantined].sort()
  expect(places).toEqual([...all].sort())
}

const keys = fc.constantFrom('a', 'b', 'c', 'd')
const action = fc.oneof(fc.record({ t: fc.constant('allocate' as const), key: keys }), fc.record({ t: fc.constant('release' as const), key: keys }))

/** Runs the scheduler until every action has settled, checking the invariants after each scheduled step. */
async function drive(s: fc.Scheduler, p: ReturnType<typeof createSessionPool>, all: number[], pending: Promise<unknown>[]) {
  let finished = false
  const done = Promise.all(pending).then(() => (finished = true))
  while (!finished) {
    if (s.count() > 0) {
      await s.waitOne()
      checkInvariants(p, all)
    } else {
      // Let the microtasks queue the next scheduled step (a yield, not a wait for time).
      await new Promise((r) => setImmediate(r))
    }
  }
  await done
  checkInvariants(p, all)
}

/** Each action starts at a point the scheduler picks; a release acts on the key's latest user, if it has one. */
function play(s: fc.Scheduler, p: ReturnType<typeof createSessionPool>, actions: { t: 'allocate' | 'release'; key: string }[]) {
  const held = new Map<string, SessionUser>()
  return actions.map((a) =>
    s.schedule(Promise.resolve(), `${a.t} ${a.key}`).then(async () => {
      if (a.t === 'allocate') {
        const u = await p.allocate(a.key).catch((e: unknown) => e)
        if (u instanceof Error) expect(u.message).toBeTruthy()
        else held.set(a.key, u as SessionUser)
      } else {
        const u = held.get(a.key)
        if (u) await p.release(a.key, u).catch(() => {})
      }
    }),
  )
}

describe('the session pool', () => {
  it.prop([fc.scheduler(), fc.array(action, { minLength: 1, maxLength: 12 }), fc.integer({ min: 1, max: 3 })])(
    'under any interleaving, a uid serves at most one live session and is never lost',
    async (s, actions, size) => {
      const users = pool(size)
      const { host, log } = scheduledHost(s, () => false)
      const p = createSessionPool(users, host)
      await drive(s, p, users.map((u) => u.uid), play(s, p, actions))
      // Every folder prepare came after that uid's kill and wipe in the same allocate.
      for (const [i, op] of log.entries()) {
        if (op.op !== 'prepareFolder') continue
        const before = log.slice(0, i).map((o) => `${o.op}:${o.uid}`)
        expect(before).toContain(`killAll:${op.uid}`)
        expect(before).toContain(`wipeUserFiles:${op.uid}`)
      }
      expect(p.state().quarantined).toEqual([])
    },
  )

  it.prop([fc.scheduler(), fc.array(fc.constantFrom('killAll', 'wipeUserFiles', 'prepareFolder', 'parkFolder'), { maxLength: 3 }), fc.array(action, { minLength: 1, maxLength: 10 })])(
    'with failing cleanups: a uid whose cleanup failed is quarantined, never freed, and never lost',
    async (s, failing, actions) => {
      const users = pool(2)
      const left = [...failing]
      const { host } = scheduledHost(s, (op) => {
        const i = left.indexOf(op.op)
        if (i === -1) return false
        left.splice(i, 1)
        return true
      })
      const p: ReturnType<typeof createSessionPool> = createSessionPool(users, {
        ...host,
        // A folder parked for good is never prepared (walked) again.
        prepareFolder: (key, u) => {
          expect(p.state().parkedForGood).not.toContain(key)
          return host.prepareFolder(key, u)
        },
      })
      await drive(s, p, users.map((u) => u.uid), play(s, p, actions))
      for (const key of p.state().parkedForGood) await expect(p.allocate(key)).rejects.toThrow(SessionFolderParkedError)
      expect(p.quarantined()).toBe(p.state().quarantined.length)
    },
  )

  it('release reports completion and frees the uid only after the kill, park and wipe', async () => {
    const order: string[] = []
    const logged: Record<string, unknown>[] = []
    const wiping = Promise.withResolvers<void>()
    const finishWipe = Promise.withResolvers<void>()
    let allocated = false
    const host: SessionHost = {
      killAll: async () => void order.push('kill'),
      wipeUserFiles: async () => {
        order.push('wipe')
        if (allocated) {
          wiping.resolve()
          await finishWipe.promise
        }
      },
      prepareFolder: async (k) => (order.push('prepare'), { workDir: `/work/${k}`, home: `/work/${k}/.home` }),
      parkFolder: async () => void order.push('park'),
    }
    const p = createSessionPool(pool(1), host, (e) => (order.push('logged'), void logged.push(e)))
    const u = await p.allocate('a')
    expect(u).toEqual({ uid: 30000, gid: 30000, user: 's00', home: '/work/a/.home', workDir: '/work/a' })
    expect(order).toEqual(['kill', 'wipe', 'prepare'])
    allocated = true
    order.length = 0
    const released = p.release('a', u).then(() => order.push('resolved'))
    await wiping.promise
    expect(p.state().free).toEqual([])
    expect(logged).toEqual([])
    finishWipe.resolve()
    await released
    expect(order).toEqual(['kill', 'park', 'wipe', 'logged', 'resolved'])
    expect(logged).toEqual([{ type: 'session_user_released', uid: 30000, sessionKey: 'a' }])
    expect(p.state().free).toEqual([30000])
  })

  it('a failed kill still parks the folder, and the quarantine is logged and counted', async () => {
    const order: string[] = []
    const logged: Record<string, unknown>[] = []
    let failKill = false
    const host: SessionHost = {
      killAll: async () => {
        order.push('kill')
        if (failKill) throw new Error('survived')
      },
      wipeUserFiles: async () => void order.push('wipe'),
      prepareFolder: async (k) => ({ workDir: `/work/${k}`, home: `/work/${k}/.home` }),
      parkFolder: async () => void order.push('park'),
    }
    const p = createSessionPool(pool(1), host, (e) => void logged.push(e))
    const u = await p.allocate('a')
    order.length = 0
    failKill = true
    expect(p.quarantined()).toBe(0)
    await expect(p.release('a', u)).rejects.toThrow(/survived/)
    expect(order).toEqual(['kill', 'park'])
    expect(p.state().quarantined).toEqual([30000])
    expect(p.quarantined()).toBe(1)
    expect(logged).toEqual([expect.objectContaining({ type: 'session_user_quarantined', uid: 30000, error: expect.stringMatching(/survived/), folderParkedForGood: true })])
  })

  it("a folder whose last user's processes survived the kill is parked for good: root never walks it again", async () => {
    const prepared: string[] = []
    let failKill = false
    const host: SessionHost = {
      killAll: async () => {
        if (failKill) throw new Error('survived')
      },
      wipeUserFiles: async () => {},
      prepareFolder: async (k) => (prepared.push(k), { workDir: `/work/${k}`, home: `/work/${k}/.home` }),
      parkFolder: async () => {},
    }
    const p = createSessionPool(pool(3), host, () => {})
    const u = await p.allocate('a')
    failKill = true
    await expect(p.release('a', u)).rejects.toThrow(/survived/)
    failKill = false
    const refused = await p.allocate('a').catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(SessionFolderParkedError)
    expect((refused as SessionFolderParkedError).code).toBe('session_folder_parked')
    expect(prepared).toEqual(['a'])
    expect(p.state().parkedForGood).toEqual(['a'])
    // The refusal took no uid, and other chats go on.
    expect(p.state().free).toHaveLength(2)
    await expect(p.allocate('b')).resolves.toMatchObject({ workDir: '/work/b' })
  })

  it('a failed wipe, or a kill that fails before any session ran in the folder, leaves the chat open to its next run', async () => {
    let failKill = false
    let failWipe = false
    const host: SessionHost = {
      killAll: async () => {
        if (failKill) throw new Error('survived')
      },
      wipeUserFiles: async () => {
        if (failWipe) throw new Error('left a file')
      },
      prepareFolder: async (k) => ({ workDir: `/work/${k}`, home: `/work/${k}/.home` }),
      parkFolder: async () => {},
    }
    const logged: Record<string, unknown>[] = []
    const p = createSessionPool(pool(3), host, (e) => void logged.push(e))
    // The kill fails in allocate: this uid never ran in the folder, so nothing of it has the folder open.
    failKill = true
    await expect(p.allocate('a')).rejects.toThrow(/survived/)
    failKill = false
    const u = await p.allocate('a')
    // Every process is dead, a file is left: the uid is quarantined, the folder is safe to hand to another.
    failWipe = true
    await expect(p.release('a', u)).rejects.toThrow(/left a file/)
    expect(logged.filter((e) => e.uid === u.uid)).toEqual([expect.objectContaining({ type: 'session_user_quarantined', sessionKey: 'a', error: 'left a file' })])
    failWipe = false
    expect(p.state().parkedForGood).toEqual([])
    expect(p.quarantined()).toBe(2)
    await expect(p.allocate('a')).resolves.toMatchObject({ uid: 30002 })
  })

  it('the same key gets the same user; an exhausted pool refuses with a typed error', async () => {
    const host: SessionHost = { killAll: async () => {}, wipeUserFiles: async () => {}, prepareFolder: async (k) => ({ workDir: `/work/${k}`, home: `/work/${k}/.home` }), parkFolder: async () => {} }
    const p = createSessionPool(pool(1), host)
    const [a1, a2] = await Promise.all([p.allocate('a'), p.allocate('a')])
    expect(a1.uid).toBe(a2.uid)
    const refused = await p.allocate('b').catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(SessionPoolExhaustedError)
    expect((refused as SessionPoolExhaustedError).code).toBe('session_pool_exhausted')
    await expect(p.release('b', a1)).rejects.toThrow(SessionReleaseError)
    await expect(p.release('a', { ...a1, uid: 1 })).rejects.toThrow(SessionReleaseError)
    await expect(p.allocate('../x')).rejects.toThrow(InvalidSessionKeyError)
  })

  it('a key allocated mid-release waits and gets a freshly prepared user, not the one being torn down', async () => {
    let openKill!: () => void
    const kills: Promise<void>[] = []
    const prepared: number[] = []
    const host: SessionHost = {
      killAll: () => {
        const p = new Promise<void>((r) => (openKill = r))
        kills.push(p)
        return kills.length === 1 ? Promise.resolve() : p
      },
      wipeUserFiles: async () => {},
      prepareFolder: async (k, u) => (prepared.push(u.uid), { workDir: `/work/${k}`, home: `/work/${k}/.home` }),
      parkFolder: async () => {},
    }
    const p = createSessionPool(pool(1), host)
    const u = await p.allocate('a')
    const releasing = p.release('a', u)
    const again = p.allocate('a')
    await Promise.resolve()
    expect(prepared).toEqual([30000])
    openKill()
    await releasing
    // The second allocate's own kill check.
    await new Promise((r) => setImmediate(r))
    openKill()
    await again
    expect(prepared).toEqual([30000, 30000])
    expect(p.state().live.get('a')).toBe(30000)
  })
})

describe('readPool', () => {
  const line = (name: string, uid: number, gid = uid, shell = '/usr/sbin/nologin') => `${name}:x:${uid}:${gid}::/nonexistent:${shell}`
  const passwd = (n: number, edit: (lines: string[]) => string[] = (l) => l) =>
    ['root:x:0:0:root:/root:/bin/bash', ...edit(Array.from({ length: n }, (_, i) => line(poolUserName(i), 30000 + i)))].join('\n')

  it('reads a well-formed pool', () => {
    expect(readPool(passwd(3), 3)).toEqual(pool(3))
  })

  it('refuses a missing member, a system uid, a login shell and a shared uid or gid', () => {
    expect(() => readPool(passwd(2), 3)).toThrow(/s02 is missing/)
    expect(() => readPool(passwd(2, (l) => [l[0]!, line('s01', 0)]), 2)).toThrow(/system uid/)
    expect(() => readPool(passwd(2, (l) => [l[0]!, line('s01', 30001, 30001, '/bin/bash')]), 2)).toThrow(/login shell/)
    expect(() => readPool(passwd(2, (l) => [l[0]!, line('s01', 30000)]), 2)).toThrow(/share/)
    expect(() => readPool(passwd(2, (l) => [l[0]!, line('s01', 30001, 30000)]), 2)).toThrow(/share/)
    expect(() => readPool(passwd(2) + '\n' + line('other', 30001, 5000), 2)).toThrow(/other shares/)
  })
})
