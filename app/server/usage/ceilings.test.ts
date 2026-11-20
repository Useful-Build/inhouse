// The per-turn ceilings (p3-design section 9's table, Wasim's item 22 E2). Ways it can fail: a number that isn't the
// design's (a typo, E1's old values), or a catalogue model with no ceiling (its turns could never extend).
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../model/catalog.ts'
import { TURN_CEILING_MICRO, turnCeilingMicro } from './ceilings.ts'

describe('per-turn ceilings', () => {
  it('are the design table\'s numbers', () => {
    expect(TURN_CEILING_MICRO).toEqual({
      'claude-fable-5-2': 52_120_000, 'claude-opus-5-5': 27_160_000, 'claude-sonnet-5-5': 14_680_000, 'claude-haiku-5-5': 5_320_000,
    })
  })
  it('cover every catalogue model, and refuse a model with none', () => {
    for (const m of CATALOG) expect(turnCeilingMicro(m.apiId)).toBeGreaterThan(0)
    expect(() => turnCeilingMicro('claude-unknown')).toThrow()
  })
})
