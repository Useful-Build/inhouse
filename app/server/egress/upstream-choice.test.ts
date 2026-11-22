// Which model the egress's model route answers from (p3-eval-observability rev 2, rec 1). Ways it can fail, written down
// first:
//  1. the eval build (test issuer compiled in and switched on, so INHOUSE_TEST_BUILD = "1") answers from the scripted
//     model, so a paid eval grades the scripted model;
//  2. the test build stops using the scripted model (its specs would reach for a gateway it doesn't have);
//  3. the product build, or a test build not switched on, uses the scripted model.
import { describe, expect, it } from 'vitest'
import { usesScriptedModel } from './index.ts'

const ON = { INHOUSE_TEST_BUILD: '1' }

describe('usesScriptedModel', () => {
  it('the eval build always takes the gateway, even with the test switch on (failure 1)', () => {
    expect(usesScriptedModel(ON, { test: true, eval: true })).toBe(false)
    expect(usesScriptedModel({}, { test: true, eval: true })).toBe(false)
  })
  it('the test build, switched on, answers from the scripted model (failure 2)', () => {
    expect(usesScriptedModel(ON, { test: true, eval: false })).toBe(true)
  })
  it('the product build, or a test build not switched on, takes the gateway (failure 3)', () => {
    expect(usesScriptedModel(ON, { test: false, eval: false })).toBe(false)
    expect(usesScriptedModel({}, { test: true, eval: false })).toBe(false)
    expect(usesScriptedModel({ INHOUSE_TEST_BUILD: 'true' }, { test: true, eval: false })).toBe(false)
  })
  it('this compile (vitest, as the product build) takes the gateway by default', () => {
    expect(usesScriptedModel(ON)).toBe(false)
  })
})
