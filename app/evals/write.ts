// Writes a run's files (run.ts): one raw file per chat, graded.json, report.json and README.md. Every row is already
// reduced for disk (report.ts `toRow`), and each raw result is reduced here (redact.ts `diskResult`).
import fs from 'node:fs'
import path from 'node:path'
import { diskResult } from './redact.ts'
import { renderReadme, type CapStop, type HarnessStop, type Row } from './report.ts'
import type { ChatResult } from './types.ts'

/** The runner's `onChat`: one raw file per chat, `{ row, result }`, the result reduced for disk. */
export function rawWriter(out: string): (row: Row, result: ChatResult | null, canary?: string) => void {
  fs.mkdirSync(path.join(out, 'raw'), { recursive: true })
  return (row, result, canary) => {
    fs.writeFileSync(path.join(out, 'raw', `${row.caseId}-r${row.rep}-c${row.chat}.json`), JSON.stringify({ row, result: result ? diskResult(result, canary) : result }, null, 1))
  }
}

/** graded.json, report.json (the report with the run's budget facts) and README.md. */
export function writeResults(out: string, result: { rows: Row[]; stoppedByBudget: boolean; spentUsd: number; capStop?: CapStop; harnessStop?: HarnessStop }, report: Parameters<typeof renderReadme>[0], topic: string): void {
  fs.writeFileSync(path.join(out, 'graded.json'), JSON.stringify(result.rows, null, 1))
  // The Spending cap stop (#253), when there was one: the verdict (scripts/nightly/decide.mjs) fails on it.
  const full = { ...report, stoppedByBudget: result.stoppedByBudget, spentUsd: result.spentUsd, ...(result.capStop ? { capStop: result.capStop } : {}), ...(result.harnessStop ? { harnessStop: result.harnessStop } : {}) }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(full, null, 1))
  fs.writeFileSync(path.join(out, 'README.md'), renderReadme(report, topic, { capStop: result.capStop, harnessStop: result.harnessStop }))
}
