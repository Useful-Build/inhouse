import { describe, expect, it } from 'vitest'
import { CASES, S5_LEGACY_EXPECT } from './cases.ts'
import { gradeChat } from './grade.ts'
import { buildReport, costStats, toRow, type Row } from './report.ts'
import { loadS5Chats, loadS5Verdicts, S5_PEOPLE } from './s5-fixtures.ts'

const byId = Object.fromEntries(CASES.map((c) => [c.id, c]))

function s5Rows(legacy: boolean): Row[] {
  return loadS5Chats().map((ch) => {
    const c = byId[ch.case]!
    const expectation = (legacy ? S5_LEGACY_EXPECT[c.id]?.[ch.chat - 1] : undefined) ?? c.chats[ch.chat - 1]!.expect
    return toRow(c, ch.rep, ch.chat, ch, gradeChat(expectation, ch, S5_PEOPLE))
  })
}
const META = { target: 'fixture', model: 'claude-sonnet-5-5', effort: 'medium', reps: 3, notRun: [] }

describe('cost per conversation', () => {
  it('median, p95 (nearest rank), mean and total of a hand-made list of five costs', () => {
    // sorted 0.01 0.02 0.03 0.04 0.10: median = 3rd = 0.03; p95 = ceil(0.95 * 5) = 5th = 0.10; mean = 0.20 / 5 = 0.04
    const s = costStats([0.04, 0.1, 0.01, 0.03, 0.02])
    expect(s.median).toBeCloseTo(0.03, 12)
    expect(s.p95).toBeCloseTo(0.1, 12)
    expect(s.mean).toBeCloseTo(0.04, 12)
    expect(s.total).toBeCloseTo(0.2, 12)
    expect(s.n).toBe(5)
  })
  it('the median of an even count is the mean of the two middle values', () => {
    expect(costStats([1, 2, 3, 10]).median).toBe(2.5)
  })
  it('an empty list is all zero, not NaN', () => {
    expect(costStats([])).toEqual({ n: 0, median: 0, p95: 0, mean: 0, total: 0 })
  })
})

describe('report on the S5 replay equals S5\'s own summary', () => {
  const s5 = loadS5Verdicts()
  const report = buildReport(CASES, s5Rows(true), META)

  it.each(['recall', 'e2e', 'choice', 'connector', 'negative', 'all'])('category %s: runs, pass, pct, per repeat and cost', (cat) => {
    const want = s5.summary[cat]!
    const got = report.summary[cat]!
    expect({ runs: got.runs, pass: got.pass, pct: got.pct, perRep: got.perRep }).toEqual({ runs: want.runs, pass: want.pass, pct: want.pct, perRep: want.perRep })
    expect(got.cost).toBeCloseTo(want.cost, 9)
  })

  it('recall split is S5\'s: searched 100, answer 93, n 42', () => {
    expect(report.recallSplit).toEqual(s5.recallSplit)
  })

  it('tool choice strict is choice plus connector: 58/63', () => {
    expect(report.toolChoiceStrict).toMatchObject({ pass: 58, n: 63 })
  })

  it('cost per conversation covers 129 case-repeats and totals S5\'s 1.5731', () => {
    expect(report.costPerConversation.n).toBe(129)
    expect(report.costPerConversation.total).toBeCloseTo(1.5731066, 6)
    expect(report.totalCostUsd).toBeCloseTo(1.5731066, 6)
  })

  it('with the fixes the report says 112/129 and recall 33/33', () => {
    const fixed = buildReport(CASES, s5Rows(false), META)
    // T09 and T11 (r1-r3) flip to fail: S5 recorded its own mock tools' inputs (to: [ids], schedule: "weekdays 06:00"),
    // and the cases now follow P4/P5's real schemas (to.members, days and time; line B), which S5 never served. T07 r1-r3
    // and T08 r2 flip the same way: S5 asked through a free-text `action`; M2-E's approval_request takes `{ operation, args }`.
    // T14 r1-r3 too (M2-G): S5's mock team_request_create took a `title`, P6a's real one takes `subject`.
    expect(fixed.summary.all).toMatchObject({ runs: 129, pass: 112 })
    expect(fixed.summary.recall).toMatchObject({ runs: 33, pass: 33 })
  })

  it('a case-repeat missing a chat is left out of the counts', () => {
    const rows = s5Rows(true).filter((r) => !(r.caseId === 'E01' && r.rep === 1 && r.chat === 2))
    expect(buildReport(CASES, rows, META).summary.e2e.runs).toBe(8)
  })
})

describe('exfiltration numbers', () => {
  it('sums attempts, refusals and bypasses per kind and lists each bypass', () => {
    const base = s5Rows(true)[0]!
    const none = { attempts: 0, refused: 0 }
    const mk = (caseId: string, rep: number, kind: 'webfetch' | 'memory', attempts: number, refused: number, bypasses: number): Row => ({
      ...base, caseId, cat: 'exfil', rep, chat: 1, pass: bypasses === 0,
      exfil: {
        kind, byKind: { webfetch: none, link: none, memory: none, [kind]: { attempts, refused } },
        bypasses: Array.from({ length: bypasses }, () => ({ kind, check: kind === 'memory' ? 'memory.canary' : 'webfetch.unlisted', detail: 'd' })), pass: bypasses === 0,
      },
    })
    const r = buildReport(CASES, [mk('X01', 1, 'webfetch', 2, 1, 1), mk('X02', 1, 'webfetch', 1, 1, 0), mk('X07', 1, 'memory', 1, 0, 1)], META)
    expect(r.exfiltration.kinds.webfetch).toEqual({ attempts: 3, refused: 2, bypasses: 1 })
    expect(r.exfiltration.kinds.memory).toEqual({ attempts: 1, refused: 0, bypasses: 1 })
    expect(r.exfiltration.kinds.link).toEqual({ attempts: 0, refused: 0, bypasses: 0 })
    expect(r.exfiltration.notOk).toBe(0)
    expect(r.exfiltration.bypasses.map((b) => `${b.caseId}-r${b.rep}:${b.check}`)).toEqual(['X01-r1:webfetch.unlisted', 'X07-r1:memory.canary'])
  })
})
