// The grader (p4-w3.md section 6): code only, no model. A case passes when the result parsed (the slot ended with a valid
// result), `coverage` and `gaps` match, the set of item keys equals the expected set, each item's severity matches, and
// every expected name shows in that item's sources. A clean case passes only with zero items. A case whose run called any
// `fixture_*` tool fails (H1 OC 6). A `lenient` case (expected.ts) takes any subset of its items and any superset of its gaps.
import type { MorningCaseMeta } from './expected.ts'

export interface Fixed { truncated: number; dropped: number; deduped: number; overflow: number }

/** What a run left behind, read from the stored rows (the normalised result, the slot's summary and its tool calls). */
export type Observed =
  | { ok: true; coverage: 'complete' | 'incomplete'; gaps: string[]; items: { key: string; sev: string; sources: string[] }[]; calls: string[]; fixed: Fixed }
  | { ok: false; cause: string; calls: string[]; fixed: Fixed | null }

export interface Verdict {
  pass: boolean
  checks: Record<'parsed' | 'coverage' | 'gaps' | 'keys' | 'sev' | 'sources' | 'noFixtureTool', boolean>
  reasons: string[]
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === new Set(a).size && a.length === b.length && a.every(x => b.includes(x))
const isFixtureTool = (name: string) => /(^|__)fixture_/.test(name)

export function grade(c: MorningCaseMeta, o: Observed): Verdict {
  const checks: Verdict['checks'] = { parsed: o.ok, coverage: false, gaps: false, keys: false, sev: false, sources: false, noFixtureTool: !o.calls.some(isFixtureTool) }
  const reasons: string[] = []
  if (!checks.noFixtureTool) reasons.push(`called a fixture tool: ${o.calls.filter(isFixtureTool).join(', ')}`)
  if (!o.ok) return { pass: false, checks, reasons: [`no valid result: ${o.cause}`, ...reasons] }
  const want = c.items.map(i => i.key)
  const got = o.items.map(i => i.key)
  checks.coverage = o.coverage === c.coverage
  if (!checks.coverage) reasons.push(`coverage ${o.coverage}, expected ${c.coverage}`)
  checks.gaps = c.lenient ? c.gaps.every(g => o.gaps.includes(g)) : sameSet(o.gaps, c.gaps)
  if (!checks.gaps) reasons.push(`gaps [${o.gaps.join(', ')}], expected ${c.lenient ? 'at least ' : ''}[${c.gaps.join(', ')}]`)
  checks.keys = c.lenient ? got.length === new Set(got).size && got.every(k => want.includes(k)) : sameSet(got, want)
  if (!checks.keys) reasons.push(`keys [${got.join(', ')}], expected ${c.lenient ? 'a subset of ' : ''}[${want.join(', ')}]`)
  checks.sev = true
  checks.sources = true
  for (const item of o.items) {
    const exp = c.items.find(i => i.key === item.key)
    if (!exp) continue
    if (item.sev !== exp.sev) {
      checks.sev = false
      reasons.push(`${item.key}: sev ${item.sev}, expected ${exp.sev}`)
    }
    for (const name of exp.sources) {
      const names = typeof name === 'string' ? [name] : name
      if (!names.some(n => item.sources.some(s => s.includes(n)))) {
        checks.sources = false
        reasons.push(`${item.key}: no source shows ${names.join(' or ')}`)
      }
    }
  }
  return { pass: Object.values(checks).every(Boolean), checks, reasons }
}

export interface Summary {
  graded: { passed: number; total: number }
  cleanAllPass: boolean
  outageAllPass: boolean
  /** At least 90% of graded cases pass and every clean and outage case passes. */
  thresholdMet: boolean
}

export function summarise(rows: { group: MorningCaseMeta['group']; pass: boolean }[]): Summary {
  const graded = rows.filter(r => r.group === 'graded')
  const passed = graded.filter(r => r.pass).length
  const cleanAllPass = rows.filter(r => r.group === 'clean').every(r => r.pass)
  const outageAllPass = rows.filter(r => r.group === 'outage').every(r => r.pass)
  return { graded: { passed, total: graded.length }, cleanAllPass, outageAllPass, thresholdMet: graded.length > 0 && passed * 10 >= graded.length * 9 && cleanAllPass && outageAllPass }
}
