// The store-data set's run loop (p4-w6.md section 6), over the morning-check runner's seams: per case, point the product Worker
// at the case's shop, press Run now on the morning check, poll its manual slot to the end (a deadline, no fixed sleeps), read
// what it left behind, grade it. Everything outside is injected (`StoreDataEnv`), so a unit test drives it with fakes. The
// orchestrator runs it with the morning-check set on Sonnet 5.5 at medium and keeps the results (`evals` skill).
import { ROUTINE_ID, TERMINAL, observe } from '../../morning-check/runner.ts'
import type { Reader, RunnerEnv, SlotRow } from '../../morning-check/runner.ts'
import { STORE_DATA_CASES, hostOf } from './cases.ts'
import type { StoreDataCase } from './cases.ts'
import { gradeSet, gradeStoreData } from './grade.ts'
import type { SetResult, StoreDataRun, Verdict } from './grade.ts'

/** The morning-check reader plus what this set needs beyond its tool names. */
export interface StoreDataReader extends Reader {
  /** The URL of every WebFetch a turn made (the egress log's lines), or null when no log is read. */
  webFetchUrls(turnId: string): Promise<string[] | null>
  /** The text of the memory rows created at or after `sinceMs`, or null when none are read. */
  memoryTexts(sinceMs: number): Promise<string[] | null>
  /** How many routines were created at or after `sinceMs`. */
  routinesCreated(sinceMs: number): Promise<number>
}
export type StoreDataEnv = Omit<RunnerEnv, 'reader'> & { reader: StoreDataReader }

export interface CaseOutcome { id: string; verdict: Verdict; slotKey: string | null; ms: number }

/** What the slot left, as the grader reads it. */
export async function observeRun(reader: StoreDataReader, slot: SlotRow, sinceMs: number): Promise<StoreDataRun> {
  const seen = await observe(reader, slot)
  return {
    ended: seen.ok,
    calls: seen.calls,
    webFetchUrls: slot.turn_id === null ? [] : await reader.webFetchUrls(slot.turn_id),
    memoryTexts: await reader.memoryTexts(sinceMs),
    routinesCreated: await reader.routinesCreated(sinceMs),
    items: await reader.items(slot.slot_key),
  }
}

export async function runStoreDataCase(env: StoreDataEnv, c: StoreDataCase): Promise<CaseOutcome> {
  const started = env.nowMs()
  await env.useShop(hostOf(c.id))
  const clientKey = env.newKey()
  const slotKey = `now|${ROUTINE_ID}|${clientKey}`
  const fail = (reason: string, slot: string | null): CaseOutcome => ({
    id: c.id, slotKey: slot, ms: env.nowMs() - started,
    verdict: { pass: false, checks: { ran: false, noOutsideFetch: true, noNotification: true, noPlantedMemory: true, noRoutine: true, noRepeat: true }, reasons: [reason] },
  })
  try {
    await env.trigger(clientKey)
  } catch (e) {
    return fail(`trigger: ${e instanceof Error ? e.message : String(e)}`, slotKey)
  }
  let slot: SlotRow | null = null
  while (env.nowMs() - started < env.caseTimeoutMs) {
    slot = await env.reader.slot(slotKey)
    if (slot && TERMINAL.has(slot.state)) break
    await env.nudge()
    await env.pause()
  }
  if (!slot || !TERMINAL.has(slot.state)) return fail(slot ? 'timed_out' : 'no_slot', slot?.slot_key ?? null)
  const verdict = gradeStoreData(c, await observeRun(env.reader, slot, started))
  return { id: c.id, verdict, slotKey: slot.slot_key, ms: env.nowMs() - started }
}

/** Every case in order, one at a time; `onCase` sees the outcomes so far after each, so a crash keeps the finished ones. */
export async function runStoreData(env: StoreDataEnv, cases: readonly StoreDataCase[] = STORE_DATA_CASES, onCase?: (done: CaseOutcome[]) => void): Promise<{ outcomes: CaseOutcome[]; set: SetResult }> {
  const outcomes: CaseOutcome[] = []
  for (const c of cases) {
    outcomes.push(await runStoreDataCase(env, c))
    onCase?.([...outcomes])
  }
  return { outcomes, set: gradeSet(STORE_DATA_CASES, Object.fromEntries(outcomes.map(o => [o.id, o.verdict]))) }
}
