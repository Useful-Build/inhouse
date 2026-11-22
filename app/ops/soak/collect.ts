// The evidence query (P8a K): reads one UTC day of a deployment's D1 into `DayEvidence`. Read-only: `SoakDb` takes a
// SELECT and nothing else (the CLI's adapter refuses any other statement). A facet that throws or can't be judged comes
// back `null`, which the checks report as missing, never clean.
//
// Not read, by design: Worker logs (`egress_refused`, `egress_denied`) are not stored in D1, R2 or a Durable Object, so
// "refused egress logged" is not judged here; the guard check covers the allowed calls and the stored text instead.
// Durable Object run state has no read route either; a stuck run shows as its routine slot staying open past its deadline.
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { hashId } from '../../server/routines/keys.ts'
import type { BellFacet, ConnectorFacet, DayEvidence, GuardFacet, MemoryFacet, MorningFacet, RunsFacet } from './types.ts'
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
  const mc = await db("SELECT COUNT(*) AS c FROM notices WHERE template = 'morning_check_found' AND at_ms >= ? AND at_ms < ?", [s, e])
  const ended = await db("SELECT COUNT(*) AS c FROM routine_slots WHERE routine_id = ? AND state = 'ended' AND ended_at_ms >= ? AND ended_at_ms < ?", [MORNING_ROUTINE_ID, s, e])
  return { expectedIds, failedNoticeIds: notices.map(r => str(r.id)), morningNotices: n(mc[0]?.c), morningEnded: n(ended[0]?.c) }
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

async function runs(db: SoakDb, e: number, nowMs: number): Promise<RunsFacet> {
  const stuck = await db("SELECT COUNT(*) AS c FROM routine_slots WHERE state IN ('claimed', 'started') AND deadline_ms < ? AND due_at_ms < ?", [nowMs, e])
  return { stuck: n(stuck[0]?.c) }
}

/** Null (missing) when the team's host list isn't empty: its history is stored as a hash, so a bypass can't be told from a listed fetch. */
async function guards(db: SoakDb, s: number, e: number): Promise<GuardFacet | null> {
  const list = await db("SELECT value_json FROM settings WHERE owner = 'brand' AND key = 't:webfetch'")
  const hosts = list[0] === undefined ? '' : JSON.parse(str(list[0].value_json))
  if (typeof hosts !== 'string' || hosts.trim() !== '') return null
  const fetched = await db("SELECT COUNT(*) AS c FROM tool_calls WHERE tool = 'WebFetch' AND decision = 'allow' AND at_ms >= ? AND at_ms < ?", [s, e])
  const text = await db('SELECT body, fields_json FROM notices WHERE at_ms >= ? AND at_ms < ?', [s, e])
  const lines = await db('SELECT fields_json FROM activity_lines WHERE at_ms >= ? AND at_ms < ?', [s, e])
  const leaks = [...text.flatMap(r => [r.body, r.fields_json]), ...lines.map(r => r.fields_json)].filter(v => typeof v === 'string' && CANARY_SHAPE.test(v)).length
  return { webfetchBypass: n(fetched[0]?.c), leaks }
}

const facet = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try { return await read() } catch (err) { console.error(`soak: a facet could not be read: ${err instanceof Error ? err.message : String(err)}`); return null }
}

/** One UTC day's evidence. `nowMs` is when the query runs (a slot is stuck once its deadline is before it). */
export async function collectDay(db: SoakDb, day: string, nowMs: number): Promise<DayEvidence> {
  const s = dayStartMs(day), e = dayEndMs(day)
  return {
    day,
    morning: await facet(() => morning(db, s, e)),
    bell: await facet(() => bell(db, s, e)),
    memory: await facet(() => memory(db, s, e)),
    connectors: await facet(() => connectors(db, s, e)),
    runs: await facet(() => runs(db, e, nowMs)),
    guards: await facet(() => guards(db, s, e)),
  }
}
