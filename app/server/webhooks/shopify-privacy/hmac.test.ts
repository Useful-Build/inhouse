// Shopify's webhook HMAC (https://shopify.dev/docs/apps/build/webhooks/subscribe/https): base64 HMAC-SHA256 of the raw
// body under the app's client secret, in X-Shopify-Hmac-Sha256. Ways it could fail, written down first:
//  1. a missing, empty, non-base64 or wrong-length header passes;
//  2. a body changed by any one byte, or signed with another secret, passes;
//  3. only the first of the brand's two app secrets is tried (the write app's deliveries fail);
//  4. the compare is a plain string or byte loop that returns early (timing), not the runtime's timing-safe compare;
//  5. an empty secret list verifies anything.
import { fc, it as prop } from '@fast-check/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { signShopifyBody, verifyShopifyHmac } from './hmac.ts'

const enc = new TextEncoder()
const READ = 'test-only-read-app-secret'
const WRITE = 'test-only-write-app-secret'
const body = enc.encode('{"shop_id":954889,"shop_domain":"invented-shop.myshopify.com"}')

afterEach(() => vi.restoreAllMocks())

describe('verifyShopifyHmac', () => {
  it('accepts the signature of either app secret, and a known vector', async () => {
    expect(await verifyShopifyHmac(body, await signShopifyBody(body, READ), [READ, WRITE])).toBe(true)
    expect(await verifyShopifyHmac(body, await signShopifyBody(body, WRITE), [READ, WRITE])).toBe(true)
    // RFC 4231-style check of the encoding: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog"), base64.
    expect(await signShopifyBody(enc.encode('The quick brown fox jumps over the lazy dog'), 'key')).toBe('97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=')
  })
  it('refuses a missing, empty, malformed or wrong-length header (failure 1)', async () => {
    for (const h of [null, '', 'not base64!', 'AAAA', `${await signShopifyBody(body, READ)}AA==`, (await signShopifyBody(body, READ)).toLowerCase()]) {
      expect(await verifyShopifyHmac(body, h, [READ, WRITE]), String(h)).toBe(false)
    }
  })
  it('refuses another secret (failure 2) and an empty secret list (failure 5)', async () => {
    expect(await verifyShopifyHmac(body, await signShopifyBody(body, 'another-app-secret'), [READ, WRITE])).toBe(false)
    expect(await verifyShopifyHmac(body, await signShopifyBody(body, READ), [])).toBe(false)
  })
  it('compares with the runtime timing-safe compare, once per secret, whatever matches (failure 4)', async () => {
    const spy = vi.spyOn(crypto.subtle as SubtleCrypto & { timingSafeEqual: (a: ArrayBuffer, b: ArrayBufferView) => boolean }, 'timingSafeEqual')
    expect(await verifyShopifyHmac(body, await signShopifyBody(body, READ), [READ, WRITE])).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockClear()
    expect(await verifyShopifyHmac(body, await signShopifyBody(body, 'x'), [READ, WRITE])).toBe(false)
    expect(spy).toHaveBeenCalledTimes(2)
  })
  prop.prop([fc.uint8Array({ minLength: 1, maxLength: 512 }), fc.nat(), fc.integer({ min: 1, max: 255 })], { numRuns: 200 })(
    'any one-byte change to a signed body fails (failure 2)',
    async (bytes, at, delta) => {
      const sig = await signShopifyBody(bytes, READ)
      expect(await verifyShopifyHmac(bytes, sig, [READ, WRITE])).toBe(true)
      const changed = bytes.slice()
      const i = at % changed.length
      changed[i] = (changed[i] + delta) % 256
      expect(await verifyShopifyHmac(changed, sig, [READ, WRITE])).toBe(false)
    },
  )
  prop.prop([fc.uint8Array({ maxLength: 256 }), fc.nat(31), fc.integer({ min: 1, max: 255 })], { numRuns: 200 })(
    'any one-byte change to the signature fails (failure 1)',
    async (bytes, at, delta) => {
      const raw = Uint8Array.from(atob(await signShopifyBody(bytes, WRITE)), c => c.charCodeAt(0))
      raw[at] = (raw[at] + delta) % 256
      expect(await verifyShopifyHmac(bytes, btoa(String.fromCharCode(...raw)), [READ, WRITE])).toBe(false)
    },
  )
})
