// The FK closure's compact key set (P8 C1; B2: the check must not hold every parent key as a string, since usage_turns
// grows by about 365,000 ids a year). Ways it can fail, written down first:
//  1. a key that was added reads as absent (a backup fails a good child);
//  2. a key that wasn't added reads as present (a child whose parent is missing passes);
//  3. it holds more than 8 bytes a key once sealed, or a key added after sealing is lost silently.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { KeySet } from './key-set.ts'

describe('KeySet', () => {
  test.prop([fc.uniqueArray(fc.string({ maxLength: 40 }), { maxLength: 300 }), fc.array(fc.string({ maxLength: 40 }), { maxLength: 50 })], { numRuns: 200 })(
    'answers present for every added key and absent for every other', (added, probes) => {
      const set = new KeySet()
      for (const k of added) set.add(k)
      for (const k of added) expect(set.has(k), k).toBe(true)
      for (const k of probes.filter(p => !added.includes(p))) expect(set.has(k), k).toBe(false)
    },
  )

  it('holds 8 bytes a key once sealed, and refuses a key added after it answered', () => {
    const set = new KeySet()
    for (let i = 0; i < 100_000; i++) set.add(`"t_${i}"`)
    expect(set.has('"t_99999"')).toBe(true)
    expect(set.has('"t_100000"')).toBe(false)
    expect(set.bytes).toBe(800_000)
    expect(() => set.add('"late"')).toThrow(/sealed/)
  })
})
