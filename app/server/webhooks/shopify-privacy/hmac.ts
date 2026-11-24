// Shopify's webhook signature (https://shopify.dev/docs/apps/build/webhooks/subscribe/https, read 2026-11-22): the
// X-Shopify-Hmac-Sha256 header is the base64 HMAC-SHA256 of the raw request body, keyed with the app's client secret.
// Each brand has two Shopify apps (read and write), so a delivery verifies under either secret. Every secret is tried,
// whatever matched first, and each compare is the runtime's `crypto.subtle.timingSafeEqual`.

const enc = new TextEncoder()
const DIGEST_BYTES = 32

/** Workers' constant-time compare (https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal); the DOM lib's SubtleCrypto type lacks it. */
const timingSafeEqual = (a: ArrayBuffer, b: Uint8Array): boolean =>
  (crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean }).timingSafeEqual(a, b)
const BASE64 = /^[A-Za-z0-9+/]{43}=$/

async function hmac(body: Uint8Array, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', key, new Uint8Array(body))
}

/** The header value Shopify would send for `body` under `secret` (tests and the test build's signer). */
export async function signShopifyBody(body: Uint8Array, secret: string): Promise<string> {
  return btoa(String.fromCharCode(...new Uint8Array(await hmac(body, secret))))
}

/** Whether `header` is the signature of `body` under one of `secrets`. A missing or malformed header is false. */
export async function verifyShopifyHmac(body: Uint8Array, header: string | null, secrets: readonly string[]): Promise<boolean> {
  // A SHA-256 digest is always 32 bytes: 44 base64 characters ending in one `=`. Its length is public, so checking it
  // first leaks nothing.
  if (header === null || !BASE64.test(header)) return false
  const given = Uint8Array.from(atob(header), c => c.charCodeAt(0))
  if (given.length !== DIGEST_BYTES) return false
  let ok = false
  for (const secret of secrets) {
    if (timingSafeEqual(await hmac(body, secret), given)) ok = true
  }
  return ok
}
