// The cap and alert as SQL (settings-sql.ts) against P2's own rule for the money field (`capOk`, settings-table.ts) on
// generated values: a differential test. Ways it can fail: SQL accepts a value `capOk` refuses (a cap from "$1,000" or
// "$12.5"), refuses one it accepts, or turns a valid one into the wrong number of micro-USD (float rounding of cents).
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CAP_PATTERN, DEFAULT_JOB_BUDGET_USD, EXACT_ROWS, MAX_JOB_BUDGET_USD, MIN_JOB_BUDGET_USD, capOk, meetsRule } from '../../shared/contract/settings-table.ts'
import { START_HOLD_MICRO } from './ledger.ts'
import { ALERT_PCT_SQL, CAP_MICRO_SQL, JOB_BUDGET_MICRO_SQL } from './settings-sql.ts'
import { db, resetUsage, setSetting } from './test-fixtures.ts'

/** Whole dollars and cents read as integers from money text (no floats). */
const microOf = (v: string) => {
  const [w, c = '00'] = v.slice(1).split('.')
  return Number(w) * 1_000_000 + Number(c) * 10_000
}
/** The reference: `capOk`, then the text's micro-USD. */
const expectedMicro = (v: unknown): number => (typeof v === 'string' && capOk(v) ? microOf(v) : 0)
/**
 * The job budget's reference: a value `capOk` takes under the job rule; a well-formed value above the ceiling clamped
 * to it; anything else (unset, $0, below the start hold, malformed) the default.
 */
const expectedJobMicro = (v: unknown): number => {
  if (typeof v === 'string' && capOk(v, MAX_JOB_BUDGET_USD, MIN_JOB_BUDGET_USD)) return microOf(v)
  if (typeof v === 'string' && CAP_PATTERN.test(v) && microOf(v) > MAX_JOB_BUDGET_USD * 1_000_000) return MAX_JOB_BUDGET_USD * 1_000_000
  return DEFAULT_JOB_BUDGET_USD * 1_000_000
}
const jobSql = async () => (await db.prepare(`SELECT ${JOB_BUDGET_MICRO_SQL} AS v`).first<{ v: number }>())?.v
const capSql = async () => (await db.prepare(`SELECT ${CAP_MICRO_SQL} AS v`).first<{ v: number }>())?.v
const alertSql = async () => (await db.prepare(`SELECT ${ALERT_PCT_SQL} AS v`).first<{ v: number }>())?.v

const digits = (min: number, max: number) => fc.string({ unit: fc.constantFrom(...'0123456789'), minLength: min, maxLength: max })
const capLike = fc.oneof(
  fc.tuple(digits(0, 8), fc.option(digits(0, 3), { nil: undefined })).map(([w, c]) => `$${w}${c === undefined ? '' : `.${c}`}`),
  fc.string({ maxLength: 12 }),
  fc.string({ unit: fc.constantFrom(...'$0123456789.,- '), maxLength: 10 }),
)

describe('s:cap in SQL', () => {
  it('literal values', async () => {
    await resetUsage(null)
    expect(await capSql()).toBe(0)
    for (const [v, micro] of [['$320', 320_000_000], ['$300.50', 300_500_000], ['$0.01', 10_000], ['$100000', 100_000_000_000],
      ['$100000.01', 0], ['$0', 0], ['$0.00', 0], ['$1,000', 0], ['$12.5', 0], ['320', 0], ['$', 0], ['$.50', 0], [null, 0], [320, 0]] as const) {
      await setSetting('s:cap', v)
      expect([v, await capSql()]).toEqual([v, micro])
    }
  })

  it('agrees with capOk on generated values', async () => {
    await resetUsage(null)
    await fc.assert(fc.asyncProperty(capLike, async v => {
      await setSetting('s:cap', v)
      expect(await capSql()).toBe(expectedMicro(v))
    }), { numRuns: 300 })
  })
})

describe('s:job_cap in SQL', () => {
  it('literal values: $25 default, the start hold as the floor, $100 clamp', async () => {
    await resetUsage(null)
    expect(await jobSql()).toBe(25_000_000)
    for (const [v, micro] of [['$25', 25_000_000], ['$1.00', 1_000_000], ['$0.25', 250_000], ['$100', 100_000_000], ['$100.00', 100_000_000],
      ['$100.01', 100_000_000], ['$101', 100_000_000], ['$999999.99', 100_000_000], ['$0.24', 25_000_000], ['$0', 25_000_000],
      ['$0.00', 25_000_000], ['$1,000', 25_000_000], ['$12.5', 25_000_000], ['50', 25_000_000], ['$', 25_000_000], [null, 25_000_000],
      [50, 25_000_000]] as const) {
      await setSetting('s:job_cap', v)
      expect([v, await jobSql()]).toEqual([v, micro])
    }
  })

  it('agrees with capOk(v, MAX_JOB_BUDGET_USD) on generated values', async () => {
    await resetUsage(null)
    const nearRange = fc.tuple(fc.integer({ min: 0, max: 200 }), fc.option(fc.integer({ min: 0, max: 99 }), { nil: undefined }))
      .map(([w, c]) => `$${w}${c === undefined ? '' : `.${String(c).padStart(2, '0')}`}`)
    await fc.assert(fc.asyncProperty(fc.oneof(nearRange, capLike), async v => {
      await setSetting('s:job_cap', v)
      expect(await jobSql()).toBe(expectedJobMicro(v))
    }), { numRuns: 300 })
  })

  it('the Settings rule refuses a job cap the ledger could never start a turn under', () => {
    expect(MIN_JOB_BUDGET_USD * 1_000_000).toBe(START_HOLD_MICRO)
    const rule = EXACT_ROWS['s:job_cap'].rule
    for (const [v, ok] of [['$0.24', false], ['$0.25', true], ['$25', true], ['$100.00', true], ['$100.01', false]] as const) {
      expect([v, meetsRule(rule, v)]).toEqual([v, ok])
    }
  })
})

describe('s:alert in SQL', () => {
  it('reads each Settings level and defaults to 80', async () => {
    await resetUsage(null)
    expect(await alertSql()).toBe(80)
    for (const [v, pct] of [['50%', 50], ['70%', 70], ['90%', 90], ['100%', 100], ['85%', 80], [null, 80]] as const) {
      await setSetting('s:alert', v)
      expect(await alertSql()).toBe(pct)
    }
  })
})
