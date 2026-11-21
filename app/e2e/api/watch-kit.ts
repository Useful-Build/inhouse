// What the P4 Watch specs share (W6): the gate for specs that need the multi-config test build, the test controls of
// route 67, seeding a routine straight into D1 (no route makes one: only `routine_create` does, in a chat), the stage
// setting, and waiting by condition. The specs run against the multi-config test build the orchestrator starts under the
// heavy lock (product Worker with containers, hub, recorded Shopify fixture, scripted model, test issuer).
import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, endLiveGrants, me, putSetting } from './kit.ts'
import type { Actor, Reply } from './kit.ts'
import { readSql, writeSql } from './db.ts'
import { localClock } from '../support/watch-pure.ts'

/**
 * The switches the P4 Watch specs read, all set by the orchestrator's run under the heavy lock (the multi-config test build:
 * product Worker with containers, hub, recorded Shopify fixture, scripted model, test issuer):
 *   E2E_WATCH_BUILD=1     the multi-config build runs here with containers and its local D1. Without it the specs that
 *                         seed routines, read slot rows or run a turn skip, and say so on stderr (`skipLoudly`).
 *   E2E_HUB_ORIGIN        the hub Worker's own origin (hub.spec.ts: no public route). Without it that group skips, loudly.
 *   WATCH_ARTIFACTS_DIR   where the orchestrator drops the canary sweep's inputs (hub.spec.ts `ARTIFACTS`: product-wrangler.log,
 *                         hub-wrangler.log, runner-container.log, d1-dump.sql, r2/, run-tokens.txt). Without it the log checks
 *                         and the sweep skip, loudly; a named file that is missing fails the spec.
 * API-only tests (roles, Library uploads, paging) need none of them.
 */

const warned = new Set<string>()
/** The spec file that called, from the stack (`routines.spec.ts`), for the warning's label. */
const callerOf = (): string => /([\w.-]+\.spec\.ts)/.exec(new Error().stack?.split('\n').slice(3).join('\n') ?? '')?.[1] ?? 'a Watch spec'

/** `test.skip(condition, reason)` that also says, once per file and reason on stderr, which spec is being skipped and why. */
export function skipLoudly(condition: boolean, reason: string, label: string = callerOf()): void {
  if (condition && !warned.has(`${label}|${reason}`)) {
    warned.add(`${label}|${reason}`)
    process.stderr.write(`\nWATCH SPECS SKIPPED in ${label}: ${reason}\n`)
  }
  test.skip(condition, reason)
}

/** Skips unless `E2E_WATCH_BUILD=1` (see the switches above), and never on a deployed test build (no local D1). Call first in a describe or test. */
export function needsWatchBuild(): void {
  const label = callerOf()
  skipLoudly(process.env.E2E_WATCH_BUILD !== '1', 'E2E_WATCH_BUILD is not 1: the multi-config test build with containers and its local D1 is not declared here', label)
  skipLoudly(!!process.env.E2E_TEST_BUILD_REMOTE, 'E2E_TEST_BUILD_REMOTE is set: a deployed test build has no local D1 to seed and read', label)
}

/** The brand's zone as the specs run: the default (`g:tz` unset), the seed's. */
export const BRAND_TZ = 'America/New_York'

const release = actor('release')

/** Route 67 (`POST /api/ops/alarm`, release token, the brand `Origin`, test build only). Returns the reply as it came. */
export const alarmControl = (request: APIRequestContext, body?: Record<string, unknown>): Promise<Reply> =>
  call(request, release, 'POST', '/api/ops/alarm', body === undefined ? {} : { json: body })

/** One scheduler pass with the routine tick made due first. */
export async function alarmAndTick(request: APIRequestContext): Promise<void> {
  const r = await alarmControl(request, { action: 'alarm', pokeTick: true })
  expect(r.status, r.text).toBe(200)
  expect(r.json).toEqual({ ran: true })
}

export interface RoutineSeed {
  creatorId: string
  /** Local `HH:MM` the routine runs at, every day. */
  hour: number
  minute: number
  /** The text of the routine's turn; a `scenario:<name>` marker picks the scripted model's script. */
  instruction: string
  missed?: 'skip' | 'catch_up'
  catchUpWithinMin?: number
  need?: 0 | 1 | 2
  /** The cursor: every slot due at or before it is decided. Default: now. */
  checkedUntilMs?: number
}

export const routineId = (): string => `rt_${randomBytes(16).toString('base64url')}`
const seeded: string[] = []

/** Inserts a team routine for `seed.creatorId` and returns its id. Soft-deleted again by `retireRoutines`. */
export function seedRoutine(seed: RoutineSeed): string {
  const id = routineId()
  const now = Date.now()
  writeSql(
    `INSERT INTO routines (id, origin, kind, name, instruction, prompt_ref, days_mask, hour, minute, missed, catch_up_within_min, need, enabled, creator_id, checked_until_ms, created_at_ms, updated_at_ms, rev)
     VALUES (?, 'team', 'agent', ?, ?, NULL, 127, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)`,
    id, `E2E routine ${id.slice(3, 9)}`, seed.instruction, seed.hour, seed.minute, seed.missed ?? 'skip', seed.catchUpWithinMin ?? 360, seed.need ?? 0, seed.creatorId, seed.checkedUntilMs ?? now, now, now,
  )
  seeded.push(id)
  return id
}

/** Retire a routine a spec didn't seed itself (a chat made it) with the others. */
export const trackRoutine = (id: string): void => { seeded.push(id) }

/** The wall `hour:minute` the brand's zone shows `minutesAgo` before now, and its local date. */
export function localSlot(minutesAgo: number, tz: string = BRAND_TZ): { hour: number; minute: number; date: string; time: string } {
  const c = localClock(Date.now() - minutesAgo * 60_000, tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  return { hour: c.hour, minute: c.minute, date: c.date, time: `${pad(c.hour)}:${pad(c.minute)}` }
}

export interface SlotRow {
  slot_key: string
  routine_id: string
  kind: 'scheduled' | 'manual'
  state: string
  reason: string | null
  local_date: string
  local_time: string | null
  chat_id: string
  run_id: string | null
  turn_id: string | null
  outcome: string | null
  failure: string | null
  result_text: string | null
}
const SLOT_COLUMNS = 'slot_key, routine_id, kind, state, reason, local_date, local_time, chat_id, run_id, turn_id, outcome, failure, result_text'
export const slotsOf = (id: string): SlotRow[] => readSql<SlotRow>(`SELECT ${SLOT_COLUMNS} FROM routine_slots WHERE routine_id = ? ORDER BY claimed_at_ms, slot_key`, id)

/** The distinct turns a routine slot's chat holds in P3's history (a second source beside the slot row). */
export const turnsInChat = (chatId: string): number => readSql<{ n: number }>('SELECT COUNT(DISTINCT turn_id) AS n FROM chat_messages WHERE chat_id = ?', chatId)[0]!.n

/** Waits until the routine has a slot satisfying `ok`, by polling the slot rows (no fixed sleep). */
export async function slotWhere(id: string, what: string, ok: (s: SlotRow) => boolean, timeout = 180_000): Promise<SlotRow> {
  let found: SlotRow | undefined
  await expect.poll(() => (found = slotsOf(id).find(ok)) !== undefined, { timeout, message: what }).toBe(true)
  return found!
}

/** Soft-deletes (and switches off) every routine this spec seeded, so no later pass touches them. */
export function retireRoutines(): void {
  for (const id of seeded.splice(0)) writeSql('UPDATE routines SET enabled = 0, deleted_at_ms = ?, updated_at_ms = ?, rev = rev + 1 WHERE id = ?', Date.now(), Date.now(), id)
}

export const routineRow = (id: string) =>
  readSql<{ rev: number; enabled: number; deleted_at_ms: number | null; checked_until_ms: number; creator_id: string; need: number; source_chat_id: string | null }>(
    'SELECT rev, enabled, deleted_at_ms, checked_until_ms, creator_id, need, source_chat_id FROM routines WHERE id = ?', id)[0]

export const memberIdOf = async (request: APIRequestContext, who: Actor): Promise<string> => (await me(request, who)).memberId

/** The brand's stage, set as the Inhouse team under a live grant (the technical scope's writer), and the grant ended after. */
export async function setStage(request: APIRequestContext, stage: 'Watch' | 'Act' | 'Run'): Promise<void> {
  await endLiveGrants(request)
  const grant = await call(request, actor('admin'), 'POST', '/api/grants', { json: { hours: 1 } })
  expect(grant.status, grant.text).toBe(201)
  const done = await putSetting(request, actor('inhouse'), 'technical', 'stage', stage)
  expect(done.status, done.text).toBe(200)
  await endLiveGrants(request)
}

/** Every P4 route (access rows 52 to 66) as `<method> <pattern>`: the specs' 401 sweep keys on these, with cases.ts's requests. */
export const P4_ROUTES: readonly string[] = [
  'GET /api/routines', 'PUT /api/routines/:id/enabled', 'POST /api/routines/:id/run', 'POST /api/routines/:id/delete', 'POST /api/routines/:id/restore',
  'GET /api/today', 'PUT /api/today/:id/aside',
  'GET /api/activity', 'GET /api/notifications', 'POST /api/notifications/read',
  'GET /api/library', 'POST /api/library/uploads', 'GET /api/library/:id/download', 'POST /api/library/delete', 'POST /api/library/restore',
]
