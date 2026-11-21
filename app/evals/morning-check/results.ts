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
  observed: Observed | { ok: false; cause: 'timed_out' | 'no_slot'; calls: string[]; fixed: null }
  slotKey: string | null
  failure: string | null
  resultText: string | null
  ms: number
}

export interface ResultFile {
  date: string
  sha: string
  model: string
  summary: Summary
  cases: CaseResult[]
}

/** `<dir>/<date>-<sha>.json`, or `<date>-<sha>-2.json` and on when it exists: a result is never overwritten. */
export function resultPath(dir: string, date: string, sha: string, exists: (p: string) => boolean = existsSync): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('results: the date is YYYY-MM-DD and the sha hex')
  for (let n = 1; ; n++) {
    const p = join(dir, `${date}-${sha}${n === 1 ? '' : `-${n}`}.json`)
    if (!exists(p)) return p
  }
}

export function writeResults(dir: string, file: ResultFile): string {
  mkdirSync(dir, { recursive: true })
  const path = resultPath(dir, file.date, file.sha)
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx' })
  return path
}
