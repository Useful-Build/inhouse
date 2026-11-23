// The routine panel's Last runs lines from route 86's answer (master plan decision 8). Ways it can fail, written down
// first: a run today not read "Today", an earlier one without its day; a Run now not marked, or one still running given
// a result it doesn't have; the order changed; a steps link made up for a run with none.
import { describe, expect, test } from 'vitest'
import type { RoutineHistoryRun } from '../agent/types'
import { fmtTime, fmtWeekday } from '../lib/format'
import { display, setNow } from './display'
import { routineRunLines } from './derive'

const NOW = new Date(2026, 10, 16, 9, 30).getTime()
setNow(() => NOW)
const at = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const run = (ms: number, o: Partial<RoutineHistoryRun> = {}): RoutineHistoryRun => ({ at: at(ms), outcome: 'done', result: 'Found 3 things', manual: false, ...o })

describe('routineRunLines', () => {
  test('today reads "Today, <time>", an earlier day its weekday and date; the order and steps link are kept', () => {
    const today = new Date(2026, 10, 16, 6, 0).getTime()
    const friday = new Date(2026, 10, 13, 16, 0).getTime()
    const lines = routineRunLines([run(today, { trace: 'r_a' }), run(friday, { outcome: 'failed', result: 'It stopped before it finished' })], NOW)
    const d = display()
    expect(lines.map(l => [l.when, l.text, l.outcome, l.trace])).toEqual([
      [`Today, ${fmtTime(at(today), d)}`, 'Found 3 things', 'done', 'r_a'],
      [`${fmtWeekday(at(friday), d)}, ${fmtTime(at(friday), d)}`, 'It stopped before it finished', 'failed', undefined],
    ])
  })

  test('a Run now reads "Run now · <result>", or plain "Run now" while it runs', () => {
    const lines = routineRunLines([run(NOW - 1000, { manual: true, outcome: 'running', result: "It's running" }), run(NOW - 9000, { manual: true, result: 'found 6 things' })], NOW)
    expect(lines.map(l => l.text)).toEqual(['Run now', 'Run now · found 6 things'])
    expect(routineRunLines([run(NOW - 1000, { manual: true, result: 'It finished' })], NOW).map(l => l.text)).toEqual(['Run now'])
  })
})
