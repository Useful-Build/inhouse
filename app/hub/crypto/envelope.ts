// Token envelopes: AES-GCM 256, a fresh 96-bit IV from getRandomValues per seal, 128-bit tag, base64url fields.
// AAD binds the envelope to its account, field and kid, so an envelope copied to another account or field, or
// relabelled with another kid, fails to open.
// https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ and MDN AesGcmParams (read 2026-11-20)
import type { KeyRing } from './keyring'

export type Envelope = { kid: string; iv: string; ct: string }
/** P5 (p5-w1) adds `client` (a dynamic client's registration) and `pkce` (a pending connect's verifier). */
export type EnvelopeField = 'token' | 'refresh' | 'client' | 'pkce'
export type OpenResult = { ok: true; plaintext: string; kid: string } | { ok: false; reason: 'key_missing' | 'invalid' }

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

const aad = (accountId: string, field: EnvelopeField, kid: string) =>
  enc.encode(`inhouse-hub/v1\n${accountId}\n${field}\n${kid}`)

/** Seals under the ring's current key. */
export async function seal(ring: KeyRing, accountId: string, field: EnvelopeField, plaintext: string): Promise<Envelope> {
  const kid = ring.current
  const key = ring.keys.get(kid)
  if (!key) throw new Error('current key missing from ring')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(accountId, field, kid), tagLength: 128 },
    key,
    enc.encode(plaintext),
  )
  return { kid, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) }
}

export async function open(ring: KeyRing, accountId: string, field: EnvelopeField, envelope: Envelope): Promise<OpenResult> {
  const key = ring.keys.get(envelope.kid)
  if (!key) return { ok: false, reason: 'key_missing' }
  const iv = fromBase64Url(envelope.iv)
  const ct = fromBase64Url(envelope.ct)
  if (!iv || iv.length !== 12 || !ct || ct.length < 16) return { ok: false, reason: 'invalid' }
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(accountId, field, envelope.kid), tagLength: 128 },
      key,
      ct,
    )
    return { ok: true, plaintext: dec.decode(pt), kid: envelope.kid }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

export const sameEnvelope = (a: Envelope | null, b: Envelope | null): boolean =>
  a === b || (a !== null && b !== null && a.kid === b.kid && a.iv === b.iv && a.ct === b.ct)
