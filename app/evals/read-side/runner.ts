// The read-side run loop: one model per dispatch, every case once, never retried, sequential. A target answers a case with what the
// run left behind (a `ReadSideRun`); the grader judges it. Pending cases a target can't serve are "not run", never passed.
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

export async function runReadSide(o: { target: ReadSideTarget; cases: readonly ReadSideCase[]; budgetUsd: number | null }): Promise<RunResult> {
  const result: RunResult = { outcomes: [], notRun: [], stopped: null, spentUsd: 0 }
  for (const c of o.cases) {
    if (result.stopped) {
      result.notRun.push({ id: c.id, reason: `the run stopped at ${result.stopped.at}` })
      continue
    }
    if (c.pending !== undefined && o.target.honorsPending) {
      result.notRun.push({ id: c.id, reason: gradeReadSide(c, NO_RUN).reasons[0]! })
      continue
    }
    if (o.budgetUsd !== null && result.spentUsd >= o.budgetUsd) {
      result.stopped = { at: c.id, reason: 'budget', detail: `spent $${result.spentUsd.toFixed(2)} of $${o.budgetUsd}` }
      result.notRun.push({ id: c.id, reason: `the run stopped at ${c.id}` })
      continue
    }
    try {
      const { run, costUsd } = await o.target.run(c)
      result.spentUsd += costUsd
      // The fake serves a pending case; it is graded as if it were live (the report marks the run a dry run).
      const { pending: _pending, ...live } = c
      result.outcomes.push({ id: c.id, verdict: gradeReadSide(live, run), costUsd })
    } catch (e) {
      result.stopped = { at: c.id, reason: 'infrastructure', detail: e instanceof Error ? e.message : String(e) }
      result.notRun.push({ id: c.id, reason: `the run stopped at ${c.id}` })
    }
  }
  return result
}
