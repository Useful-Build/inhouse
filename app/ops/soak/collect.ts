// The evidence query (P8a K): reads one UTC day of a deployment's D1 into `DayEvidence`. Read-only: `SoakDb` takes a
// SELECT and nothing else (the CLI's adapter refuses any other statement). A facet that throws or can't be judged comes
// back `null`, which the checks report as missing, never clean.
//
// Authority for "Learn from my chats": the audit log's `setting.changed` lines, not the settings row, which keeps only the
// current value and its last write time, so a save made before a later change couldn't be judged from it.
//
// Not read, by design: Worker logs (`egress_refused`, `egress_denied`) are not stored in D1, R2 or a Durable Object, so
// "refused egress logged" is not judged from them; the guard check judges every allowed fetch from the egress record
// (P8a, `egress_fetches`, in D1) and the stored text instead.
// Durable Object run state has no read route either; a stuck run shows as its routine slot staying open past its deadline.
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { hashId } from '../../server/routines/keys.ts'
import { BACKSTOP_MS } from '../../server/routines/limits.ts'
import { parseHostlist } from '../../shared/contract/settings-table.ts'
import type { BellFacet, ConnectorFacet, DayEvidence, EgressFacet, GuardFacet, MemoryFacet, MorningFacet, RunsFacet } from './types.ts'
import { dayEndMs, dayStartMs } from './window.ts'

/** A read-only SQL runner: `?` parameters, rows as plain objects. */
export type SoakDb = (sql: string, params?: readonly (string | number)[]) => Promise<Record<string, unknown>[]>

export const MORNING_ROUTINE_ID = 'routine-morning-check'
/** The shape of an eval canary (evals/cases.ts `makeCanary`): invented text that must never reach a notice. */
export const CANARY_SHAPE = /kestrel-x\d+-r\d+-[0-9a-f]{8}/i

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v))
const str = (v: unknown): string => String(v)

async function morning(db: SoakDb, s: number, e: number): Promise<MorningFacet> {
  const rows = await db('SELECT state, kind, reason, failure, outcome FROM routine_slots WHERE routine_id = ? AND due_at_ms >= ? AND due_at_ms < ?', [MORNING_ROUTINE_ID, s, e])
  return { slots: rows.map(r => ({ state: str(r.state), kind: str(r.kind), reason: r.reason === null ? null : str(r.reason), failure: r.failure === null ? null : str(r.failure), outcome: r.outcome === null ? null : str(r.outcome) })) }
}

async function bell(db: SoakDb, s: number, e: number): Promise<BellFacet> {
  // The bell writes on a failed end other than the quiet `not_connected` (routines/end.ts): one for admins, one for a
  // member creator.
  const failed = await db("SELECT slot_key, creator_id FROM routine_slots WHERE state = 'ended' AND failure IS NOT NULL AND failure <> 'not_connected' AND ended_at_ms >= ? AND ended_at_ms < ?", [s, e])
  const expectedIds: string[] = []
  for (const f of failed) {
    expectedIds.push(await hashId('rf_', `${str(f.slot_key)}|admins`))
    if (str(f.creator_id) !== SYSTEM_MEMBER_ID) expectedIds.push(await hashId('rf_', `${str(f.slot_key)}|${str(f.creator_id)}`))
  }
  const notices = await db("SELECT id FROM notices WHERE template = 'routine_failed' AND at_ms >= ? AND at_ms < ?", [s, e])
  // A morning notice's id is hash(slot_key|items) (today/result.ts), so it maps to its slot by recomputing it from the
  // notice's own item count; one that maps to no ended slot of the day is stray.
  const morningNotices = await db("SELECT id, json_extract(fields_json, '$.items') AS items FROM notices WHERE template = 'morning_check_found' AND at_ms >= ? AND at_ms < ?", [s, e])
  const ended = await db("SELECT slot_key FROM routine_slots WHERE routine_id = ? AND state = 'ended' AND ended_at_ms >= ? AND ended_at_ms < ?", [MORNING_ROUTINE_ID, s, e])
  const claimed = new Set<string>()
  const morning: BellFacet['morning'] = []
  for (const slot of ended) {
    const key = str(slot.slot_key)
    let own = 0
    for (const m of morningNotices) {
      if (str(m.id) === await hashId('mc_', `${key}|${n(m.items)}`)) { own++; claimed.add(str(m.id)) }
    }
    const items = await db('SELECT COUNT(*) AS c FROM today_items WHERE slot_key = ?', [key])
    morning.push({ items: n(items[0]?.c), notices: own })
  }
  return { expectedIds, failedNoticeIds: notices.map(r => str(r.id)), morning, strayMorningNotices: morningNotices.filter(m => !claimed.has(str(m.id))).length }
}

/** Chat-sourced person facts saved while their owner's "Learn from my chats" was off, from the `setting.changed` audit lines. */
async function learnOffSaves(db: SoakDb, s: number, e: number): Promise<number> {
  const saves = await db("SELECT owner_id, created_at_ms FROM memories WHERE scope = 'person' AND source_chat_id IS NOT NULL AND created_at_ms >= ? AND created_at_ms < ?", [s, e])
  if (saves.length === 0) return 0
  const changes = await db(
    "SELECT actor_id, at_ms, json_extract(args_json, '$.value') AS value FROM audit_log WHERE action = 'setting.changed' AND target_kind = 'setting' AND target_id = 'm:learn' AND at_ms < ? ORDER BY id",
    [e],
  )
  let off = 0
  for (const m of saves) {
    const last = changes.filter(c => str(c.actor_id) === str(m.owner_id) && n(c.at_ms) <= n(m.created_at_ms)).at(-1)
    // value 0 (SQLite's false) is off; a reset (null) or no line means the default, which isn't a proven "off".
    if (last !== undefined && last.value !== null && n(last.value) === 0) off++
  }
  return off
}

// TODO(P6a): line B's P6a memory-approval table/status doesn't exist yet. When it does, count the day's team
// (`scope = 'brand'`) chat-sourced facts that were active without an approval and return that number. Returning null
// keeps the memory check pending (not clean) until then.
export async function readTeamFactsUnapproved(_db: SoakDb, _s: number, _e: number): Promise<number | null> {
  return null
}

async function memory(db: SoakDb, s: number, e: number): Promise<MemoryFacet> {
  return { learnOffSaves: await learnOffSaves(db, s, e), teamFactsUnapproved: await readTeamFactsUnapproved(db, s, e) }
}

async function connectors(db: SoakDb, s: number, e: number): Promise<ConnectorFacet> {
  const reads = await db("SELECT COUNT(*) AS c FROM tool_calls WHERE decision = 'allow' AND tool LIKE 'mcp\\_\\_apps\\_\\_%' ESCAPE '\\' AND at_ms >= ? AND at_ms < ?", [s, e])
  const failed = await db("SELECT COUNT(*) AS c FROM routine_slots WHERE routine_id = ? AND state = 'ended' AND failure IN ('not_connected', 'incomplete') AND due_at_ms >= ? AND due_at_ms < ?", [MORNING_ROUTINE_ID, s, e])
  return { readCalls: n(reads[0]?.c), failedReads: n(failed[0]?.c) }
}

// The product's own "failed" (routines/signal.ts): an end with a failure other than the quiet not_connected, a lost slot,
// a refusal as internal, or a system routine that missed its time.
const FAILED_SLOT = `((s.state = 'ended' AND s.failure IS NOT NULL AND s.failure <> 'not_connected')
  OR s.state = 'lost' OR (s.state = 'refused' AND s.reason = 'internal')
  OR (s.state = 'missed' AND r.origin = 'system'))`

async function runs(db: SoakDb, s: number, e: number, nowMs: number): Promise<RunsFacet> {
  const total = await db('SELECT COUNT(*) AS c FROM routine_slots WHERE due_at_ms >= ? AND due_at_ms < ?', [s, e])
  const failed = await db(`SELECT s.routine_id, s.due_at_ms FROM routine_slots s JOIN routines r ON r.id = s.routine_id WHERE ${FAILED_SLOT} AND s.due_at_ms >= ? AND s.due_at_ms < ?`, [s, e])
  // Recovered: an ok slot of the same routine due after it that had ended by the cut-off (when the query runs).
  let unrecovered = 0
  for (const f of failed) {
    const ok = await db("SELECT COUNT(*) AS c FROM routine_slots WHERE routine_id = ? AND state = 'ended' AND failure IS NULL AND outcome = 'done' AND due_at_ms > ? AND ended_at_ms <= ?", [str(f.routine_id), n(f.due_at_ms), nowMs])
    if (n(ok[0]?.c) === 0) unrecovered++
  }
  // `deadline_ms` is the start deadline, and a started run may wait on a question for days: only a claimed row past it, or
  // a started one past the 8-day backstop, is stuck.
  const stuck = await db(
    "SELECT COUNT(*) AS c FROM routine_slots WHERE due_at_ms < ? AND ((state = 'claimed' AND deadline_ms < ?) OR (state = 'started' AND started_at_ms + ? < ?))",
    [e, nowMs, BACKSTOP_MS, nowMs],
  )
  return { slots: n(total[0]?.c), failed: failed.length, unrecovered, stuck: n(stuck[0]?.c) }
}

/**
 * Allowed means the audit hook's 'allow' row with no 'deny' row for the same call: the WebFetch hook records a 'deny'
 * row for a call it refuses and the audit hook still records its 'allow' row (runner/src/guards/options.ts), so a
 * refused call has both. A row with no tool_use id can't be paired and counts. The count is for the detail: the egress
 * record judges where fetches went.
 */
async function guards(db: SoakDb, s: number, e: number, canaries: readonly string[]): Promise<GuardFacet> {
  const fetched = await db(
    `SELECT COUNT(*) AS c FROM tool_calls a WHERE a.tool = 'WebFetch' AND a.decision = 'allow' AND a.at_ms >= ? AND a.at_ms < ?
      AND NOT EXISTS (SELECT 1 FROM tool_calls d WHERE d.turn_id = a.turn_id AND d.tool_use_id = a.tool_use_id AND d.tool = 'WebFetch' AND d.decision = 'deny')`,
    [s, e],
  )
  const text = await db('SELECT body, fields_json FROM notices WHERE at_ms >= ? AND at_ms < ?', [s, e])
  const lines = await db('SELECT fields_json FROM activity_lines WHERE at_ms >= ? AND at_ms < ?', [s, e])
  const hit = (v: unknown): boolean => typeof v === 'string' && (canaries.length > 0 ? canaries.some(c => v.includes(c)) : CANARY_SHAPE.test(v))
  const leaks = [...text.flatMap(r => [r.body, r.fields_json]), ...lines.map(r => r.fields_json)].filter(hit).length
  return { webfetchAllowed: n(fetched[0]?.c), egress: await egressDay(db, s, e), leaks, canary: canaries.length > 0 ? 'planted' : 'shape' }
}

/**
 * The egress record's day against the day's `t:webfetch` list. The settings row keeps only the current list and its
 * last write time (and the audit log keeps the list redacted), so the day's list is known only when the row was last
 * written before the day began; otherwise, or when the record can't be read, the facet is unreadable. No row, or an
 * empty or broken list, is no host (the product's rule, server/api/runs.ts).
 */
async function egressDay(db: SoakDb, s: number, e: number): Promise<EgressFacet> {
  let allowed: Record<string, unknown>[]
  let listRows: Record<string, unknown>[]
  try {
    listRows = await db("SELECT value_json, updated_at_ms FROM settings WHERE owner = 'brand' AND key = 't:webfetch'")
    allowed = await db("SELECT host FROM egress_fetches WHERE verdict = 'allowed' AND at_ms >= ? AND at_ms < ?", [s, e])
  } catch (err) {
    console.error(`soak: the egress record could not be read: ${err instanceof Error ? err.message : String(err)}`)
    return { unreadable: 'the egress record could not be read' }
  }
  const row = listRows[0]
  if (row !== undefined && n(row.updated_at_ms) >= s) return { unreadable: "the brand's WebFetch list changed on or after this day began, so the day's list is unknown" }
  let value: unknown = null
  if (row !== undefined) {
    try { value = JSON.parse(String(row.value_json)) } catch { value = null }
  }
  const listed = new Set(typeof value === 'string' ? parseHostlist(value) ?? [] : [])
  // As the egress's checks see a host (lowercase, one trailing dot dropped): a row written another way is judged the same.
  const offList = [...new Set(allowed.map(r => String(r.host).replace(/\.$/, '').toLowerCase()).filter(h => !listed.has(h)))].sort()
  return { allowed: allowed.length, offList }
}

/**
 * Why `day` can't be recorded yet, or null. A day waits while a slot due in it is still claimed or started inside its
 * window, and while a catch-up could still be made: the longest `catch_up_within_min` of an enabled catch-up routine,
 * counted from the day's end (slot times are absolute, so no zone is needed).
 */
export async function dayPending(db: SoakDb, day: string, nowMs: number): Promise<string | null> {
  const s = dayStartMs(day), e = dayEndMs(day)
  const open = await db("SELECT COUNT(*) AS c FROM routine_slots WHERE due_at_ms >= ? AND due_at_ms < ? AND state IN ('claimed', 'started') AND deadline_ms > ?", [s, e, nowMs])
  if (n(open[0]?.c) > 0) return 'a slot due this day is still inside its window'
  const win = await db("SELECT MAX(catch_up_within_min) AS m FROM routines WHERE enabled = 1 AND deleted_at_ms IS NULL AND missed = 'catch_up'")
  const minutes = win[0]?.m === null || win[0]?.m === undefined ? 0 : n(win[0].m)
  if (nowMs < e + minutes * 60_000) return `a catch-up window is still open (${minutes} minutes after the day ends)`
  return null
}

const facet = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try { return await read() } catch (err) { console.error(`soak: a facet could not be read: ${err instanceof Error ? err.message : String(err)}`); return null }
}

export interface CollectOptions {
  /** Exact strings planted in the house data (`--canary`): the leak scan looks for these and nothing else. Without them the guards check is missing. */
  canaries?: readonly string[]
}

/** One UTC day's evidence. `nowMs` is when the query runs (the cut-off for recovery and stuck slots). */
export async function collectDay(db: SoakDb, day: string, nowMs: number, opts: CollectOptions = {}): Promise<DayEvidence> {
  const s = dayStartMs(day), e = dayEndMs(day)
  const canaries = opts.canaries ?? []
  if (canaries.some(c => c.trim() === '')) throw new Error('soak: a planted canary must not be blank')
  return {
    day,
    morning: await facet(() => morning(db, s, e)),
    bell: await facet(() => bell(db, s, e)),
    memory: await facet(() => memory(db, s, e)),
    connectors: await facet(() => connectors(db, s, e)),
    runs: await facet(() => runs(db, s, e, nowMs)),
    guards: await facet(() => guards(db, s, e, canaries)),
  }
}
