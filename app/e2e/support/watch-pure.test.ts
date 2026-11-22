// The literals the Watch specs lean on, checked on their own: written from the zones' rules, not from the code under test.
import { fc, test as fcTest } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { TABLE_COVERS, expectedNextDaily, leaks, localClock, offsetMinutes, withoutConfigEcho } from './watch-pure.ts'

describe('localClock', () => {
  it('reads the wall clock of an instant, either side of a New York fall-back', () => {
    expect(localClock(Date.UTC(2026, 10, 1, 5, 30), 'America/New_York')).toEqual({ date: '2026-11-01', hour: 1, minute: 30 })
    expect(localClock(Date.UTC(2026, 10, 1, 6, 30), 'America/New_York')).toEqual({ date: '2026-11-01', hour: 1, minute: 30 })
    expect(localClock(Date.UTC(2026, 2, 8, 7, 0), 'America/New_York')).toEqual({ date: '2026-03-08', hour: 3, minute: 0 })
  })
  it('takes midnight as hour 0, never 24', () => {
    expect(localClock(Date.UTC(2026, 5, 1, 4, 0), 'America/New_York')).toEqual({ date: '2026-06-01', hour: 0, minute: 0 })
  })
})

describe('offsetMinutes (the literal table)', () => {
  it('has the summer and winter offsets on both sides of each 2026 and 2027 change', () => {
    const ny = (y: number, m: number, d: number, h: number) => offsetMinutes('America/New_York', Date.UTC(y, m, d, h))
    expect([ny(2026, 2, 8, 6), ny(2026, 2, 8, 7), ny(2026, 10, 1, 5), ny(2026, 10, 1, 6)]).toEqual([-300, -240, -240, -300])
    expect([ny(2027, 2, 14, 6), ny(2027, 2, 14, 7), ny(2027, 10, 7, 5), ny(2027, 10, 7, 6)]).toEqual([-300, -240, -240, -300])
    const ln = (y: number, m: number, d: number, h: number) => offsetMinutes('Europe/London', Date.UTC(y, m, d, h))
    expect([ln(2026, 2, 29, 0), ln(2026, 2, 29, 1), ln(2026, 9, 25, 0), ln(2026, 9, 25, 1)]).toEqual([0, 60, 60, 0])
  })
  it('refuses a year it does not cover', () => {
    expect(() => offsetMinutes('Europe/London', TABLE_COVERS.toMs + 86_400_000)).toThrow(/2026 and 2027/)
  })
  fcTest.prop([fc.integer({ min: TABLE_COVERS.fromMs, max: TABLE_COVERS.toMs }), fc.constantFrom('America/New_York' as const, 'Europe/London' as const)])(
    'agrees with Intl at every instant of 2026 and 2027',
    (ms, tz) => {
      const intl = (m: number) => {
        const c = localClock(m, tz)
        return (Date.UTC(Number(c.date.slice(0, 4)), Number(c.date.slice(5, 7)) - 1, Number(c.date.slice(8, 10)), c.hour, c.minute) - Math.floor(m / 60_000) * 60_000) / 60_000
      }
      expect(offsetMinutes(tz, ms)).toBe(intl(ms))
    },
  )
})

describe('expectedNextDaily', () => {
  it('is 06:00 local, from the literal table: New York, either side of the spring change', () => {
    expect(new Date(expectedNextDaily('America/New_York', 6, 0, Date.UTC(2026, 2, 7, 12))).toISOString()).toBe('2026-03-08T10:00:00.000Z')
    expect(new Date(expectedNextDaily('America/New_York', 6, 0, Date.UTC(2026, 2, 8, 12))).toISOString()).toBe('2026-03-09T10:00:00.000Z')
    expect(new Date(expectedNextDaily('America/New_York', 6, 0, Date.UTC(2026, 2, 8, 10))).toISOString()).toBe('2026-03-09T10:00:00.000Z')
  })
  it('London in November has no offset', () => {
    expect(new Date(expectedNextDaily('Europe/London', 6, 0, Date.UTC(2026, 10, 21, 12))).toISOString()).toBe('2026-11-22T06:00:00.000Z')
  })
  fcTest.prop([fc.integer({ min: Date.UTC(2026, 0, 2), max: Date.UTC(2027, 11, 20) }), fc.constantFrom('America/New_York' as const, 'Europe/London' as const)])(
    'lands on 06:00 local by Intl, after the instant and within 25 hours of it',
    (after, tz) => {
      const next = expectedNextDaily(tz, 6, 0, after)
      expect(next).toBeGreaterThan(after)
      // 25 hours, not 24: from 06:00 local on the day before the autumn change, the next 06:00 is 25 hours away
      // (fast-check found [1793440800000, 'America/New_York']: 06:00 EDT on 31 Oct 2026 to 06:00 EST on 1 Nov).
      expect(next - after).toBeLessThanOrEqual(90_000_000)
      expect(localClock(next, tz)).toMatchObject({ hour: 6, minute: 0 })
    },
  )
})

describe('leaks', () => {
  it('names each needle found, by text or pattern, and nothing else', () => {
    expect(leaks('a shpat_test_2 b secret-x', { token: /shpat_test_\d+/, secret: 'secret-x', other: 'nope' })).toEqual(['token', 'secret'])
    expect(leaks('clean', { token: /shpat_test_\d+/ })).toEqual([])
  })
})

describe('withoutConfigEcho', () => {
  const log = ['starting', 'env.SHOPIFY_CLIENT_SECRET ("test-secret-value")   Environment Variable', 'hub_call {"x":"test-secret-value"}', 'env.OTHER ("test-secret-value")', 'end'].join('\n')
  it('removes only the line that names the variable and holds its value', () => {
    expect(withoutConfigEcho(log, 'SHOPIFY_CLIENT_SECRET', 'test-secret-value').split('\n')).toEqual(['starting', 'hub_call {"x":"test-secret-value"}', 'env.OTHER ("test-secret-value")', 'end'])
  })
  it('leaves every line that carries the value anywhere else, so a leak elsewhere is still found', () => {
    const left = withoutConfigEcho(log, 'SHOPIFY_CLIENT_SECRET', 'test-secret-value')
    expect(leaks(left, { secret: 'test-secret-value' })).toEqual(['secret'])
  })
  it('changes nothing when no line echoes it', () => {
    expect(withoutConfigEcho('a\nb', 'N', 'v')).toBe('a\nb')
  })
})
