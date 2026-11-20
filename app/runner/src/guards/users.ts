// One OS user per live session, from a fixed pool made in the image at build time (s00..s63; see the Dockerfile), so
// nothing writes /etc/passwd at run time.
//
// The rules this keeps:
// - a uid serves one live session at a time: `allocate` takes it off the free list before its first await, and only
//   `release` puts it back, after every process of the uid is gone and its session folder is parked;
// - before a uid serves a session, any process or file it left outside the work tree is gone and the session's
//   folders are remade for it;
// - pool exhausted: a typed refusal, never a shared uid;
// - a uid whose cleanup failed is quarantined (never handed out again in this container's life), logged, counted in
//   `state()`, and the failure is thrown;
// - the session folder is parked whatever the kill did: a uid whose processes survived never keeps its folder open;
// - a folder whose session's processes survived the kill is parked for good: a survivor may still hold it open, and
//   root's take-over walks a folder by path, so root never prepares that folder again in this container's life.
import type { SessionUser, SessionUsers } from '../session/seam.ts'
import { assertSessionKey } from './paths.ts'

/** A pool member, as /etc/passwd has it. */
export type PoolUser = { user: string; uid: number; gid: number }

/** The OS side, so the pool's rules can be tested without root. `src/guards/host.ts` is the real one. */
export interface SessionHost {
  /** Kills every process of the uid; resolves only once none is left. Throws if it can't make sure. */
  killAll(user: PoolUser): Promise<void>
  /** Empties the uid's own home and temp folder, and removes whatever it owns in the shared writable places (/tmp and the like). */
  wipeUserFiles(user: PoolUser): Promise<void>
  /** Makes (or takes over) the session's folder for this user, and the user's own home and temp folder; returns the paths. */
  prepareFolder(sessionKey: string, user: PoolUser): Promise<{ workDir: string; home: string }>
  /** Hands the session's folder back to root, closed to every session user. */
  parkFolder(sessionKey: string): Promise<void>
}

export class SessionPoolExhaustedError extends Error {
  readonly code = 'session_pool_exhausted'
}
export class SessionReleaseError extends Error {}
/** The chat's folder is parked for good (see the rules above): it can't run again in this container. */
export class SessionFolderParkedError extends Error {
  readonly code = 'session_folder_parked'
}

/** The pool's names: s00 to s63. */
export const POOL_SIZE = 64
export const poolUserName = (i: number) => `s${String(i).padStart(2, '0')}`

/**
 * Reads the pool from /etc/passwd's text. Every member must exist, with its own uid and gid (never root, never shared)
 * and no login shell. Throws otherwise: a runner with a broken pool doesn't start.
 */
export function readPool(passwd: string, size = POOL_SIZE): PoolUser[] {
  const byName = new Map<string, string[]>()
  for (const line of passwd.split('\n')) {
    const f = line.split(':')
    if (f.length === 7) byName.set(f[0]!, f)
  }
  const pool: PoolUser[] = []
  for (let i = 0; i < size; i++) {
    const name = poolUserName(i)
    const f = byName.get(name)
    if (!f) throw new Error(`pool user ${name} is missing from the image`)
    const uid = Number(f[2])
    const gid = Number(f[3])
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 1000 || gid < 1000) throw new Error(`pool user ${name} has a system uid or gid`)
    if (!/\/(nologin|false)$/.test(f[6]!)) throw new Error(`pool user ${name} has a login shell`)
    pool.push({ user: name, uid, gid })
  }
  const uids = new Set(pool.map((u) => u.uid))
  const gids = new Set(pool.map((u) => u.gid))
  if (uids.size !== pool.length || gids.size !== pool.length) throw new Error('pool users share a uid or gid')
  for (const [name, f] of byName) {
    if (!pool.some((u) => u.user === name) && (uids.has(Number(f[2])) || gids.has(Number(f[3])))) {
      throw new Error(`${name} shares a uid or gid with the pool`)
    }
  }
  return pool
}

type Live = {
  user: PoolUser
  ready: Promise<SessionUser>
  releasing: Promise<void> | null
}

export type SessionPool = SessionUsers & {
  /** For tests and health: who's where. */
  readonly state: () => { free: number[]; live: Map<string, number>; quarantined: number[]; parkedForGood: string[] }
}

export type PoolLog = (entry: Record<string, unknown>) => void

/** The root's log format (one JSON line on stdout, as src/main.ts writes). */
const stdoutLog: PoolLog = (entry) => console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }))

export function createSessionPool(pool: readonly PoolUser[], host: SessionHost, log: PoolLog = stdoutLog): SessionPool {
  const free: PoolUser[] = [...pool]
  const live = new Map<string, Live>()
  const quarantined = new Set<number>()
  /** Session keys whose folder is parked for good. At most one per quarantined uid, so never more than the pool. */
  const parkedForGood = new Set<string>()

  /**
   * Takes the uid back after a failed allocate or a release: free only once its processes are gone and the folder is
   * parked. `drop` takes the session off the live map in the same tick as the uid goes back on the free list, so the
   * uid is never in both. `ran` says the uid had the folder (a release): only then can a process that survives the
   * kill have it open, and the folder is parked for good.
   */
  const reclaim = async (sessionKey: string, user: PoolUser, ran: boolean, drop: () => void) => {
    try {
      try {
        await host.killAll(user)
      } catch (e) {
        if (ran) parkedForGood.add(sessionKey)
        throw e
      } finally {
        await host.parkFolder(sessionKey)
      }
      await host.wipeUserFiles(user)
    } catch (e) {
      drop()
      quarantined.add(user.uid)
      log({
        type: 'session_user_quarantined',
        uid: user.uid,
        user: user.user,
        sessionKey,
        error: String(e instanceof Error ? e.message : e),
        quarantined: quarantined.size,
        folderParkedForGood: parkedForGood.has(sessionKey),
      })
      throw e
    }
    drop()
    free.push(user)
  }

  async function allocate(sessionKey: string): Promise<SessionUser> {
    assertSessionKey(sessionKey)
    for (;;) {
      const existing = live.get(sessionKey)
      if (existing === undefined) break
      // A release in flight for this key: wait for it, then start fresh. Otherwise the same key gets the same user.
      if (existing.releasing === null) return existing.ready
      await existing.releasing.catch(() => {})
    }
    // Synchronous from here to the map entry: no other call can take this uid.
    if (parkedForGood.has(sessionKey)) throw new SessionFolderParkedError(`the folder of session ${sessionKey} is parked for good: a process of its last user survived the kill`)
    const user = free.shift()
    if (user === undefined) throw new SessionPoolExhaustedError(`all ${pool.length} session users are busy`)
    const entry: Live = { user, ready: null as unknown as Promise<SessionUser>, releasing: null }
    entry.ready = (async () => {
      try {
        await host.killAll(user)
        await host.wipeUserFiles(user)
        const { workDir, home } = await host.prepareFolder(sessionKey, user)
        return { uid: user.uid, gid: user.gid, user: user.user, home, workDir }
      } catch (e) {
        // Stays on the live map, as releasing, until the uid is reclaimed: a retry for this key waits rather than
        // preparing the same folder while it's being parked.
        const reclaimed = reclaim(sessionKey, user, false, () => {
          if (live.get(sessionKey) === entry) live.delete(sessionKey)
        }).catch(() => {})
        entry.releasing ??= reclaimed
        await reclaimed
        throw e
      }
    })()
    live.set(sessionKey, entry)
    return entry.ready
  }

  async function release(sessionKey: string, user: SessionUser): Promise<void> {
    assertSessionKey(sessionKey)
    const entry = live.get(sessionKey)
    if (entry === undefined || entry.user.uid !== user.uid) throw new SessionReleaseError(`no live session ${sessionKey} as uid ${user.uid}`)
    if (entry.releasing === null) {
      entry.releasing = (async () => {
        try {
          await entry.ready
        } catch {
          // Its allocate failed, and `ready` rejects only once the uid has been reclaimed (or quarantined).
          return
        }
        await reclaim(sessionKey, entry.user, true, () => {
          if (live.get(sessionKey) === entry) live.delete(sessionKey)
        })
      })()
    }
    return entry.releasing
  }

  return {
    kind: 'production',
    quarantined: () => quarantined.size,
    allocate,
    release,
    state: () => ({
      free: free.map((u) => u.uid),
      live: new Map([...live].map(([k, v]) => [k, v.user.uid])),
      quarantined: [...quarantined],
      parkedForGood: [...parkedForGood],
    }),
  }
}
