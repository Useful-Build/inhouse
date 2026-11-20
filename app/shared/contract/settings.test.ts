// The settings registry on its own (the page's keys and options: src/screens/settings/settings-registry.test.ts). Ways
// it can fail, written down first:
//  1. a role (`p:`), photo (`photo:`) or grant (`d:support`) key is a setting, so a privilege could be written through
//     the settings routes; `r:` (routines) is one before P4;
//  2. a key pattern swallows an exact key (`l:daily` read as a job switch) or matches an id with odd characters;
//  3. an approver holds a name or an email;
//  4. a money value past its range, or in another shape, parses.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { SETTING_KEY_EXAMPLES, settingLabel, settingSpec } from './settings.ts'

const parses = (key: string, v: unknown) => settingSpec(key)!.value.safeParse(v).success

describe('keys that are never settings (failure 1)', () => {
  test.prop([fc.string({ maxLength: 40 })])('p:, photo: and r: keys are refused, whatever follows', s => {
    for (const k of [`p:${s}`, `photo:${s}`, `r:${s}`]) expect(settingSpec(k)).toBeNull()
  })
  it('refuses d:support', () => expect(settingSpec('d:support')).toBeNull())
})

describe('key patterns (failures 2 and 3)', () => {
  it('reads l:daily and l:restock as limits, not job switches', () => {
    expect(parses('l:daily', true)).toBe(false)
    expect(parses('l:restock', '50 units')).toBe(true)
  })
  test.prop([fc.string({ maxLength: 20 }).filter(s => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s))])('an id with odd characters matches no pattern', id => {
    for (const k of [`tm:${id}:effort`, `tm:${id}:on`, `l:${id}`]) expect(settingSpec(k)).toBeNull()
  })
  it('takes a member id or anyone as an approver, never a name or an email', () => {
    expect(parses('a:0', 'm_abc123')).toBe(true)
    expect(parses('a:0', 'anyone')).toBe(true)
    for (const v of ['Dana Kim', 'dana@example.test', 'Anyone who approves']) expect(parses('a:0', v)).toBe(false)
  })
})

describe('the money field (failure 4)', () => {
  it('refuses $0, past $100,000 and odd text', () => {
    for (const v of ['$0', '$0.00', '$100000.01', '$1,000', '300', '$3e2', '-$5']) expect(parses('s:cap', v), v).toBe(false)
  })
})

describe('SETTING_KEY_EXAMPLES', () => {
  it('names a key every registry entry answers for, once each', () => {
    for (const key of SETTING_KEY_EXAMPLES) expect(settingSpec(key), key).not.toBeNull()
    expect(new Set(SETTING_KEY_EXAMPLES).size).toBe(SETTING_KEY_EXAMPLES.length)
    expect(SETTING_KEY_EXAMPLES).toEqual(expect.arrayContaining(['g:name', 'tm:fable:effort', 'tm:fable:on', 'l:returns', 'a:0']))
  })
})

describe('settingLabel', () => {
  it('names every registry entry (an exact key added without a label fails here)', () => {
    for (const key of SETTING_KEY_EXAMPLES) expect(settingLabel(key), key).not.toBeNull()
    expect(settingLabel('x:gone')).toBeNull()
  })
})
