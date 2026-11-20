import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { fromBase64Url, open, seal, toBase64Url, type Envelope } from './envelope'
import { parseKeyRing, type KeyRing } from './keyring'
import { ringJson } from '../signin/testing/kit'

async function ring(kids = ['k1', 'k2'], current = 'k1'): Promise<KeyRing> {
  const r = await parseKeyRing(ringJson(kids, current))
  if (!r.ok) throw new Error('test ring invalid')
  return r.ring
}

const account = fc.stringMatching(/^[a-z]+(:[a-z0-9-]{1,40})?$/)
const field = fc.constantFrom('token' as const, 'refresh' as const)
const plaintext = fc.string({ unit: 'grapheme', maxLength: 200 })

/** Flip one bit of one byte of a base64url field. */
function flip(b64: string, index: number, bit: number): string {
  const bytes = fromBase64Url(b64)!
  bytes[index % bytes.length]! ^= 1 << bit
  return toBase64Url(bytes)
}

describe('the envelope', () => {
  test.prop([plaintext, account, field])('open(seal(x)) returns x', async (x, acct, f) => {
    const r = await ring()
    const env = await seal(r, acct, f, x)
    expect(env.kid).toBe('k1')
    expect(await open(r, acct, f, env)).toEqual({ ok: true, plaintext: x, kid: 'k1' })
  })

  test.prop([plaintext, account, field, fc.nat(), fc.integer({ min: 0, max: 7 }), fc.constantFrom('iv' as const, 'ct' as const)])(
    'changing any byte of iv or ct fails to open',
    async (x, acct, f, index, bit, part) => {
      const r = await ring()
      const env = await seal(r, acct, f, x)
      const bad: Envelope = { ...env, [part]: flip(env[part], index, bit) }
      expect((await open(r, acct, f, bad)).ok).toBe(false)
    },
  )

  test.prop([plaintext, account, account, field])('another account fails to open', async (x, a, b, f) => {
    fc.pre(a !== b)
    const r = await ring()
    expect((await open(r, b, f, await seal(r, a, f, x))).ok).toBe(false)
  })

  test.prop([plaintext, account])('another field fails to open', async (x, acct) => {
    const r = await ring()
    expect((await open(r, acct, 'refresh', await seal(r, acct, 'token', x))).ok).toBe(false)
  })

  test.prop([plaintext, account, field])('a relabelled kid fails to open', async (x, acct, f) => {
    const r = await ring()
    const env = await seal(r, acct, f, x)
    expect(await open(r, acct, f, { ...env, kid: 'k2' })).toEqual({ ok: false, reason: 'invalid' })
    expect(await open(r, acct, f, { ...env, kid: 'k9' })).toEqual({ ok: false, reason: 'key_missing' })
  })

  test.prop([plaintext, account, field])('two seals of one plaintext differ', async (x, acct, f) => {
    const r = await ring()
    const a = await seal(r, acct, f, x)
    const b = await seal(r, acct, f, x)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  test.prop([plaintext, account, field])('the envelope never carries the plaintext', async (x, acct, f) => {
    fc.pre(x.length >= 4)
    const r = await ring()
    expect(JSON.stringify(await seal(r, acct, f, x))).not.toContain(JSON.stringify(x).slice(1, -1))
  })
})
