// The result file (p4-w3.md section 6): `results/<date>-<sha>.json`, never deleted and never overwritten (a second run of the
// same sha on the same day gets a suffix). Each case keeps its verdict, what it observed, the normaliser's counts and the
// `invalid_result` cause, so the orchestrator sees whether failures are length misses (Opus R2-5).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Observed, Summary, Verdict } from './grade.ts'

export interface CaseResult {
  id: string
  group: 'graded' | 'clean' | 'outage'
  verdict: Verdict
  observed: Observed | { ok: false; cause: string; calls: string[]; fixed: null }
  slotKey: string | null
  failure: string | null
  resultText: string | null
  ms: number
  /** Remote mode: the API model id the case's slot was submitted with (door.ts model), when the slot exists. */
  ranOn?: string
  /** A timed-out case only: whether its manual slot reached a terminal state before the next case (false: the next Run now meets `run_open`). */
  settled?: boolean
}

export interface ResultFile {
  date: string
  sha: string
  /** The model the run was asked for (--model). In remote mode every case's `ranOn` must be it, else the case fails and the run stops. */
  model: string
  summary: Summary
  cases: CaseResult[]
  /** The cases a stopped run never ran (empty for a run that went through). */
  notRun: string[]
  /** Set when the run stopped early: where and why. */
  stopped?: { at: string; reason: string }
}

/** `<dir>/<date>-<sha>.json`, or `<date>-<sha>-2.json` and on when it exists: a result is never overwritten. */
export function resultPath(dir: string, date: string, sha: string, exists: (p: string) => boolean = existsSync): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('results: the date is YYYY-MM-DD and the sha hex')
  for (let n = 1; ; n++) {
    const p = join(dir, `${date}-${sha}${n === 1 ? '' : `-${n}`}.json`)
    if (!exists(p)) return p
  }
}

/**
 * A run's own file, created once (never over another run's) and rewritten after each case, so a crash part way keeps the
 * cases that finished. `write` is the only writer of that path.
 */
export function openResults(dir: string, date: string, sha: string): { path: string; write(file: ResultFile): void } {
  mkdirSync(dir, { recursive: true })
  const path = resultPath(dir, date, sha)
  let created = false
  return {
    path,
    write(file) {
      writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { flag: created ? 'w' : 'wx' })
      created = true
    },
  }
}

export function writeResults(dir: string, file: ResultFile): string {
  const out = openResults(dir, file.date, file.sha)
  out.write(file)
  return out.path
}
