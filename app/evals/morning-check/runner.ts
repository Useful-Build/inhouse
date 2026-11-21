// The morning-check runner's core (p4-w3.md section 6): per case, point the product Worker at the case's shop, make the
// morning check's slot due, wait for it to end (polling with a deadline: no fixed sleeps), read what it left behind from
// the stored rows, grade it. Everything the outside world does is injected (`RunnerEnv`), so a unit test drives the loop with
// fakes. `run.mjs` is the command line over the real test build.
import { gapsOfSummary } from '../../server/today/words.ts'
import { META, hostOf } from './expected.ts'
import type { MorningCaseMeta } from './expected.ts'
import { grade, summarise } from './grade.ts'
import type { Fixed, Observed } from './grade.ts'
import type { CaseResult, ResultFile } from './results.ts'

export const ROUTINE_ID = 'routine-morning-check'
export const TERMINAL = new Set(['ended', 'lost', 'missed', 'skipped', 'refused'])

export interface SlotRow {
  slot_key: string
  state: string
  failure: string | null
  result_text: string | null
  turn_id: string | null
  claimed_at_ms: number
}

/** The stored rows a run leaves (read from the test build's local D1 file by `run.mjs`). */
export interface Reader {
  /** One slot by its key, or null while it doesn't exist. */
  slot(slotKey: string): Promise<SlotRow | null>
  /** The `item_json` of the items a slot reported. */
  items(slotKey: string): Promise<string[]>
  /** The names of the tools a turn called (`tool_calls.tool`). */
  tools(turnId: string): Promise<string[]>
}

export interface RunnerEnv {
  nowMs(): number
  /** Points the product Worker's SHOPIFY_SHOP at `host` (a restart of the test build, or a cheaper switch). */
  useShop(host: string): Promise<void>
  /** A fresh Run now key (32 hex characters, no `.`): each case's own manual slot `now|<routine>|<key>`. */
  newKey(): string
  /** Presses Run now (route 54) with this key, as a person, and starts a scheduler pass. */
  trigger(clientKey: string): Promise<void>
  /** One more scheduler pass while waiting (route 67 alarm; harmless when nothing is due). */
  nudge(): Promise<void>
  /** Yields between polls. */
  pause(): Promise<void>
  reader: Reader
  /** The most one case may take, in ms. */
  caseTimeoutMs: number
}

const ZERO: Fixed = { truncated: 0, dropped: 0, deduped: 0, overflow: 0 }

/** The inverse of `fixedWords` (server/today/words.ts): the normaliser's counts from a summary's tail. */
export function parseFixed(text: string | null): Fixed {
  const inside = /\(fixed: ([^)]*)\)/.exec(text ?? '')?.[1]
  if (inside === undefined) return { ...ZERO }
  const n = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(inside)?.[1] ?? 0)
  return { truncated: n('cut'), dropped: n('dropped'), deduped: n('repeated'), overflow: n('over the cap') }
}

interface StoredItem { key: string; sev: string; sources: { n: string }[] }

/** What the slot left: the stored items, the gaps and coverage the summary names, the tools the turn called. */
export async function observe(reader: Reader, slot: SlotRow): Promise<Observed> {
  const calls = slot.turn_id === null ? [] : await reader.tools(slot.turn_id)
  const fixed = parseFixed(slot.result_text)
  if (slot.state !== 'ended') return { ok: false, cause: `slot ${slot.state}`, calls, fixed: null }
  if (slot.failure !== null && slot.failure !== 'incomplete') return { ok: false, cause: slot.failure, calls, fixed }
  const g = gapsOfSummary(slot.result_text)
  const items = (await reader.items(slot.slot_key)).map(j => {
    const it = JSON.parse(j) as StoredItem
    return { key: it.key, sev: it.sev, sources: it.sources.map(s => s.n) }
  })
  return { ok: true, coverage: slot.failure === 'incomplete' ? 'incomplete' : 'complete', gaps: [...g.areas, ...(g.tooMany ? ['too_many'] : [])], items, calls, fixed }
}

export async function runCase(env: RunnerEnv, c: MorningCaseMeta): Promise<CaseResult> {
  const started = env.nowMs()
  await env.useShop(hostOf(c.id))
  const clientKey = env.newKey()
  const slotKey = `now|${ROUTINE_ID}|${clientKey}`
  try {
    await env.trigger(clientKey)
  } catch (e) {
    // Run now refused (an earlier case's slot is still open: conflict/run_open) or the call failed: this case fails with the text.
    const observed = { ok: false as const, cause: `trigger: ${e instanceof Error ? e.message : String(e)}`, calls: [], fixed: null }
    return { id: c.id, group: c.group, verdict: grade(c, observed), observed, slotKey, failure: null, resultText: null, ms: env.nowMs() - started }
  }
  let slot: SlotRow | null = null
  while (env.nowMs() - started < env.caseTimeoutMs) {
    slot = await env.reader.slot(slotKey)
    if (slot && TERMINAL.has(slot.state)) break
    await env.nudge()
    await env.pause()
  }
  const ms = env.nowMs() - started
  if (!slot || !TERMINAL.has(slot.state)) {
    const cause = slot ? 'timed_out' : 'no_slot'
    const observed = { ok: false as const, cause: cause as 'timed_out' | 'no_slot', calls: [], fixed: null }
    return { id: c.id, group: c.group, verdict: grade(c, observed), observed, slotKey: slot?.slot_key ?? null, failure: null, resultText: null, ms }
  }
  const observed = await observe(env.reader, slot)
  return { id: c.id, group: c.group, verdict: grade(c, observed), observed, slotKey: slot.slot_key, failure: slot.failure, resultText: slot.result_text, ms }
}

/**
 * Every case in order, one at a time. `onCase` gets the file after each case, so a crash keeps the finished ones; a run of
 * fewer cases than the set is `partial` and never meets the threshold.
 */
export async function runAll(
  env: RunnerEnv, cases: readonly MorningCaseMeta[], meta: { date: string; sha: string; model: string }, onCase?: (file: ResultFile) => void,
): Promise<ResultFile> {
  const results: CaseResult[] = []
  const file = (): ResultFile => ({ ...meta, summary: summarise(results.map(r => ({ id: r.id, group: r.group, pass: r.verdict.pass })), META), cases: [...results] })
  for (const c of cases) {
    results.push(await runCase(env, c))
    onCase?.(file())
  }
  return file()
}
