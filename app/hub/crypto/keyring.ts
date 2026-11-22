// The token key ring (OC 15): one Worker secret HUB_TOKEN_KEYS, JSON
// `{ "current": "<kid>", "keys": { "<kid>": "<base64 of 32 random bytes>" } }`. Parsed once per isolate per env
// object; keys imported as non-extractable AES-GCM CryptoKeys. Missing or invalid: every call that needs a token gets
// `key_unavailable`, with one log line per isolate. Never a default key, never plaintext.
// https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ (read 2026-11-20)
import { z } from 'zod'
import { log } from '../index/log'

export const KID = /^k[0-9a-z-]{1,31}$/

const RingSchema = z.strictObject({
  current: z.string().regex(KID),
  keys: z.record(z.string().regex(KID), z.string()),
})

export type KeyRing = { current: string; keys: ReadonlyMap<string, CryptoKey> }
export type KeyRingResult = { ok: true; ring: KeyRing } | { ok: false }

function decodeBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
  try {
    const bin = atob(text)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** Parses and imports a ring. Pure: no cache, no log. */
export async function parseKeyRing(raw: string | undefined): Promise<KeyRingResult> {
  if (!raw) return { ok: false }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  const parsed = RingSchema.safeParse(json)
  if (!parsed.success) return { ok: false }
  const { current, keys } = parsed.data
  if (!Object.hasOwn(keys, current)) return { ok: false }
  const imported = new Map<string, CryptoKey>()
  for (const [kid, b64] of Object.entries(keys)) {
    const bytes = decodeBase64(b64)
    if (!bytes || bytes.length !== 32) return { ok: false }
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    bytes.fill(0)
    imported.set(kid, key)
  }
  return { ok: true, ring: { current, keys: imported } }
}

// Keyed by the env object (stable per isolate), so the cache holds CryptoKeys only, never a copy of the secret text.
const cache = new WeakMap<object, Promise<KeyRingResult>>()
let loggedInvalid = false

/** The isolate's ring for this env. Logs `hub_config_invalid` once per isolate when the secret is missing or invalid. */
export function keyRingFor(env: { HUB_TOKEN_KEYS?: string }): Promise<KeyRingResult> {
  let ring = cache.get(env)
  if (!ring) {
    ring = parseKeyRing(env.HUB_TOKEN_KEYS).then(
      result => {
        if (!result.ok && !loggedInvalid) {
          loggedInvalid = true
          log('hub_config_invalid', { code: 'key_unavailable' })
        }
        return result
      },
      () => {
        if (!loggedInvalid) {
          loggedInvalid = true
          log('hub_config_invalid', { code: 'key_unavailable' })
        }
        return { ok: false } as const
      },
    )
    cache.set(env, ring)
  }
  return ring
}
