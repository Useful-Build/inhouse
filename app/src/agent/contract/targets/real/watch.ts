// P4's Watch parts of the real target (W6, p4-w6.md section 5), in the style of chat.ts and members.ts: which P4 methods the
// real client serves over HTTP, the route a forced failure of each lands on, where each P4 resource is read from, how the
// reset puts the routines back, and how a routine is changed behind the client. `index.ts` is the orchestrator's: the lines
// it needs are in the PR body (`SERVED`, `READ_PATH`, `routeOf`, `reset`, `writeElsewhere`).
//
// What the shared contract suite then covers on the real target: every value parsed through the shared schema (the suite's
// own `parse` calls), the optimistic rollback on a forced failure (`injectError`, `failSaves`), the stale-write cases and the
// write-sequence property. The `ifRev` revision sequences of each method, run against the real client, are in
// `watch.live.test.ts` beside this file (they need the test build, so they skip without CONTRACT_REAL_ORIGIN).
import type { ResourceKey } from '../../../types'
import type { Signer } from './me'

/** The P4 methods the real client serves over HTTP besides the Library five W5 already added to index.ts's SERVED. */
export const WATCH_SERVED = ['runRoutine', 'deleteRoutine', 'restoreRoutine', 'markNoticesRead', 'listNotifications', 'setAside'] as const

/** The paths the client reads each P4 resource from (`readRoutines`, `readActivityPage`, `readNotifications`, the Library list). */
export const WATCH_READ_PATH: Partial<Record<ResourceKey, string>> = {
  routines: '/api/routines',
  activity: '/api/activity',
  notifications: '/api/notifications',
  library: '/api/library',
}

const enc = (v: unknown): string => encodeURIComponent(String(v))

/**
 * The route a served P4 write sends to (its verbs and exact path), from the call's arguments; null for any other method. A
 * `setToggle` of an `r:<id>` key is a routine's switch (route 53); every other key is a setting (index.ts's own case).
 */
export function watchRoute(method: string, args: unknown[]): { verbs: string[]; path: string } | null {
  switch (method) {
    case 'runRoutine': return { verbs: ['POST'], path: `/api/routines/${enc(args[0])}/run` }
    case 'deleteRoutine': return { verbs: ['POST'], path: `/api/routines/${enc(args[0])}/delete` }
    case 'restoreRoutine': return { verbs: ['POST'], path: `/api/routines/${enc(args[0])}/restore` }
    case 'setToggle': {
      const key = String(args[0])
      return key.startsWith('r:') ? { verbs: ['PUT'], path: `/api/routines/${enc(key.slice(2))}/enabled` } : null
    }
    case 'markNoticesRead': return { verbs: ['POST'], path: '/api/notifications/read' }
    case 'uploadFiles': return { verbs: ['POST'], path: '/api/library/uploads' }
    case 'setAside': return { verbs: ['PUT'], path: `/api/today/${enc(args[0])}/aside` }
    default: return null
  }
}

interface RoutineListed { id: string; rev: number }
interface RoutinesAnswer { routines: RoutineListed[]; deleted: RoutineListed[]; enabled: Record<string, boolean> }

/**
 * Puts the routines back to how the seed left them, through the API as the seed's Admin: every deleted routine is restored
 * (against the rev the list shows) and every routine that was switched off is switched on. Each routine's delete, restore and
 * switch leave only revisions behind, which every case reads fresh. Fails loud on any refusal.
 */
export async function resetRoutines(s: Signer): Promise<void> {
  const need = (what: string, r: { status: number; json: unknown }) => {
    if (r.status >= 300) throw new Error(`The real contract target couldn't ${what}: ${r.status} ${JSON.stringify(r.json)}`)
    return r.json
  }
  const list = async () => need('read the routines', await s.api('admin', 'GET', WATCH_READ_PATH.routines!)) as RoutinesAnswer
  for (const r of (await list()).deleted) need(`restore routine ${r.id}`, await s.api('admin', 'POST', `/api/routines/${enc(r.id)}/restore`, { ifRev: r.rev }))
  const after = await list()
  for (const r of after.routines) {
    if (after.enabled[r.id] !== false) continue
    need(`switch routine ${r.id} on`, await s.api('admin', 'PUT', `/api/routines/${enc(r.id)}/enabled`, { on: true, ifRev: r.rev }))
  }
}

/** What a second session of the same person can do to a routine: the two writes that leave it as it was, two revisions on. */
export interface RoutineSession {
  deleteRoutine(id: string): Promise<void>
  restoreRoutine(id: string): Promise<void>
}

/**
 * A routine changed behind the client: a delete then a restore in the other session when it is live (a restore then a delete
 * when it is deleted), so it ends as it was, two revisions on, and the first session's next write is stale.
 */
export async function changeRoutineElsewhere(other: RoutineSession, id: string, startsDeleted = false): Promise<void> {
  if (startsDeleted) {
    await other.restoreRoutine(id)
    await other.deleteRoutine(id)
  } else {
    await other.deleteRoutine(id)
    await other.restoreRoutine(id)
  }
}

// ---------- an unread notice for the `markNoticesRead` case ----------

/** The slice of node:sqlite the seeding uses (this program has no Node types; the module is loaded by name at run time). */
interface Sqlite { DatabaseSync: new (file: string) => { prepare(sql: string): { get(...p: unknown[]): unknown; run(...p: unknown[]): unknown }; close(): void } }
interface Fs { readdirSync(dir: string, o: { recursive: true; withFileTypes: true }): { isFile(): boolean; name: string; parentPath: string }[] }
const node = async <T>(name: string): Promise<T> => (await import(/* @vite-ignore */ name)) as T
const proc = (globalThis as unknown as { process?: { env: Record<string, string | undefined>; cwd(): string } }).process

/** The local D1 the test build under `wrangler dev --persist-to` keeps (`.wrangler/test-build`, as e2e/api/db.ts reads it). */
export const persistDir = (): string => proc?.env.CONTRACT_PERSIST_DIR ?? `${proc?.cwd() ?? '.'}/.wrangler/test-build`

const NOTICE_SQL =
  "INSERT INTO notices (id, audience, audience_member_id, template, fields_json, icon, person_id, at_ms, waiting, link_json, source) VALUES (?, 'team', NULL, 'morning_check_found', '{\"items\":1}', 'sun', NULL, ?, 0, '{\"to\":\"page\",\"page\":\"today\"}', 'morning-check')"

/**
 * Puts one unread team notice into the test build's local D1, so the shared `markNoticesRead` case has something to mark: a
 * reset can't make a read notice unread, and no route makes a notice. The one write the contract target makes to D1: a single
 * INSERT into a table nothing else here writes, with a unique id each time, so it can't collide with the build's own writers.
 * Returns the notice's id. Fails loud when no local D1 with a `notices` table is found.
 */
export async function seedUnreadNotice(o: { dir?: string; now?: number } = {}): Promise<string> {
  const { DatabaseSync } = await node<Sqlite>('node:sqlite')
  const { readdirSync } = await node<Fs>('node:fs')
  const dir = o.dir ?? persistDir()
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.sqlite')).map(d => `${d.parentPath}/${d.name}`)
  const at = o.now ?? Date.now()
  const id = `contract-unread-${at}-${Math.floor(Math.random() * 1e9)}`
  for (const file of files) {
    const db = new DatabaseSync(file)
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notices'").get() === undefined) continue
      db.prepare('PRAGMA busy_timeout = 10000').run()
      db.prepare(NOTICE_SQL).run(id, at)
      return id
    } finally {
      db.close()
    }
  }
  throw new Error(`The real contract target found no local D1 with a notices table under ${dir} (CONTRACT_PERSIST_DIR names the test build's --persist-to directory).`)
}
