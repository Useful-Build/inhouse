// Runs cases against a target: a session per case-repeat, a per-chat timeout, no retries, a hard budget.
import { makeCanary } from './cases.ts'
import { gradeExfil } from './exfil.ts'
import { gradeChat } from './grade.ts'
import { toRow, type Row } from './report.ts'
import type { Case, ChatResult, Target } from './types.ts'

/** S5's measured price: about $0.011 a chat on Sonnet 5.5 at medium effort. */
export const S5_USD_PER_CHAT = 0.011
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
  onChat?: (row: Row, result: ChatResult | null) => void
}

export interface RunOutput {
  rows: Row[]
  notRun: { id: string; needs: string[] }[]
  /** Cases the target can't grade (its API doesn't show a field the case needs): not run, with the reason. */
  notGraded: { id: string; why: string }[]
  stoppedByBudget: boolean
  /** A chat's cost could not be read: the run stopped there, because the budget can't be enforced on spend it can't see. */
  costUnknown: boolean
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
  const spent = (): number => target.spentUsd?.() ?? summed
  // The exfiltration cases go first: a budget stop must never leave them unrun while cheaper cases did.
  const ordered = [...runnable.filter((c) => c.cat === 'exfil'), ...runnable.filter((c) => c.cat !== 'exfil')]
  const queue = ordered.flatMap((c) => Array.from({ length: o.reps }, (_, i) => ({ c, rep: i + 1 })))

  async function caseRepeat(c: Case, rep: number): Promise<void> {
    const canary = makeCanary(c.id, rep)
    const session = await target.seed(c.seed ?? [], { caseId: c.id, rep, canary }, c.exfil)
    let settledSoFar = 0
    try {
      for (const [i, chat] of c.chats.entries()) {
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
        const g = gradeChat(chat.expect, result, target.people)
        const exfil = c.exfil && result ? gradeExfil(c.exfil, result, canary) : undefined
        const row = toRow(c, rep, i + 1, result, g, { exfil, canary: c.exfil ? canary : undefined, err, costUsd })
        rows.push(row)
        o.onChat?.(row, result)
        // Fail closed: spend that can't be read can't be held to the budget, so nothing else runs.
        if (costUnknown) {
          stopped = true
          return
        }
      }
    } finally {
      await session.reset()
    }
  }

  const workers = Array.from({ length: Math.max(1, o.concurrency) }, async () => {
    for (;;) {
      if (stopped) return
      const t = queue.shift()
      if (!t) return
      await caseRepeat(t.c, t.rep)
    }
  })
  await Promise.all(workers)
  rows.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.rep - b.rep || a.chat - b.chat)
  return { rows, notRun, notGraded, stoppedByBudget: stopped, costUnknown, spentUsd: spent() }
}
