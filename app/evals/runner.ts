// Runs cases against a target: a session per case-repeat, a per-chat timeout, no retries, a hard budget.
import { makeCanary } from './cases.ts'
import { CAPABILITY_IDS, gradeCapabilityEndState } from './capability/grade.ts'
import { gradeExfil } from './exfil.ts'
import { gradeChat } from './grade.ts'
import { GRADED_PROMPT_VERSION } from './prompt-version.ts'
import { redactText } from './redact.ts'
import { toRow, type Row } from './report.ts'
import { CapReachedError, type Case, type ChatResult, type Target } from './types.ts'

/** S5's measured price: about $0.011 a chat on Sonnet 5.5 at medium effort. */
export const S5_USD_PER_CHAT = 0.011
/**
 * The cap check's per-chat estimate: the ledger's $0.25 start hold (server/usage/ledger.ts START_HOLD_MICRO, pinned by a
 * test). The product refuses a turn unless that much room is free, so a lower estimate would let a case start that the
 * product then fences (#253 review O5).
 */
export const CAP_CHAT_USD = Math.max(S5_USD_PER_CHAT, 0.25)
export const CHAT_TIMEOUT_MS = 240_000

export const estimateUsd = (cases: Case[], reps: number): number => cases.reduce((n, c) => n + c.chats.length, 0) * reps * S5_USD_PER_CHAT

export interface RunOptions {
  target: Target
  cases: Case[]
  reps: number
  concurrency: number
  /** Stop before the next chat once spent >= budget. Chats already in flight finish, so a concurrent run can overshoot by them. */
  budgetUsd?: number
  chatTimeoutMs?: number
  /** Called after each chat, graded, before the next one starts. */
  /** Each graded chat; `canary` (the case-repeat's, exfiltration cases only) so a writer can redact it. */
  onChat?: (row: Row, result: ChatResult | null, canary?: string) => void
}

export interface RunOutput {
  rows: Row[]
  notRun: { id: string; needs: string[] }[]
  /** Cases the target can't grade (its API doesn't show a field the case needs): not run, with the reason. */
  notGraded: { id: string; why: string }[]
  stoppedByBudget: boolean
  /** A chat's cost could not be read: the run stopped there, because the budget can't be enforced on spend it can't see. */
  costUnknown: boolean
  /**
   * The brand's Spending cap stopped the run (O2 note): a case whose estimate would cross it was never started, or a chat
   * was fenced by it. Either way `stoppedByBudget` is true, so the verdict is FAIL (the numbers are partial).
   */
  capStop?: { caseId: string; rep: number; why: 'would cross the cap' | 'cap reached' | 'cap check failed'; spentUsd?: number; capUsd?: number; estimateUsd?: number; detail?: string }
  /**
   * A seed, the chat loop (grading, the row, onChat's writes) or a reset that threw: the run stopped there, and the report
   * still gets written (and fails).
   */
  harnessStop?: { caseId: string; rep: number; stage: 'seed' | 'chat-loop' | 'reset'; detail: string }
  spentUsd: number
}

async function withTimeout(run: (signal: AbortSignal) => Promise<ChatResult>, ms: number): Promise<ChatResult> {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timeout after ${ms} ms`))
      ac.abort()
    }, ms)
  })
  try {
    return await Promise.race([run(ac.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}

export async function runEvals(o: RunOptions): Promise<RunOutput> {
  const { target } = o
  const notRun: RunOutput['notRun'] = []
  const notGraded: RunOutput['notGraded'] = []
  const runnable: Case[] = []
  for (const c of o.cases) {
    const missing = (c.needs ?? []).filter((n) => !target.provides.has(n))
    if (missing.length > 0) notRun.push({ id: c.id, needs: c.needs! })
    else if (target.canRun && !target.canRun(c)) notRun.push({ id: c.id, needs: ['fixture-replay'] })
    else if (target.unobservable?.(c)) notGraded.push({ id: c.id, why: target.unobservable(c)! })
    else runnable.push(c)
  }

  const rows: Row[] = []
  let summed = 0
  let stopped = false
  let costUnknown = false
  let capStop: RunOutput['capStop']
  let harnessStop: RunOutput['harnessStop']
  // report.json and the README are kept in a public repo and CI logs (#280 review 2): the first line, URLs dropped, the
  // canary redacted, 200 characters at most. Harness errors name what and the status, never a response body.
  const detailOf = (e: unknown, canary?: string): string => {
    const line = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.replace(/\bhttps?:\/\/\S+/gi, '[url]')
    return redactText(line, canary).slice(0, 200)
  }
  const spent = (): number => target.spentUsd?.() ?? summed
  // The exfiltration cases go first: a budget stop must never leave them unrun while cheaper cases did.
  const ordered = [...runnable.filter((c) => c.cat === 'exfil'), ...runnable.filter((c) => c.cat !== 'exfil')]
  const queue = ordered.flatMap((c) => Array.from({ length: o.reps }, (_, i) => ({ c, rep: i + 1 })))

  async function caseRepeat(c: Case, rep: number): Promise<void> {
    if (stopped) return
    const canary = makeCanary(c.id, rep)
    // A seed or reset that throws stops the run where it is, never crashes it: run.ts still writes the report, which fails
    // (the first paid baseline died with no report on a reset's 401).
    let session: Awaited<ReturnType<Target['seed']>>
    try {
      session = await target.seed(c.seed ?? [], { caseId: c.id, rep, canary }, c.exfil)
    } catch (e) {
      // A seed that throws partway leaves no session to reset: the run stops here (the product target's own seed puts the
      // brand's WebFetch list back and releases the brand before it rethrows).
      harnessStop ??= { caseId: c.id, rep, stage: 'seed', detail: detailOf(e, canary) }
      stopped = true
      return
    }
    let settledSoFar = 0
    try {
      // Another case-repeat stopped the run while this one waited for the brand (#253 review O4).
      if (stopped) return
      // The month's room under the brand's Spending cap, read after the seed (#253 review O1, O2): the target's setup has
      // pinned the cap, its lock is held and the case-repeat before has ended, so this is the cap we pinned and settled
      // spend. A failed read (route 42 down, the cap no longer $50) stops the run with a report (O3, O6).
      if (target.room) {
        let room: { spentUsd: number; capUsd: number }
        try {
          room = await target.room()
        } catch (e) {
          capStop ??= { caseId: c.id, rep, why: 'cap check failed', detail: e instanceof Error ? e.message : String(e) }
          stopped = true
          return
        }
        const estimate = c.chats.length * CAP_CHAT_USD
        if (room.spentUsd + estimate > room.capUsd) {
          capStop ??= { caseId: c.id, rep, why: 'would cross the cap', spentUsd: room.spentUsd, capUsd: room.capUsd, estimateUsd: estimate }
          stopped = true
          return
        }
      }
      for (const [i, chat] of c.chats.entries()) {
        // After any stop, nothing more is sent (#253 review O4).
        if (stopped) return
        if (o.budgetUsd !== undefined && spent() >= o.budgetUsd) {
          stopped = true
          return
        }
        let result: ChatResult | null = null
        let err: string | undefined
        try {
          result = await withTimeout((signal) => session.chat(chat.prompt, { signal }), o.chatTimeoutMs ?? CHAT_TIMEOUT_MS)
        } catch (e) {
          err = e instanceof Error ? e.message : String(e)
          if (e instanceof CapReachedError) {
            capStop ??= { caseId: c.id, rep, why: 'cap reached' }
            stopped = true
          }
        }
        // A chat that timed out or threw has no result, but the server booked what it spent: ask the session for that figure.
        let costUsd = result?.costUsd ?? 0
        if (result === null && session.settledCostUsd) {
          // Never a silent $0: a failed read keeps the last known figure and says so on the row.
          try {
            const settled = await session.settledCostUsd()
            costUsd = Math.max(0, settled - settledSoFar)
            settledSoFar = settled
          } catch (e) {
            err = `${err ? `${err}; ` : ''}cost unknown: ${e instanceof Error ? e.message : String(e)}`
            costUnknown = true
          }
        } else if (session.settledCostUsd) settledSoFar += costUsd
        summed += costUsd
        const g = gradeChat(chat.expect, result, target.people, { openSchema: target.openSchema })
        if (CAPABILITY_IDS.has(c.id)) {
          const cap = result ? gradeCapabilityEndState(c.id, result) : { pass: false, reason: 'no_result' }
          g.checks.capability = cap.pass
          g.pass &&= cap.pass
          if (!cap.pass && !err && cap.reason) err = `capability check failed: ${cap.reason}`
        }
        const exfil = c.exfil && result ? gradeExfil(c.exfil, result, canary) : undefined
        // A chat that ran but ended without an answer says why on its row (the first full baseline's X01 had err null).
        // A turn not sent the system prompt v3, or whose prompt named no store (P5, #337), says so instead.
        if (!err && result && !result.runOk) {
          const f = result.failure ?? 'unknown'
          err = f.startsWith('prompt_version:') ? `the turn was not sent the system prompt v${GRADED_PROMPT_VERSION}: ${f}`
            : f.startsWith('prompt_apps:') ? `the turn's prompt did not name Shopify as connected: ${f}`
            : `the turn ended without an answer: ${f}`
        }
        const row = toRow(c, rep, i + 1, result, g, { exfil, canary: c.exfil ? canary : undefined, err, costUsd })
        rows.push(row)
        o.onChat?.(row, result, c.exfil ? canary : undefined)
        // Fail closed: spend that can't be read can't be held to the budget, so nothing else runs.
        if (costUnknown) {
          stopped = true
          return
        }
        // The cap fenced this chat: its row says so, and nothing else runs.
        if (capStop) return
      }
    } catch (e) {
      // Anything else in the case-repeat (grading, the row, onChat's file writes) stops the run with a report (#280 review 1).
      harnessStop ??= { caseId: c.id, rep, stage: 'chat-loop', detail: detailOf(e, canary) }
      stopped = true
    } finally {
      try {
        await session.reset()
      } catch (e) {
        harnessStop ??= { caseId: c.id, rep, stage: 'reset', detail: detailOf(e, canary) }
        stopped = true
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, o.concurrency) }, async () => {
    for (;;) {
      if (stopped) return
      const t = queue.shift()
      if (!t) return
      // Never rejects Promise.all (the other workers would keep spending with no report): caseRepeat catches its own, and
      // this is the backstop.
      try {
        await caseRepeat(t.c, t.rep)
      } catch (e) {
        harnessStop ??= { caseId: t.c.id, rep: t.rep, stage: 'chat-loop', detail: detailOf(e) }
        stopped = true
      }
    }
  })
  await Promise.all(workers)
  rows.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.rep - b.rep || a.chat - b.chat)
  return { rows, notRun, notGraded, stoppedByBudget: stopped, costUnknown, spentUsd: spent(), ...(capStop ? { capStop } : {}), ...(harnessStop ? { harnessStop } : {}) }
}
