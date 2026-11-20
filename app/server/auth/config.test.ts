// AccessConfigSchema's failure modes: safeParse must never throw (zod 4 runs later refinements after an earlier one
// failed), unknown keys fail closed, and a client id named like an Object.prototype member never maps to a service.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { AccessConfigSchema } from './config.ts'

const A = 'a1'.repeat(32)
const B = 'b2'.repeat(32)
const valid = {
  teamDomain: 'https://example-team.cloudflareaccess.com',
  apps: [{ name: 'brand', origin: 'https://brand.example.test', aud: A }, { name: 'inhouse', origin: 'https://inhouse.example.test', aud: B }],
  serviceTokens: { 'monitor-client.access': 'monitor' },
}

describe('AccessConfigSchema', () => {
  test.prop([fc.oneof(fc.anything(), fc.jsonValue())])('safeParse never throws on any value', v => {
    expect(() => AccessConfigSchema.safeParse(v)).not.toThrow()
  })

  // Near-valid shapes reach the cross-field checks: the place a throw hid.
  const app = fc.record({ name: fc.constantFrom('brand', 'inhouse', 'x'), origin: fc.oneof(fc.webUrl(), fc.string(), fc.constant('https://brand.example.test')), aud: fc.constantFrom(A, B, 'zz') })
  test.prop([fc.array(app, { maxLength: 4 })])('safeParse never throws on near-valid apps', apps => {
    expect(() => AccessConfigSchema.safeParse({ ...valid, apps })).not.toThrow()
  })

  it('accepts a valid config and gives serviceTokens as a Map', () => {
    const r = AccessConfigSchema.safeParse(valid)
    expect(r.success).toBe(true)
    expect(r.data?.serviceTokens.get('monitor-client.access')).toBe('monitor')
  })
  it('never maps a prototype name to a service', () => {
    const r = AccessConfigSchema.parse(valid)
    for (const id of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) expect(r.serviceTokens.get(id)).toBeUndefined()
  })
  it('refuses 0, 1 or 3 apps, two of a kind, a shared host or aud, and a bad origin', () => {
    const [brand, inhouse] = valid.apps
    for (const apps of [[], [brand], [brand, inhouse, brand], [brand, { ...brand, origin: 'https://other.example.test', aud: B }],
      [brand, { ...inhouse, origin: brand.origin }], [brand, { ...inhouse, aud: A }], [brand, { ...inhouse, origin: 'not a url' }],
      [brand, { ...inhouse, origin: 'https://inhouse.example.test/path' }]]) {
      expect(AccessConfigSchema.safeParse({ ...valid, apps }).success).toBe(false)
    }
  })
  it('fails closed on unknown keys, at the top and in an app', () => {
    expect(AccessConfigSchema.safeParse({ ...valid, allowAll: true }).success).toBe(false)
    expect(AccessConfigSchema.safeParse({ ...valid, apps: [{ ...valid.apps[0], trusted: true }, valid.apps[1]] }).success).toBe(false)
  })
})
