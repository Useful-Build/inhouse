// The settings table (plain data, settings-table.ts) against the zod registry built from it (settings.ts). The mock checks
// values with the table and the server with zod; they must say the same thing. Ways it can fail:
//  1. a value one accepts and the other refuses (a trim, a length bound, the money range, a member id, `anyone`);
//  2. a key one knows and the other doesn't, or the two put in different scopes;
//  3. an option list the table offers that the zod enum doesn't take.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { EXACT_ROWS, meetsRule, settingRow } from './settings-table.ts'
import { settingSpec } from './settings.ts'

const keys = [...Object.keys(EXACT_ROWS), 'tm:fable:effort', 'tm:fable:on', 'l:returns', 'a:0', 'a:12', 'a:01', 'p:m_sam', 'd:support', 'nope', 'r:x', 'l:daily']
const values = fc.oneof(
  fc.string(), fc.boolean(), fc.constantFrom('on', 'off', 'anyone', 'm_sam', 'm_', '$320', '$300.50', '$0', '$100000', '$100001', '$1.5', '  x  ', '', ' ', 'x'.repeat(80), 'x'.repeat(81)),
  fc.constantFrom(...Object.values(EXACT_ROWS).flatMap(r => (r.rule.t === 'enum' ? [...r.rule.values] : []))), fc.integer(), fc.constant(null),
)

describe('the table and the zod registry', () => {
  it('know the same keys, in the same scopes, with the same audit rule', () => {
    for (const k of keys) {
      const row = settingRow(k), spec = settingSpec(k)
      expect(row === null, k).toBe(spec === null)
      if (row && spec) expect([spec.scope, spec.auditSafe], k).toEqual([row.scope, row.auditSafe])
    }
  })
  test.prop([fc.constantFrom(...keys), values])('accept and refuse the same values', (key, value) => {
    const row = settingRow(key), spec = settingSpec(key)
    if (!row || !spec) return
    expect(meetsRule(row.rule, value), `${key} = ${JSON.stringify(value)}`).toBe(spec.value.safeParse(value).success)
  })
  it('take every option a list rule offers', () => {
    for (const [k, row] of Object.entries(EXACT_ROWS)) {
      if (row.rule.t !== 'enum') continue
      for (const v of row.rule.values) expect(settingSpec(k)!.value.safeParse(v).success, `${k} = ${v}`).toBe(true)
      expect(meetsRule(row.rule, `${row.rule.values[0]}!`), k).toBe(false)
    }
  })
})
