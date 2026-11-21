// P5 W1 brief test 9 and test 3's grep: H0's Shopify path is unchanged by the OAuth extension. The same generated
// event sequence runs on H0's core as merged (testing/h0-core.ts, a verbatim copy at the cut) and on the extended core;
// results, records (envelopes compared by kid, since every seal draws a fresh IV) and log lines must be identical.
// One deliberate difference (the #248 review, item 8d): with no record or a disconnected one, the extended alarm re-arms
// itself at the next live one-time item's expiry, where H0 set nothing. Alarm histories are compared without those
// entries, and a second property checks each extra entry is exactly such an expiry.
import { fc, test } from '@fast-check/vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseKeyRing, type KeyRingResult } from '../crypto/keyring'
import { SignInCore } from '../signin/core'
import { ACCOUNT, API, FakeAlarm, FakeShop, MemStore, ringJson, SCOPES, START_MS } from '../signin/testing/kit'
import { H0SignInCore } from './testing/h0-core'

afterEach(() => vi.restoreAllMocks())

type Op =
  | { k: 'read' }
  | { k: 'advance'; ms: number }
  | { k: 'alarm' }
  | { k: 'disconnect' }
  | { k: 'status' }
  | { k: 'reencrypt' }
  | { k: 'rotate' }
  | { k: 'grant'; mode: 'ok' | '401' | '503' | 'throw' }
  | { k: 'pending'; key: string; ttl: number }
  | { k: 'take'; key: string }

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.constant({ k: 'read' as const }),
  fc.record({ k: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 48 * 3600_000 }) }),
  fc.constant({ k: 'alarm' as const }),
  fc.constant({ k: 'disconnect' as const }),
  fc.constant({ k: 'status' as const }),
  fc.constant({ k: 'reencrypt' as const }),
  fc.constant({ k: 'rotate' as const }),
  fc.record({ k: fc.constant('grant' as const), mode: fc.constantFrom('ok' as const, '401' as const, '503' as const, 'throw' as const) }),
  fc.record({ k: fc.constant('pending' as const), key: fc.constantFrom('a', 'b'), ttl: fc.integer({ min: 1, max: 3 * 3600_000 }) }),
  fc.record({ k: fc.constant('take' as const), key: fc.constantFrom('a', 'b') }),
)

function side(make: 'h0' | 'v2', keys: Map<string, string>) {
  const clock = { ms: START_MS }
  const store = new MemStore()
  const alarm = new FakeAlarm()
  const shop = new FakeShop(() => clock.ms)
  let n = 0
  shop.nextToken = () => `tok-${++n}`
  const ring = { json: ringJson(['k1'], 'k1', keys) }
  const deps = {
    store,
    now: () => clock.ms,
    alarm,
    upstream: async () => shop.upstream,
    keyring: (): Promise<KeyRingResult> => parseKeyRing(ring.json),
    shopify: () => ({ shop: 'example-fixture', clientId: 'test-client', clientSecret: 'test-secret' }),
    scopesFor: async (id: string) => (id === ACCOUNT ? SCOPES : null),
  }
  const core = make === 'h0' ? new H0SignInCore(deps) : new SignInCore(deps)
  return { core, clock, store, alarm, shop, ring }
}

/** Envelopes by kid only: a fresh IV per seal makes the ciphertext differ run to run. */
const comparable = (store: MemStore) =>
  JSON.parse(JSON.stringify([...store.map]), (_k, v) => (v && typeof v === 'object' && 'ct' in v && 'iv' in v ? { kid: v.kid } : v))

describe('test 9: H0 unchanged', () => {
  test.prop([fc.array(op, { maxLength: 14 })], { numRuns: 120 })('the same events on H0 as merged and on the v2 core give the same results, records and logs', async ops => {
    const keys = new Map<string, string>()
    const a = side('h0', keys)
    const b = side('v2', keys)
    const logs: { a: string[]; b: string[] } = { a: [], b: [] }
    const expiries = new Set<number>()
    let target: 'a' | 'b' = 'a'
    vi.spyOn(console, 'log').mockImplementation((...x: unknown[]) => void logs[target].push(x.map(String).join(' ')))
    for (const o of ops) {
      const out: unknown[] = []
      for (const [name, s] of [['a', a], ['b', b]] as const) {
        target = name
        switch (o.k) {
          case 'read':
            out.push(await s.core.query({ accountId: ACCOUNT, document: '{ shop { name } }', apiVersion: API }))
            break
          case 'advance':
            s.clock.ms += o.ms
            break
          case 'alarm':
            out.push(await s.core.alarm())
            break
          case 'disconnect':
            out.push(await s.core.disconnect(ACCOUNT))
            break
          case 'status':
            out.push(s.core.status(ACCOUNT))
            break
          case 'reencrypt':
            out.push(await s.core.reencrypt(ACCOUNT))
            break
          case 'rotate':
            s.ring.json = ringJson(['k1', 'k2'], 'k2', keys)
            break
          case 'grant':
            s.shop.grantMode = o.mode === 'ok' ? { kind: 'ok' } : o.mode === 'throw' ? { kind: 'throw' } : { kind: 'status', status: Number(o.mode) }
            break
          case 'pending':
            {
              const put = await s.core.putPending(o.key, { v: o.key }, o.ttl)
              if (put.ok) expiries.add(put.value.expiresAtMs)
              out.push(put)
            }
            break
          case 'take':
            out.push(await s.core.takePending(o.key))
            break
        }
      }
      expect(JSON.stringify(out[0])).toBe(JSON.stringify(out[1]))
    }
    expect(comparable(b.store)).toEqual(comparable(a.store))
    // H0's own entries, in order; any extra entry on the extended core is a pending item's expiry (the re-arm).
    const withoutRearm = (h: (number | null)[]) => h.filter(x => x === null || !expiries.has(x))
    expect(withoutRearm(b.alarm.history)).toEqual(withoutRearm(a.alarm.history))
    for (const x of b.alarm.history) if (!a.alarm.history.includes(x)) expect(x !== null && expiries.has(x)).toBe(true)
    expect(b.shop.grants).toBe(a.shop.grants)
    expect(logs.b).toEqual(logs.a)
  })

  it("#stillCurrent's body is byte-identical to H0's", () => {
    const body = (file: string) => {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url).href), 'utf8')
      const start = src.indexOf('  #stillCurrent(accountId: string, generation: number)')
      expect(start).toBeGreaterThan(0)
      return src.slice(start, src.indexOf('\n  }\n', start) + 4)
    }
    expect(body('../signin/core.ts')).toBe(body('./testing/h0-core.ts'))
    expect(body('../signin/core.ts')).toContain("r.state === 'disconnected'")
  })
})
