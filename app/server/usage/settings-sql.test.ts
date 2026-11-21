// The cap and alert as SQL (settings-sql.ts) against P2's own rule for the money field (`capOk`, settings-table.ts) on
// generated values: a differential test. Ways it can fail: SQL accepts a value `capOk` refuses (a cap from "$1,000" or
// "$12.5"), refuses one it accepts, or turns a valid one into the wrong number of micro-USD (float rounding of cents).
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { capOk } from '../../shared/contract/settings-table.ts'
import { ALERT_PCT_SQL, CAP_MICRO_SQL } from './settings-sql.ts'
import { db, resetUsage, setSetting } from './test-fixtures.ts'

/** The reference: `capOk`, then whole dollars and cents read as integers from the text (no floats). */
const expectedMicro = (v: unknown): number => {
  if (typeof v !== 'string' || !capOk(v)) return 0
  const [w, c = '00'] = v.slice(1).split('.')
  return Number(w) * 1_000_000 + Number(c) * 10_000
}
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
