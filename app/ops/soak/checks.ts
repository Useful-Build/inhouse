// The six daily checks (P8a K). Each judges one facet of a day's evidence: absent facet or no evidence is `missing`,
// a wrong one `unclean`, and only a present, right one `clean`. A budget-skipped morning check is `missing`, and so is
// a guards check whose evidence could not have failed (no planted canary, or an egress record that could not be read).
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
  const expected = new Set(b.expectedIds)
  // A failed end must have each of its notices; a morning slot that saved items must have exactly one, and none may have two.
  const lost = b.expectedIds.filter(id => !found.has(id)).length + b.morning.filter(m => m.items > 0 && m.notices === 0).length
  const doubled = b.failedNoticeIds.filter(id => !expected.has(id)).length + b.morning.filter(m => m.notices > 1).length + b.strayMorningNotices
  if (lost > 0 || doubled > 0) return unclean(`${lost} lost, ${doubled} doubled`)
  return clean(`${b.expectedIds.length} alert notice${b.expectedIds.length === 1 ? '' : 's'} and ${b.morning.filter(m => m.notices > 0).length} morning notice${b.morning.filter(m => m.notices > 0).length === 1 ? '' : 's'}, each exactly once`)
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

// `tool_calls` records the decision, not the outcome, so this counts allowed read calls; the morning check's own end
// (ended ok, not `not_connected` or `incomplete`) is the success evidence.
export function connectorReads(e: DayEvidence): CheckResult {
  const c = e.connectors
  if (c === null) return missing('the connector reads could not be read')
  if (c.failedReads > 0) return unclean(`${c.failedReads} morning check${c.failedReads === 1 ? '' : 's'} could not read the store`)
  if (c.readCalls === 0) return missing('no connector read was allowed this day')
  return clean(`${c.readCalls} allowed read call${c.readCalls === 1 ? '' : 's'} (the log records no outcome) and no morning check that failed to read`)
}

export function failedRuns(e: DayEvidence): CheckResult {
  const r = e.runs
  if (r === null) return missing('the routine slots could not be read')
  if (r.slots === 0) return missing('no routine slot was due this day')
  if (r.stuck > 0) return unclean(`${r.stuck} slot${r.stuck === 1 ? '' : 's'} stuck (claimed past its deadline, or started past the backstop)`)
  if (r.unrecovered > 0) return unclean(`${r.unrecovered} of ${r.failed} failed slot${r.failed === 1 ? '' : 's'} had no ok slot after it`)
  return clean(`${r.failed} failed slot${r.failed === 1 ? '' : 's'}, each followed by an ok one`)
}

// Clean needs evidence that could have failed, on both halves:
// - the leak scan can only find a canary that was planted. House data holds no eval canary, so a shape-only scan can't
//   fail: without planted canaries the check is missing (the onboarding step: plant one and pass its file as `--canary`);
// - the egress record (P8a, `egress_fetches`) keeps every container HTTPS request's host, WebFetch's and Bash's, so each
//   allowed one is judged against the day's `t:webfetch` list: one off it is a bypass (unclean). When the record can't be
//   read, or the day's list is unknown, a bypass couldn't show: missing.
// A leak or a bypass that was found is unclean whatever else is missing.
export function guards(e: DayEvidence): CheckResult {
  const g = e.guards
  if (g === null) return missing('the guard evidence could not be read')
  const gaps: string[] = []
  if (g.canary !== 'planted') gaps.push('no planted canary was scanned, so a leak could not show (onboarding: plant a canary in the house data and pass its file as --canary)')
  if ('unreadable' in g.egress) gaps.push(`${g.egress.unreadable}, so a fetch the brand's list does not allow could not show`)
  const found: string[] = []
  if (g.leaks > 0) found.push(`${g.leaks} leak${g.leaks === 1 ? '' : 's'} of ${g.canary === 'planted' ? 'planted canaries' : 'canary-shaped text'}`)
  if ('offList' in g.egress && g.egress.offList.length > 0) found.push(`an allowed fetch to a host off the day's WebFetch list: ${g.egress.offList.join(', ')}`)
  if (found.length > 0) return unclean([...found, ...gaps].join('; '))
  if (gaps.length > 0) return missing(gaps.join('; '))
  const allowed = 'allowed' in g.egress ? g.egress.allowed : 0
  return clean(`no leak of the planted canaries; ${allowed} allowed fetch${allowed === 1 ? '' : 'es'}, each to a listed host`)
}

const BY_NAME = { morning_check: morningCheck, bell_notices: bellNotices, memory, connector_reads: connectorReads, failed_runs: failedRuns, guards } as const

export function runChecks(e: DayEvidence): Checks {
  return Object.fromEntries(CHECK_NAMES.map(n => [n, BY_NAME[n](e)])) as Checks
}
