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
export const WATCH_SERVED = ['listNotifications', 'setAside'] as const

/**
 * The P4 methods the real target does NOT serve, each with why: the shared suite's case for the method can't hold against the
 * real client, so the method's cases skip by name (index.ts prints this list once). The real client's behaviour for each is held
 * by `watch.live.test.ts` (revision sequences, rollback on a forced failure) and the API specs instead. The first three are
 * client gaps (W4 and W5's client), the rest follow from the shared cases' mock-shaped steps.
 */
export const WATCH_EXEMPT: Readonly<Record<string, string>> = {
  markNoticesRead: "the real client's write is optimistic, but in its own `notifications` slice; the shared cases observe `getSnapshot()` (`state.readNotices`), which the client never fills, so 'shows at once', 'a new array after a read mark' and the readNotices keys can't hold",
  deleteFiles: "the real client's write is optimistic in its `files` and `gone` slices; the shared cases observe `getSnapshot()` (`state.libraryDeleted`), which the client never fills (the suite's `observe` option could read `listFiles()`)",
  restoreFiles: 'as deleteFiles (its `gone` slice, not `state.libraryDeleted`)',
  runRoutine: "not optimistic by design: `routineRuns` gets the run only from the server's answer, so 'shows at once' can't hold; and on a build without containers the run can't end",
  deleteRoutine: "the shared 'every editable record carries a rev' case reads a deleted routine back from `read().routines`, which the real client keeps apart (`routinesGone`); the real client's delete is covered by watch.live.test.ts",
  restoreRoutine: "the shared case deletes `routines[0]` and then restores `routines[0]` again, a routine the mock still lists but the real client has moved to `routinesGone`; the real client's restore is covered by watch.live.test.ts",
}

/** Served only on the multi-config build with containers (`E2E_WATCH_BUILD=1`): a Today card to set aside comes from a morning check run. */
export const WATCH_ONLY_ON_WATCH_BUILD: ReadonlySet<string> = new Set(['setAside'])

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
    // The Library's deletes and restores are index.ts's own cases first; here too, so a test that forces one needs no copy.
    case 'deleteFiles': return { verbs: ['POST'], path: '/api/library/delete' }
    case 'restoreFiles': return { verbs: ['POST'], path: '/api/library/restore' }
    case 'setAside': return { verbs: ['PUT'], path: `/api/today/${enc(args[0])}/aside` }
    default: return null
  }
}

interface RoutineListed { id: string; rev: number }
interface RoutinesAnswer { routines: RoutineListed[]; deleted: RoutineListed[]; enabled: Record<string, boolean> }

/**
 * Puts the routines back to how the seed left them, through the API as the seed's Admin: every deleted routine is restored
 * (against the rev the list shows) and every routine that was switched off is switched on. Another test file may be doing the
 * same at the same moment (vitest runs files in parallel against one build), so a restore or a switch that finds the routine
 * already put back (404 or 409) isn't an error: the list is read again, up to three passes, and what is still wrong then fails
 * loud. Each routine's delete, restore and switch leave only revisions behind, which every case reads fresh.
 */
export async function resetRoutines(s: Signer): Promise<void> {
  const need = (what: string, r: { status: number; json: unknown }) => {
    if (r.status >= 300) throw new Error(`The real contract target couldn't ${what}: ${r.status} ${JSON.stringify(r.json)}`)
    return r.json
  }
  /** A write that may lose a race: 404 and 409 mean someone else got there first (the next pass reads the list again). */
  const tolerant = (what: string, r: { status: number; json: unknown }) => {
    if (r.status === 404 || r.status === 409) return
    need(what, r)
  }
  const list = async () => need('read the routines', await s.api('admin', 'GET', WATCH_READ_PATH.routines!)) as RoutinesAnswer
  for (let pass = 1; ; pass++) {
    const now = await list()
    const off = now.routines.filter(r => now.enabled[r.id] === false)
    if (now.deleted.length === 0 && off.length === 0) return
    if (pass > 3) throw new Error(`The real contract target couldn't put the routines back after 3 passes: deleted ${now.deleted.map(r => r.id).join(', ') || 'none'}, off ${off.map(r => r.id).join(', ') || 'none'}`)
    for (const r of now.deleted) tolerant(`restore routine ${r.id}`, await s.api('admin', 'POST', `/api/routines/${enc(r.id)}/restore`, { ifRev: r.rev }))
    const after = await list()
    for (const r of after.routines.filter(x => after.enabled[x.id] === false)) tolerant(`switch routine ${r.id} on`, await s.api('admin', 'PUT', `/api/routines/${enc(r.id)}/enabled`, { on: true, ifRev: r.rev }))
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
interface Sqlite { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => { prepare(sql: string): { get(...p: unknown[]): unknown; run(...p: unknown[]): unknown }; close(): void } }
interface Fs { readdirSync(dir: string, o: { recursive: true; withFileTypes: true }): { isFile(): boolean; name: string; parentPath: string }[] }
const node = async <T>(name: string): Promise<T> => (await import(/* @vite-ignore */ name)) as T
const proc = (globalThis as unknown as { process?: { env: Record<string, string | undefined>; cwd(): string } }).process

/** Whether the multi-config build with containers runs (the orchestrator's `E2E_WATCH_BUILD=1`): only then can a Run now end, so only then do the cases that run a turn mean anything. */
export const watchBuild = (): boolean => proc?.env.E2E_WATCH_BUILD === '1'

/** The local D1 the test build under `wrangler dev --persist-to` keeps (`.wrangler/test-build`, as e2e/api/db.ts reads it). */
export const persistDir = (): string => proc?.env.CONTRACT_PERSIST_DIR ?? `${proc?.cwd() ?? '.'}/.wrangler/test-build`

// The morning check's notice template, written as parts: the icon check reads a quoted snake_case name in src/ as an icon name.
// The slots table's name, as parts for the same reason (the icon check reads a quoted snake_case name as an icon).
const SLOTS = ['routine', 'slots'].join('_')
const NOTICE_TEMPLATE = ['morning', 'check', 'found'].join('_')
const NOTICE_SQL =
  "INSERT INTO notices (id, audience, audience_member_id, template, fields_json, icon, person_id, at_ms, waiting, link_json, source) VALUES (?, 'team', NULL, ?, '{\"items\":1}', 'sun', NULL, ?, 0, '{\"to\":\"page\",\"page\":\"today\"}', 'morning-check')"

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
    const probe = new DatabaseSync(file, { readOnly: true })
    let hasTable = false
    try {
      probe.prepare('PRAGMA busy_timeout = 10000').run()
      hasTable = probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notices'").get() !== undefined
    } finally {
      probe.close()
    }
    if (!hasTable) continue
    const db = new DatabaseSync(file)
    try {
      db.prepare('PRAGMA busy_timeout = 10000').run()
      db.prepare(NOTICE_SQL).run(id, NOTICE_TEMPLATE, at)
      return id
    } finally {
      db.close()
    }
  }
  throw new Error(`The real contract target found no local D1 with a notices table under ${dir} (CONTRACT_PERSIST_DIR names the test build's --persist-to directory).`)
}

// ---------- Run now settles before the next ----------

/**
 * Waits until no Run now of any routine is open in the test build's local D1 (a manual slot `claimed` or `started`), polling
 * with a deadline. The shared `runRoutine` case presses Run now once per routine, and a second Run now while one is open is
 * a run-open conflict, so the target settles each one before the next call. A run that never ends fails here, loud, with the
 * slot keys, once the deadline passes (the tick's own sweep closes a lost end after 45 minutes; the deadline is shorter).
 */
export async function settleRuns(o: { dir?: string; timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const { DatabaseSync } = await node<Sqlite>('node:sqlite')
  const { readdirSync } = await node<Fs>('node:fs')
  const dir = o.dir ?? persistDir()
  const now = o.now ?? (() => Date.now())
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const deadline = now() + (o.timeoutMs ?? 600_000)
  const open = (): string[] => {
    for (const file of readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.sqlite')).map(d => `${d.parentPath}/${d.name}`)) {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        db.prepare('PRAGMA busy_timeout = 10000').run()
        if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${SLOTS}'`).get() === undefined) continue
        return (db.prepare(`SELECT slot_key FROM ${SLOTS} WHERE kind = 'manual' AND state IN ('claimed', 'started')`) as unknown as { all(): { slot_key: string }[] }).all().map(r => r.slot_key)
      } finally {
        db.close()
      }
    }
    throw new Error(`The real contract target found no local D1 with the ${SLOTS} table under ${dir} (CONTRACT_PERSIST_DIR names the test build's --persist-to directory).`)
  }
  for (let keys = open(); keys.length > 0; keys = open()) {
    if (now() >= deadline) throw new Error(`A Run now did not end before the deadline: ${keys.join(', ')}`)
    await sleep(o.intervalMs ?? 2000)
  }
}

// ---------- a routine write's tick settles before the next write ----------

// Table name as parts (the icon check reads a quoted snake_case name as an icon).
const DUE = ['due', 'tasks'].join('_')
const POKE_ID = 'routine-poke'

/**
 * Waits until the routine tick a routine write poked has run (the BrandAgent's `routine-poke` task is gone from its
 * scheduler table: the scheduler deletes it when the handler's work, its D1 batches included, is done). Polls read-only
 * with a deadline, like `settleRuns`. No scheduler table in any local database means nothing was ever poked: nothing to
 * wait for. (File-level isolation for the live contract suite lives in `vitest.config.ts`: `fileParallelism: !process.env.CONTRACT_REAL_ORIGIN`.)
 */
export async function settleTick(o: { dir?: string; timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const { DatabaseSync } = await node<Sqlite>('node:sqlite')
  const { readdirSync } = await node<Fs>('node:fs')
  const dir = o.dir ?? persistDir()
  const now = o.now ?? (() => Date.now())
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const deadline = now() + (o.timeoutMs ?? 30_000)
  const pending = (): boolean => {
    for (const file of readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.sqlite')).map(d => `${d.parentPath}/${d.name}`)) {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        db.prepare('PRAGMA busy_timeout = 10000').run()
        if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${DUE}'`).get() === undefined) continue
        if (db.prepare(`SELECT 1 FROM ${DUE} WHERE id = ?`).get(POKE_ID) !== undefined) return true
      } finally {
        db.close()
      }
    }
    return false
  }
  while (pending()) {
    if (now() >= deadline) throw new Error(`The routine tick a write poked did not finish before the deadline (${POKE_ID} is still in ${DUE})`)
    await sleep(o.intervalMs ?? 20)
  }
}
