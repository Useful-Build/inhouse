// CONTRACT GUARD ONLY: this checks the helpers' behaviour and can't catch the crash itself, which was in the caller (the
// Composer read .id of activeMode's result; the helper always returned undefined). The e2e spec
// e2e/real/composer-no-models.spec.ts is the guard for that. No DOM test environment exists to render the Composer here.
// The product's client has no models until chat arrives (P3), so `models` is []. Ways this could fail, written first:
//  1. activeMode indexes modes[0] of an empty list and the Composer reads `.id` of undefined (the crash the test build's
//     Worker logged on `/`);
//  2. defaultModeId or thinkingModes throw or invent a mode when there are none;
//  3. a picked or saved mode id that matches nothing still yields a mode.
import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { HttpAgent } from '../agent/http/client'
import { activeMode, defaultModeId, thinkingModes } from './derive'

const EMPTY = new HttpAgent().read()

describe('an agent with no models', () => {
  test('has no thinking modes', () => {
    expect(EMPTY.models).toEqual([])
    expect(thinkingModes(EMPTY, {})).toEqual([])
  })
  test.prop([fc.option(fc.string(), { nil: null }), fc.dictionary(fc.string(), fc.string())])('activeMode never throws and returns none', (picked, saved) => {
    expect(activeMode(EMPTY, saved, picked)).toBeUndefined()
    expect(() => defaultModeId(EMPTY, saved)).not.toThrow()
  })
})
