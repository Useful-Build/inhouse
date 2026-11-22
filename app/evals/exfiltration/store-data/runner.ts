// The store-data set's run loop (p4-w6.md section 6), over the morning-check runner's seams: per case, point the product Worker
// at the case's shop, press Run now on the morning check, poll its manual slot to the end (a deadline, no fixed sleeps), read
// what it left behind, grade it. Everything outside is injected (`StoreDataEnv`), so a unit test drives it with fakes. The
// orchestrator runs it with the morning-check set on Sonnet 5.5 at medium and keeps the results (`evals` skill).
import { ROUTINE_ID, TERMINAL, observe } from '../../morning-check/runner.ts'
import type { Reader, RunnerEnv, SlotRow } from '../../morning-check/runner.ts'
import { STORE_DATA_CASES, hostOf } from './cases.ts'
import type { StoreDataCase } from './cases.ts'
import { gradeSet, gradeStoreData } from './grade.ts'
import { GRADED_PROMPT_VERSION, promptReason } from '../../prompt-version.ts'
import type { SetResult, StoreDataRun, Verdict } from './grade.ts'

/** The morning-check reader plus what this set needs beyond its tool names. */
export interface StoreDataReader extends Reader {
  /** The URL of every WebFetch a turn made (the egress log's lines), or null when no log is read. */
  webFetchUrls(turnId: string): Promise<string[] | null>
  /** The text of the memory rows created at or after `sinceMs`, or null when none are read. */
  memoryTexts(sinceMs: number): Promise<string[] | null>
  /**
   * Whether the case's canary is in the run's transcript (R2): the local reader takes the objects written at or after
   * `sinceMs`, the remote one the slot's own chat (`slotKey`); null when no transcript can be read.
   */
  canarySeen(canary: string, sinceMs: number, slotKey: string): Promise<boolean | null>
  /** How many routines were created at or after `sinceMs`. */
  routinesCreated(sinceMs: number): Promise<number>
}
export type StoreDataEnv = Omit<RunnerEnv, 'reader'> & { reader: StoreDataReader }

/**
 * `settled`: set only for a case that timed out with its slot open: whether the slot then reached a terminal state (else the
 * next Run now would be `run_open`). `ranOn`: the API model id the slot was submitted with (remote mode, `modelOf`). `prompt`:
 * the system prompt version its turn was sent (remote mode, `promptOf`; P5 #337).
 */
export interface CaseOutcome { id: string; verdict: Verdict; slotKey: string | null; ms: number; settled?: boolean; ranOn?: string; prompt?: number | 'missing' }

/** What the slot left, as the grader reads it. */
export async function observeRun(reader: StoreDataReader, slot: SlotRow, sinceMs: number, canary: string): Promise<StoreDataRun> {
  const seen = await observe(reader, slot)
  return {
    ended: seen.ok,
    exposed: await reader.canarySeen(canary, sinceMs, slot.slot_key),
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
    verdict: { pass: false, checks: { ran: false, exposed: false, noOutsideFetch: true, noNotification: true, noPlantedMemory: true, noRoutine: true, noRepeat: true }, reasons: [reason] },
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
  if (!slot || !TERMINAL.has(slot.state)) {
    // A slot that began but never ended would answer the next Run now `run_open`: wait (with a deadline) for it to settle, as the
    // morning-check runner does.
    let settled = true
    if (slot) {
      const until = env.nowMs() + env.settleMs
      let now: SlotRow | null = slot
      while (now && !TERMINAL.has(now.state) && env.nowMs() < until) {
        await env.nudge()
        await env.pause()
        now = await env.reader.slot(slotKey)
      }
      settled = now !== null && TERMINAL.has(now.state)
    }
    return { ...fail(slot ? 'timed_out' : 'no_slot', slot?.slot_key ?? null), ...(slot ? { settled } : {}) }
  }
  // "Since the case began" is the slot's claim time, on the build's own clock (the rows' times are the build's, not the runner's).
  const verdict = gradeStoreData(c, await observeRun(env.reader, slot, slot.claimed_at_ms, c.canary))
  return { id: c.id, verdict, slotKey: slot.slot_key, ms: env.nowMs() - started }
}

/**
 * Every case in order, one at a time; `onCase` sees the outcomes so far after each, so a crash keeps the finished ones. A case that
 * timed out and whose slot doesn't settle leaves it open for up to 45 minutes, so every later Run now would be refused: the run
 * stops there and lists the rest as `notRun` (the set then has fewer cases than it needs and cannot pass).
 * The remote mode's hooks, as the morning-check runner's runAll takes them: `releaseShop` before the first case and after every
 * case (a case that throws still clears, then fails loud; an override that won't clear after a case stops the run),
 * `beforeCases` once, `beforeCase` before each (a reason or a failure stops the run there), and `modelOf` with `model`: a case
 * whose slot ran on another model fails and stops the run.
 */
export async function runStoreData(
  env: StoreDataEnv, cases: readonly StoreDataCase[] = STORE_DATA_CASES, onCase?: (done: CaseOutcome[]) => void, model?: string,
): Promise<{ outcomes: CaseOutcome[]; set: SetResult; notRun: string[]; stopped?: string }> {
  const outcomes: CaseOutcome[] = []
  let stopped: string | undefined
  const said = (e: unknown) => (e instanceof Error ? e.message : String(e))
  await env.releaseShop?.()
  await env.beforeCases?.()
  for (const c of cases) {
    let halt: string | null = null
    try {
      halt = (await env.beforeCase?.()) ?? null
    } catch (e) {
      halt = `the graded run's check failed: ${said(e)}`
    }
    if (halt !== null) {
      stopped = `before ${c.id}: ${halt}`
      onCase?.([...outcomes])
      break
    }
    let o: CaseOutcome
    try {
      o = await runStoreDataCase(env, c)
      // P5 #337: the turn must have been sent the current system prompt (evals/prompt-version.ts), else the case fails.
      const sent = o.slotKey !== null && env.promptOf ? await env.promptOf(o.slotKey) : null
      if (sent !== null) {
        o = { ...o, prompt: sent }
        if (sent !== GRADED_PROMPT_VERSION) o = { ...o, verdict: { ...o.verdict, pass: false, reasons: [promptReason(sent), ...o.verdict.reasons] } }
      }
      const ranOn = o.slotKey !== null && env.modelOf ? await env.modelOf(o.slotKey) : null
      if (ranOn !== null) {
        o = { ...o, ranOn }
        if (model !== undefined && ranOn !== model) {
          o = { ...o, verdict: { ...o.verdict, pass: false, reasons: [`ran on ${ranOn}, not ${model}`, ...o.verdict.reasons] } }
          stopped = `${c.id} ran on ${ranOn}, not ${model} (the brand's Default model decides a routine's model), so the run stops here`
        }
      }
    } catch (e) {
      // The case itself threw (the door, R2 or the build failed): clear the override, then fail loud with both causes.
      try {
        await env.releaseShop?.()
      } catch (unclear) {
        throw new Error(`${said(e)}; and the test shop override could not be cleared: ${said(unclear)}`, { cause: e })
      }
      throw e
    }
    let unclear: string | null = null
    try {
      await env.releaseShop?.()
    } catch (e) {
      unclear = said(e)
    }
    outcomes.push(o)
    if (o.settled === false) stopped = `${c.id} timed out and its slot (${o.slotKey}) is still open: every later Run now would answer run_open, so the run stops here`
    if (unclear !== null) stopped = `${c.id}: the test shop override could not be cleared (${unclear}), so the run stops here`
    onCase?.([...outcomes])
    if (stopped) break
  }
  return { outcomes, set: gradeSet(STORE_DATA_CASES, Object.fromEntries(outcomes.map(o => [o.id, o.verdict]))), notRun: stopped ? cases.slice(outcomes.length).map(c => c.id) : [], ...(stopped ? { stopped } : {}) }
}
