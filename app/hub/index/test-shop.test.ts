// The test shop override's decision (test-shop.ts). Ways it can go wrong, written first:
//  1. the deployable hub honours an override (it must refuse it, whatever the host);
//  2. the test build honours a host its seam doesn't register (a real store's host must never be reached);
//  3. a refused or malformed override quietly falls back to SHOPIFY_SHOP (it must be an error, never `shop: null`);
//  4. the handle is cut wrong (the hub builds `https://<handle>.myshopify.com`).
import { fc } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { decideTestShop } from './test-shop'

const HOST = 'example-mc-late-orders.myshopify.com'
const only = (h: string) => (host: string) => host === h
const refused = { ok: false, error: { code: 'invalid_args', message: 'invalid arguments: testShopHost' } }

describe('decideTestShop', () => {
  it('no options, or none asked for: the hub\'s own shop, in either build', () => {
    for (const testBuild of [false, true]) {
      expect(decideTestShop(undefined, testBuild, () => true)).toEqual({ ok: true, value: { shop: null } })
      expect(decideTestShop({}, testBuild, () => true)).toEqual({ ok: true, value: { shop: null } })
    }
  })

  it('the deployable hub refuses any override, even a host the seam would register (failure 1, 3)', () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/), handle => {
      expect(decideTestShop({ testShopHost: `${handle}.myshopify.com` }, false, () => true)).toEqual(refused)
    }))
  })

  it('the test build refuses a host its seam doesn\'t register (failure 2, 3)', () => {
    expect(decideTestShop({ testShopHost: 'real-store.myshopify.com' }, true, only(HOST))).toEqual(refused)
  })

  it('the test build honours a registered host as its handle (failure 4)', () => {
    expect(decideTestShop({ testShopHost: HOST }, true, only(HOST))).toEqual({ ok: true, value: { shop: 'example-mc-late-orders' } })
  })

  it('malformed options are refused before the seam is asked, in either build (failure 3)', () => {
    for (const testBuild of [false, true]) {
      for (const options of [null, 'x', { testShopHost: 'evil.example' }, { testShopHost: HOST, extra: 1 }, { testShopHost: `${HOST}/x` }]) {
        let asked = false
        const r = decideTestShop(options, testBuild, () => { asked = true; return true })
        expect(r.ok, JSON.stringify(options)).toBe(false)
        expect(asked).toBe(false)
      }
    }
  })
})
