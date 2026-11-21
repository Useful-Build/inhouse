// The morning check's result handler (p4-w3.md section 3, kind `morning_check`). W2's end handler calls `run` before its
// batch and commits the returned statements in the same D1 batch as the slot's `ended` mark, its Activity line and its
// notices, so a retry re-runs the same batch. Pure apart from its reads (the hub's tool list, the turn's tool calls, the
// brand's currency); every statement is idempotent for the slot. Today never parses prose: a result that isn't a valid
// structured result saves nothing, and a failed turn's output is never saved, even when present.
import { morningCheckWireSchema } from '../../shared/contract/today.ts'
import type { TodayItem } from '../../shared/contract/today.ts'
import { addNotice } from '../notices/store.ts'
import { hashId } from '../routines/keys.ts'
import type { EndSlot, ResultContext, ResultHandler, ResultOutput } from '../routines/results.ts'
import { itemId } from './ids.ts'
import { normaliseResult } from './normalise.ts'
import type { Normalised } from './normalise.ts'
import { fixedWords, incompleteSummary, thingsWords } from './words.ts'

/** The hub's connector name for a Shopify store (`ToolInfo.connector`). */
export const SHOPIFY = 'shopify'
const JOB = 'morning-check'

/** The brand's currency as an ISO code: `s:currency` holds a label such as `USD ($)`; unset is the default, USD. */
export async function brandCurrency(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE owner = 'brand' AND key = 's:currency'").first<{ value_json: string }>()
  const value: unknown = row ? JSON.parse(row.value_json) : null
  return typeof value === 'string' && /^[A-Z]{3}\b/.test(value) ? value.slice(0, 3) : 'USD'
}

/** The instant an item's `since` names, or null when it isn't one (the SDK doesn't enforce `format`, L-7). */
const instantOrNull = (s: string | null) => {
  if (s === null) return null
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : { iso: new Date(ms).toISOString(), ms }
}

/** One item's idempotent upsert: an older slot never overwrites a newer one's row (both ordered by (local_date, claimed_at_ms)). */
export const itemUpsert = (db: D1Database, slot: Pick<EndSlot, 'slot_key' | 'local_date' | 'claimed_at_ms'>, runId: string, item: TodayItem, nowMs: number): D1PreparedStatement =>
  db.prepare(
    `INSERT INTO today_items (id, key, local_date, slot_key, claimed_at_ms, run_id, item_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET item_json = excluded.item_json, slot_key = excluded.slot_key, claimed_at_ms = excluded.claimed_at_ms,
        run_id = excluded.run_id
      WHERE excluded.local_date = today_items.local_date AND excluded.claimed_at_ms > today_items.claimed_at_ms`,
  ).bind(item.id, item.key, slot.local_date, slot.slot_key, slot.claimed_at_ms, runId, JSON.stringify(item), nowMs)

const none = (summary: string, failure: string): ResultOutput => ({ statements: [], summary, failure })

export async function morningCheck(slot: EndSlot, end: Parameters<ResultHandler['run']>[1], ctx: ResultContext): Promise<ResultOutput & { normalised?: Normalised }> {
  // A slot that already ended has its result: a re-delivery writes nothing more (the slot's own statements are guarded the same way).
  if (slot.state === 'ended') return { statements: [], summary: null }
  // 0. Is a store connected? Only a hub that says it isn't configured, or lists no Shopify tool, counts: any other hub
  // error throws, so the end is retried instead of recording a wrong cause.
  const tools = await ctx.hub.listTools({ kind: 'server', job: JOB, requestId: await hashId('mc_', slot.slot_key) })
  if (!tools.ok) {
    if (tools.error.code !== 'not_configured') throw new Error(`morning check: the hub's tool list failed (${tools.error.code})`)
    return none("Shopify isn't connected", 'not_connected')
  }
  if (!tools.value.some(t => t.connector === SHOPIFY)) return none("Shopify isn't connected", 'not_connected')
  // 1. A turn that didn't finish (stopped, interrupted, cancelled, failed), or ended with no structured output.
  if (end.outcome !== 'done' || end.failure !== null || end.structuredOutput === null || end.structuredOutput === undefined) {
    return none("didn't finish", 'run_failed')
  }
  // 2. Normalise cosmetic overruns, then check. A structural error saves nothing.
  const checked = normaliseResult(end.structuredOutput, await brandCurrency(ctx.db))
  if ('invalid' in checked) return none("didn't give a valid result", 'invalid_result')
  const { result, counts } = checked.ok
  // 2b. `complete` from a turn that made no store call is a claim without a read: incomplete, every area a gap.
  let coverage = result.coverage
  let gaps = result.gaps
  if (coverage === 'complete') {
    const calls = await ctx.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE turn_id = ? AND decision = 'allow' AND tool LIKE 'mcp\\_\\_apps\\_\\_%' ESCAPE '\\'").bind(ctx.turnId).first<{ n: number }>()
    if ((calls?.n ?? 0) === 0) {
      coverage = 'incomplete'
      gaps = ['orders', 'products', 'inventory', 'refunds', 'returns']
    }
  }
  // 3. One idempotent statement per item.
  const foundAt = { iso: new Date(ctx.nowMs).toISOString(), ms: ctx.nowMs }
  const items: TodayItem[] = await Promise.all(result.items.map(async i => {
    const { since, ...rest } = i
    return { ...rest, id: await itemId(i.key, slot.local_date), since: instantOrNull(since), foundAt, routineRun: ctx.runId }
  }))
  const statements = items.map(it => itemUpsert(ctx.db, slot, ctx.runId, it, ctx.nowMs))
  // 5. A bell notice for the team when something was found (a hashed id: the notice id may not hold the slot key's `|`).
  if (items.length > 0) {
    statements.push(addNotice(ctx.db, {
      id: await hashId('mc_', `${slot.slot_key}|${items.length}`), audience: 'team', template: 'morning_check_found',
      fields: { items: items.length }, icon: 'alert', link: { to: 'page', page: 'today' }, atMs: ctx.nowMs, waiting: true,
    }))
  }
  const base = { statements, normalised: counts }
  // 4. Incomplete: the items are saved and W2 tells the admins; the summary names the gaps from the fixed list.
  if (coverage === 'incomplete') return { ...base, summary: incompleteSummary(items.length, gaps) + fixedWords(counts), failure: 'incomplete' }
  return { ...base, summary: thingsWords(items.length) + fixedWords(counts), activity: { template: 'morning_check_ran', fields: { items: items.length } } }
}

export const morningCheckHandler: ResultHandler = {
  outputFormat: { type: 'json_schema', schema: morningCheckWireSchema() },
  run: morningCheck,
}
