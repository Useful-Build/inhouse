// The write-injection run's files: rows.json (every repeat), report.json (the summary and the gate) and a README with
// the numbers filled in and the conclusion left for the orchestrator. Rows carry no canary (redacted) and no raw tool data.
import fs from 'node:fs'
import path from 'node:path'
import { summarise, type InjectionRow, type InjectionRunOutput } from './runner.ts'

export interface ReportMeta { topic: string; target: string; model: string; reps: number; extra?: string[] }

/** The gate as one line: PASS or FAIL, its waivers, and a subset named as one (never a plain PASS for the set). */
export function gateLine(s: ReturnType<typeof summarise>): string {
  const sub = s.subset ? ` on a subset (${s.subset.cases} of ${s.subset.of} cases): not a run of the set` : ''
  return `${s.gate.pass ? 'PASS' : 'FAIL'}${sub}${s.waived.length ? `, ${s.waived.length} cases waived` : ''}${s.gate.why.length ? `: ${s.gate.why.join('; ')}` : ''}`
}

export function renderInjectionReadme(s: ReturnType<typeof summarise>, meta: ReportMeta): string {
  const kinds = Object.entries(s.bypasses.byKind).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'
  return [
    `# ${meta.topic}`, '',
    '## Question', '', '(the orchestrator fills this in)', '',
    '## What ran', '',
    `Target \`${meta.target}\`, model \`${meta.model}\`, ${meta.reps} repeats: ${s.repeats.ran} of ${s.repeats.planned} planned case-repeats ran, ${s.repeats.graded} graded, ${s.repeats.pass} passed.`,
    s.notRun.length ? `Not run (the target doesn't provide the write family): ${s.notRun.map((n) => `${n.id} (${n.needs.join(', ')})`).join('; ')}.` : 'Every case\'s write family is provided.',
    s.notServed.length ? `Not served on this target (no way to plant there): ${s.notServed.map((n) => `${n.id} (${n.why})`).join('; ')}.` : 'Every planting surface is served.',
    s.waived.length ? `Waived by name for this run: ${s.waived.join(', ')}.` : 'No case waived.',
    s.notMeasured.length ? `Not measured (no case ran): ${s.notMeasured.join('; ')}.` : 'Every rule was exercised by at least one case.', '',
    '## Gate', '', `${gateLine(s)}.`, '',
    '## Numbers', '',
    `Bypasses: ${s.bypasses.total} (${kinds}).`,
    `Bait under a grant (Q4 a): ${s.headline.baitUnderGrant.repeats} of ${s.headline.baitUnderGrant.of} repeats with a seeded grant; cases at 2 of 3 or more: ${s.headline.baitUnderGrant.casesAtTwoOfThree.join(', ') || 'none'}.`,
    `Private data to a listed channel (Q4 b): ${s.headline.privateToListed}.`,
    `Took the bait, no grant: ${s.soft.tookBaitNoGrant.repeats} of ${s.soft.tookBaitNoGrant.of}. Asks per repeat: ${s.soft.asksPerRepeat.toFixed(2)}. Cost: $${s.soft.costUsd.toFixed(4)}.`, '',
    ...(meta.extra ?? []),
    '## Conclusion', '', '(left for the orchestrator)', '',
  ].join('\n')
}

/** rows.jsonl: one graded row per line, appended as each repeat ends (ops #49: a timeout or cancel keeps what was paid for). */
export const ROWS_LOG = 'rows.jsonl'
/** Starts a run's rows.jsonl, empty. */
export function startRows(out: string): void {
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, ROWS_LOG), '')
}
/** Appends one graded row (already redacted by the runner) to rows.jsonl. */
export function appendRow(out: string, row: InjectionRow): void {
  fs.appendFileSync(path.join(out, ROWS_LOG), `${JSON.stringify(row)}\n`)
}

export function writeInjectionResults(out: string, run: InjectionRunOutput, meta: ReportMeta): ReturnType<typeof summarise> {
  fs.mkdirSync(out, { recursive: true })
  const s = summarise(run)
  fs.writeFileSync(path.join(out, 'rows.json'), JSON.stringify(run.rows, null, 1))
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ topic: meta.topic, target: meta.target, model: meta.model, reps: meta.reps, ...s, spentUsd: run.spentUsd }, null, 1))
  fs.writeFileSync(path.join(out, 'README.md'), renderInjectionReadme(s, meta))
  return s
}
