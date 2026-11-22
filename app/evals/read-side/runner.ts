// The read-side run loop: one model per dispatch, every case once, never retried, sequential. A target answers a case with what the
// run left behind (a `ReadSideRun`); the grader judges it. Pending cases a target can't serve are "not run", never passed.
import { estimateUsd as chatEstimate } from '../runner.ts'
import { gradeReadSide } from './grade.ts'
import type { Verdict, ReadSideRun } from './grade.ts'
import type { ReadSideCase } from './cases.ts'

export interface ReadSideTarget {
  readonly name: 'fake' | 'product'
  /** True when this target can't serve a case that waits on P5, W3 or the page host: it reports it "not run". The fake serves all. */
  readonly honorsPending: boolean
  /** Runs one case and returns what it left behind plus its spend in USD. A throw is an infrastructure failure: the run stops. */
  run(c: ReadSideCase): Promise<{ run: ReadSideRun; costUsd: number }>
  close?(): Promise<void>
}

/** The checks that say the run could not be observed or judged, not that the agent did something. */
export const OBSERVATION_CHECKS: ReadonlySet<string> = new Set(['ran', 'exposed', 'observed'])
export const INFRA = 'not run (infrastructure)'

export interface CaseOutcome { id: string; verdict: Verdict; costUsd: number }
export interface RunResult {
  outcomes: CaseOutcome[]
  /** Cases never run: pending ones the target can't serve, and those after a stop. */
  notRun: { id: string; reason: string }[]
  stopped: { at: string; reason: 'budget' | 'infrastructure'; detail: string } | null
  spentUsd: number
}

/** The grader's own "not run" verdict for a pending case: nothing is graded, so the run is irrelevant. */
const NO_RUN: ReadSideRun = { ended: false, exposed: null, calls: null, webFetchUrls: null, memoryTexts: null, noticeTexts: null, routineTexts: null, teamRequestTexts: null, files: null }

export interface RunOptions {
  target: ReadSideTarget
  cases: readonly ReadSideCase[]
  budgetUsd: number | null
  /** A case's estimated cost (default: the product's per-chat estimate; the fake costs nothing). */
  estimateUsd?: (c: ReadSideCase) => number
  /** Called as each case ends (a pass, a fail, or not run), so a stopped run keeps what it did. */
  onCase?: (entry: { id: string; status: 'pass' | 'fail' | 'not run'; reasons: string[]; costUsd: number }) => void
}

export async function runReadSide(o: RunOptions): Promise<RunResult> {
  const estimate = o.estimateUsd ?? ((c: ReadSideCase) => (o.target.name === 'fake' ? 0 : chatEstimate([c], 1)))
  const notRun = (id: string, reason: string) => {
    result.notRun.push({ id, reason })
    o.onCase?.({ id, status: 'not run', reasons: [reason], costUsd: 0 })
  }
  const result: RunResult = { outcomes: [], notRun: [], stopped: null, spentUsd: 0 }
  for (const c of o.cases) {
    if (result.stopped) {
      notRun(c.id, `the run stopped at ${result.stopped.at}`)
      continue
    }
    if (c.pending !== undefined && o.target.honorsPending) {
      notRun(c.id, gradeReadSide(c, NO_RUN).reasons[0]!)
      continue
    }
    if (o.budgetUsd !== null && result.spentUsd + estimate(c) > o.budgetUsd) {
      result.stopped = { at: c.id, reason: 'budget', detail: `spent $${result.spentUsd.toFixed(2)} and the next case would cost about $${estimate(c).toFixed(2)} of $${o.budgetUsd}` }
      notRun(c.id, `the run stopped at ${c.id}`)
      continue
    }
    try {
      const { run, costUsd } = await o.target.run(c)
      result.spentUsd += costUsd
      // Only the fake serves a pending case, so only there is it graded as if live (the report marks the run a dry run).
      const { pending: _pending, ...live } = c
      const verdict = gradeReadSide(o.target.name === 'fake' ? live : c, run)
      const failed = Object.entries(verdict.checks).filter(([, ok]) => !ok).map(([k]) => k)
      if (verdict.notRun) {
        notRun(c.id, verdict.reasons[0]!)
      } else if (!verdict.pass && failed.every((k) => OBSERVATION_CHECKS.has(k))) {
        // Nothing the agent did: the run could not be observed or ended early. It is infrastructure, never a bypass.
        notRun(c.id, `${INFRA}: ${verdict.reasons.join('; ')}`)
      } else {
        result.outcomes.push({ id: c.id, verdict, costUsd })
        o.onCase?.({ id: c.id, status: verdict.pass ? 'pass' : 'fail', reasons: verdict.reasons, costUsd })
      }
      if (o.budgetUsd !== null && result.spentUsd > o.budgetUsd) {
        result.stopped = { at: c.id, reason: 'budget', detail: `spent $${result.spentUsd.toFixed(2)}, over the budget $${o.budgetUsd}` }
      }
    } catch (e) {
      result.stopped = { at: c.id, reason: 'infrastructure', detail: e instanceof Error ? e.message : String(e) }
      notRun(c.id, `the run stopped at ${c.id}`)
    }
  }
  return result
}
