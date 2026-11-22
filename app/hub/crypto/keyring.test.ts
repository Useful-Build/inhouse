import { afterEach, describe, expect, it, vi } from 'vitest'
import { keyRingFor, parseKeyRing } from './keyring'
import { ringJson } from '../signin/testing/kit'

const key32 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const key16 = btoa(String.fromCharCode(...new Uint8Array(16).fill(7)))

describe('HUB_TOKEN_KEYS', () => {
  afterEach(() => vi.restoreAllMocks())

  it('parses a valid ring with non-extractable AES-GCM keys', async () => {
    const r = await parseKeyRing(ringJson(['k1', 'k2-b'], 'k2-b'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ring.current).toBe('k2-b')
    const key = r.ring.keys.get('k1')!
    expect(key.extractable).toBe(false)
    expect(key.algorithm.name).toBe('AES-GCM')
    expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt'])
  })

  const invalid: [string, string | undefined][] = [
    ['missing', undefined],
    ['empty', ''],
    ['not JSON', '{'],
    ['current absent from keys', JSON.stringify({ current: 'k2', keys: { k1: key32 } })],
    ['a key not 32 bytes', JSON.stringify({ current: 'k1', keys: { k1: key16 } })],
    ['a key not base64', JSON.stringify({ current: 'k1', keys: { k1: '!!!!' } })],
    ['a bad kid', JSON.stringify({ current: 'K1', keys: { K1: key32 } })],
    ['an extra field', JSON.stringify({ current: 'k1', keys: { k1: key32 }, extra: 1 })],
    ['no keys', JSON.stringify({ current: 'k1', keys: {} })],
  ]
  for (const [name, raw] of invalid) {
    it(`refuses ${name}, never a default key`, async () => {
      expect(await parseKeyRing(raw)).toEqual({ ok: false })
    })
  }

  it('logs once per isolate when the ring is invalid, and never the secret', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    const secret = JSON.stringify({ current: 'k1', keys: { k1: key16 } })
    expect(await keyRingFor({ HUB_TOKEN_KEYS: secret })).toEqual({ ok: false })
    expect(await keyRingFor({ HUB_TOKEN_KEYS: secret })).toEqual({ ok: false })
    expect(await keyRingFor({})).toEqual({ ok: false })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual({ event: 'hub_config_invalid', code: 'key_unavailable' })
    expect(lines.join('\n')).not.toContain(key16)
  })

  it('caches per env object', async () => {
    const env = { HUB_TOKEN_KEYS: ringJson(['k1'], 'k1') }
    expect(keyRingFor(env)).toBe(keyRingFor(env))
  })
})
