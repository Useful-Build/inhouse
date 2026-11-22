// The six daily checks (P8a K). Each judges one facet of a day's evidence: absent facet or no evidence is `missing`,
// a wrong one `unclean`, and only a present, right one `clean`. A budget-skipped morning check is `missing`.
import { CHECK_NAMES } from './types.ts'
import type { Checks, CheckResult, DayEvidence } from './types.ts'

const clean = (detail: string): CheckResult => ({ status: 'clean', detail })
const unclean = (detail: string): CheckResult => ({ status: 'unclean', detail })
const missing = (detail: string): CheckResult => ({ status: 'missing', detail })

export function morningCheck(e: DayEvidence): CheckResult {
  if (e.morning === null) return missing('the morning check slots could not be read')
  const scheduled = e.morning.slots.filter(s => s.kind === 'scheduled')
  if (scheduled.length === 0) return missing('no morning check slot was due this day')
  const ok = scheduled.filter(s => s.state === 'ended' && s.failure === null && s.outcome === 'done')
  if (ok.length > 0) return clean('the morning check ended with a validated result')
  const ranOrFailed = scheduled.filter(s => s.state !== 'skipped')
  if (ranOrFailed.length === 0) return missing(`the morning check was skipped (${scheduled[0]?.reason ?? 'no reason'})`)
  const f = ranOrFailed.find(s => s.failure !== null)?.failure
  return unclean(f ? `the morning check failed: ${f}` : `the morning check did not end ok (${ranOrFailed[0]?.state})`)
}

export function bellNotices(e: DayEvidence): CheckResult {
  const b = e.bell
  if (b === null) return missing('the notices could not be read')
  const found = new Set(b.failedNoticeIds)
  const lost = b.expectedIds.filter(id => !found.has(id)).length
  const expected = new Set(b.expectedIds)
  const doubled = b.failedNoticeIds.filter(id => !expected.has(id)).length + Math.max(0, b.morningNotices - b.morningEnded)
  if (lost > 0 || doubled > 0) return unclean(`${lost} lost, ${doubled} doubled`)
  return clean(`${b.expectedIds.length} alert notice${b.expectedIds.length === 1 ? '' : 's'}, each exactly once`)
}

// TODO(P6a): `teamFactsUnapproved` is null until line B's P6a memory-approval table/status exists; collect.ts's
// `readTeamFactsUnapproved` must then count the day's team facts that were active without an approval. Until then this
// check is pending, which is not clean.
export function memory(e: DayEvidence): CheckResult {
  const m = e.memory
  if (m === null) return missing('the memories could not be read')
  if (m.learnOffSaves > 0) return unclean(`${m.learnOffSaves} fact${m.learnOffSaves === 1 ? '' : 's'} saved while Learn from my chats was off`)
  if (m.teamFactsUnapproved === null) return { status: 'pending', detail: 'waits for P6a\'s memory approval table' }
  if (m.teamFactsUnapproved > 0) return unclean(`${m.teamFactsUnapproved} team fact${m.teamFactsUnapproved === 1 ? '' : 's'} active without approval`)
  return clean('no fact saved against the setting, team facts waited for approval')
}

export function connectorReads(e: DayEvidence): CheckResult {
  const c = e.connectors
  if (c === null) return missing('the connector reads could not be read')
  if (c.failedReads > 0) return unclean(`${c.failedReads} morning check${c.failedReads === 1 ? '' : 's'} could not read the store`)
  if (c.readCalls === 0) return missing('no connector read happened this day')
  return clean(`${c.readCalls} read${c.readCalls === 1 ? '' : 's'} succeeded`)
}

export function failedRuns(e: DayEvidence): CheckResult {
  if (e.runs === null) return missing('the routine slots could not be read')
  if (e.runs.stuck > 0) return unclean(`${e.runs.stuck} slot${e.runs.stuck === 1 ? '' : 's'} stuck past the deadline`)
  return clean('no stuck slot')
}

export function guards(e: DayEvidence): CheckResult {
  const g = e.guards
  if (g === null) return missing('the guard evidence could not be read')
  if (g.webfetchBypass > 0 || g.leaks > 0) return unclean(`${g.webfetchBypass} unlisted fetch${g.webfetchBypass === 1 ? '' : 'es'}, ${g.leaks} leak${g.leaks === 1 ? '' : 's'}`)
  return clean('no unlisted fetch, no canary-like text in notices')
}

const BY_NAME = { morning_check: morningCheck, bell_notices: bellNotices, memory, connector_reads: connectorReads, failed_runs: failedRuns, guards } as const

export function runChecks(e: DayEvidence): Checks {
  return Object.fromEntries(CHECK_NAMES.map(n => [n, BY_NAME[n](e)])) as Checks
}
