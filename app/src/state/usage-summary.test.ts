import { describe, expect, test } from 'vitest'
import { moneyOf } from '../lib/format'
import { usageSummary } from './derive'

const usd = (major: number) => moneyOf(major, 'USD')

describe('usageSummary', () => {
  test('guards empty daily arrays and zero caps without NaN or Infinity', () => {
    const emptyThisMonth = usageSummary({ monthKey: '2026-11', total: usd(0), cap: usd(500), alertAt: 80, daily: [] }, true, false)
    expect(emptyThisMonth.hint).toBe('Nothing spent yet this month')
    expect(emptyThisMonth.hint).not.toContain('NaN')

    const zeroCapClosed = usageSummary({ monthKey: '2026-10', total: usd(0), cap: usd(0), alertAt: 80, daily: [] }, false, false)
    expect(zeroCapClosed.hint).toBe('Finished under your $0 cap')
    expect(zeroCapClosed.capNote).toBe('Closed at 0% of the cap. Nothing was paused.')
  })

  test('uses real month lengths from monthKey and defaults to 30 when absent', () => {
    // Avg $10/day: Feb (28) -> $280, leap Feb (29) -> $290, Nov (30) -> $300, Dec (31) -> $310, missing key -> $300.
    const janOrFeb = (monthKey?: string) => usageSummary({ monthKey, total: usd(100), cap: usd(500), alertAt: 80, daily: Array(10).fill(usd(10)) }, true, false).hint
    expect(janOrFeb('2026-02')).toContain('$280')
    expect(janOrFeb('2024-02')).toContain('$290')
    expect(janOrFeb('2026-11')).toContain('$300')
    expect(janOrFeb('2026-12')).toContain('$310')
    expect(janOrFeb(undefined)).toContain('$300')
  })

  test('never reports negative days left when cap is reached on day 31', () => {
    const dec31 = usageSummary({ monthKey: '2026-12', total: usd(500), cap: usd(500), alertAt: 80, daily: Array(31).fill(usd(16)) }, true, true)
    expect(dec31.hint).toBe('Cap reached with 0 days of the month left')
  })
})
