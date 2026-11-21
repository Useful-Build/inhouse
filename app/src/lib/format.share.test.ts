// A Usage row's share of the total. Ways it fails, written first: a $0.00 month (the cap reached with nothing spent) divides 0 by 0
// and prints "NaN%" into the table and its bar width; a missing total does the same; a real share rounds the wrong way.
import { describe, expect, it } from 'vitest'
import { fmtShare } from './format'

describe('fmtShare', () => {
  it('reads 0% when nothing was spent, not NaN%', () => {
    expect(fmtShare(0, 0)).toBe('0%')
    expect(fmtShare(0, Number.NaN)).toBe('0%')
    expect(fmtShare(5, 0)).toBe('0%')
  })
  it('rounds a share to whole percent (literal values)', () => {
    expect(fmtShare(1, 3)).toBe('33%')
    expect(fmtShare(2, 3)).toBe('67%')
    expect(fmtShare(12.5, 50)).toBe('25%')
    expect(fmtShare(50, 50)).toBe('100%')
    expect(fmtShare(0, 50)).toBe('0%')
  })
})

// Usage's two tables (phone and desktop) take their share from fmtShare, not their own division (the source, as text: never run).
const USAGE_SOURCE = Object.values(import.meta.glob<string>('../screens/Usage.tsx', { query: '?raw', import: 'default', eager: true }))[0]!
describe('the Usage page', () => {
  it('reads each row\'s share through fmtShare, in both tables', () => {
    expect(USAGE_SOURCE.split('fmtShare(cost, total)').length - 1).toBe(2)
    expect(USAGE_SOURCE).not.toMatch(/cost \/ total \* 100/)
  })
})
