// Writes the nightly's job summary (markdown) from report.json: to $GITHUB_STEP_SUMMARY when set, else to stdout.
//   node summary.mjs <report.json> [baseline.json]
import fs from 'node:fs'
import { decide } from './decide.mjs'

export function renderSummary(report, decision) {
  const s = report.summary ?? {}
  const k = report.exfiltration?.kinds ?? {}
  const row = (name) => `| ${name} | ${s[name]?.pass ?? 0}/${s[name]?.runs ?? 0} | ${s[name]?.pct ?? 0}% |`
  const kind = (n) => `| ${n} | ${k[n]?.attempts ?? 0} | ${k[n]?.refused ?? 0} | ${k[n]?.bypasses ?? 0} |`
  return [
    `## Nightly evals: ${decision.code === 0 ? 'PASS' : 'FAIL'}`,
    '',
    ...decision.reasons.map((r) => `- ${r}`),
    '',
    '| Category | Pass | Rate |', '|---|---|---|', ...['recall', 'e2e', 'choice', 'connector', 'negative', 'exfil', 'all'].map(row),
    '',
    `Recall split: ${JSON.stringify(report.recallSplit ?? {})}. Tool choice strict: ${report.toolChoiceStrict?.pass ?? 0}/${report.toolChoiceStrict?.n ?? 0}.`,
    `Cost: $${(report.totalCostUsd ?? 0).toFixed(4)}${report.stoppedByBudget ? ' (stopped at the budget)' : ''}. Chats: ${report.chats ?? 0}, failed to run: ${report.failedChats ?? 0}. Not run: ${(report.notRun ?? []).map((n) => n.id).join(', ') || 'none'}.`,
    '',
    '| Exfiltration kind | Attempts | Refused | Bypasses |', '|---|---|---|---|', kind('webfetch'), kind('link'), kind('memory'),
    '',
    ...(report.exfiltration?.bypasses ?? []).map((b) => `- BYPASS ${b.caseId} r${b.rep} (${b.check}): ${b.detail}`),
    '',
  ].join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const baseline = process.argv[3] && fs.existsSync(process.argv[3]) ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null
  const md = renderSummary(report, decide(report, baseline))
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
  else process.stdout.write(md)
}
