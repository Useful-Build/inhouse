import { fc, test } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKOFF_MS, EXPIRY_MARGIN_MS, MAX_PENDING_TTL_MS, REJECTED_COOLDOWN_MS } from './core'
import { ACCOUNT, API, harness, LIFETIME_S, MemStore, readQuery, ringJson, START_MS, type Harness } from './testing/kit'

// Quiet the JSON log lines; tests that inspect them install their own spy.
beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())

const ok = { ok: true, value: { data: { shop: { name: 'Example Fixture' } } } }
const codeOf = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error!.code)

describe('grants and reads', () => {
  it('grants once, stores only an envelope, sets the alarm at half the lifetime and reads', async () => {
    const h = harness()
    expect(await readQuery(h)).toEqual(ok)
    expect(await readQuery(h)).toEqual(ok)
    expect(h.shop.grants).toBe(1)
    const r = h.store.record()!
    expect(r).toMatchObject({ v: 1, accountId: ACCOUNT, state: 'active', generation: 1, failures: 0, lastError: null, refresh: null })
    expect(r.scopes).toEqual(['read_orders', 'read_returns'])
    expect(r.expiresAtMs).toBe(START_MS + LIFETIME_S * 1000)
    const token = h.shop.reads[0]!.token
    expect(JSON.stringify([...h.store.map])).not.toContain(token)
    expect(h.alarm.at).toBe(START_MS + (LIFETIME_S * 1000) / 2)
    expect(h.shop.hosts).toEqual(new Set(['example-fixture.myshopify.com']))
  })

  it('refuses a mutation before any token is opened or any upstream call', async () => {
    const h = harness()
    expect(codeOf(await readQuery(h, 'mutation { productDelete(input: {id: "1"}) { deletedProductId } }'))).toBe('write_refused')
    expect(codeOf(await readQuery(h, '{ a } subscription { b }'))).toBe('write_refused')
    expect(h.shop.grants + h.shop.reads.length).toBe(0)
  })

  it('validates the request', async () => {
    const h = harness()
    expect(codeOf(await h.core.query({ accountId: ACCOUNT, document: '{ shop { currencyCode } }', apiVersion: '2026-11' }))).toBe('invalid_args')
    expect(codeOf(await h.core.query({ accountId: ACCOUNT, document: '{ shop { currencyCode } }', apiVersion: API, variables: [] as never }))).toBe('invalid_args')
    expect(codeOf(await h.core.query(null as never))).toBe('invalid_args')
  })

  it('P5 W2 (review H1): junk, undeclared, function and oversize variables are refused before any token or upstream call', async () => {
    const h = harness()
    const doc = 'query Q($q: String) { orders(first: 1, query: $q) { nodes { id } } }'
    const q = (variables: unknown) => h.core.query({ accountId: ACCOUNT, document: doc, apiVersion: API, variables: variables as never })
    expect(await q({ q: 'sku:"a"', junk: 'x'.repeat(1000) })).toMatchObject({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: field not allowed' } })
    expect(await q({ q: () => 'sku:"a"' })).toMatchObject({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: variables' } })
    expect(await q({ q: 'x'.repeat(16 * 1024) })).toMatchObject({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: variables' } })
    expect(h.shop.grants + h.shop.reads.length).toBe(0)
  })

  it('a call naming another account is internal and logged', async () => {
    const h = harness()
    await readQuery(h)
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    expect(codeOf(await h.core.query({ accountId: 'shopify:other', document: '{ shop { currencyCode } }', apiVersion: API }))).toBe('internal')
    expect(codeOf(h.core.status('shopify:other'))).toBe('internal')
    expect(lines.some(l => l.includes('"hub_internal"'))).toBe(true)
  })

  it('not configured, no scopes for the account, and a bad key ring', async () => {
    const h = harness()
    h.config.value = null
    expect(codeOf(await readQuery(h))).toBe('not_configured')
    const h2 = harness()
    expect(codeOf(await h2.core.query({ accountId: 'shopify:nobody', document: '{ shop { currencyCode } }', apiVersion: API }))).toBe('not_configured')
    for (const json of [undefined, '{}', JSON.stringify({ current: 'k1', keys: {} })]) {
      const h3 = harness({ ring: { json } })
      expect(codeOf(await readQuery(h3))).toBe('key_unavailable')
      expect(h3.shop.grants).toBe(0)
    }
  })

  const grantCases: [string, (h: Harness) => void, string, 'active' | 'failed' | 'empty'][] = [
    ['a 401 grant', h => (h.shop.grantMode = { kind: 'status', status: 401 }), 'credentials_rejected', 'failed'],
    ['shop_not_permitted', h => (h.shop.grantMode = { kind: 'status', status: 422, body: '{"error":"shop_not_permitted"}' }), 'credentials_rejected', 'failed'],
    ['a write scope', h => (h.shop.scope = 'read_orders,read_returns,write_orders'), 'scope_mismatch', 'failed'],
    ['read_returns missing', h => (h.shop.scope = 'read_orders'), 'scope_mismatch', 'failed'],
    ['no scope field', h => (h.shop.grantMode = { kind: 'body', body: '{"access_token":"t","expires_in":86399}' }), 'scope_mismatch', 'failed'],
    ['a 503', h => (h.shop.grantMode = { kind: 'status', status: 503 }), 'upstream_unavailable', 'empty'],
    ['a network error', h => (h.shop.grantMode = { kind: 'throw' }), 'upstream_unavailable', 'empty'],
    ['a malformed body', h => (h.shop.grantMode = { kind: 'body', body: 'nope' }), 'upstream_unavailable', 'empty'],
  ]
  for (const [name, arrange, code, state] of grantCases) {
    it(`from empty, ${name} is ${code} and leaves ${state}`, async () => {
      const h = harness()
      arrange(h)
      expect(codeOf(await readQuery(h))).toBe(code)
      expect(h.store.record()).toMatchObject({ state, token: null, failures: 1, lastError: { code, atMs: START_MS } })
    })
  }

  it('a rejected grant from active deletes the old token; a network failure keeps it', async () => {
    const h = harness()
    await readQuery(h)
    h.shop.grantMode = { kind: 'throw' }
    h.clock.ms = START_MS + (LIFETIME_S * 1000) / 2
    await h.core.alarm()
    expect(h.store.record()).toMatchObject({ state: 'active', failures: 1 })
    expect(h.store.record()!.token).not.toBeNull()
    expect(await readQuery(h)).toEqual(ok)
    h.shop.grantMode = { kind: 'status', status: 403 }
    await h.core.alarm()
    expect(h.store.record()).toMatchObject({ state: 'failed', token: null, failures: 2 })
    expect(h.store.record()!.generation).toBe(1)
  })

  it('a scope mismatch never stores the new token and deletes the old', async () => {
    const h = harness()
    await readQuery(h)
    h.shop.scope = 'read_orders,read_returns,write_products'
    h.clock.ms = START_MS + LIFETIME_S * 1000
    expect(codeOf(await readQuery(h))).toBe('scope_mismatch')
    expect(h.store.record()).toMatchObject({ state: 'failed', token: null })
    const err = await readQuery(h)
    expect(err.ok || err.error.message).toContain('write_products')
  })

  it('a 401 then success: one grant, one re-send', async () => {
    const h = harness()
    await readQuery(h)
    h.shop.revokeAll()
    expect(await readQuery(h)).toEqual(ok)
    expect(h.shop.grants).toBe(2)
    expect(h.shop.reads).toHaveLength(3)
    expect(h.store.record()!.generation).toBe(2)
  })

  it('two 401s: credentials_rejected, state failed, token deleted', async () => {
    const h = harness()
    await readQuery(h)
    h.shop.revokeAll()
    h.shop.nextToken = () => 'revoked-at-birth'
    const real = h.shop.upstream
    h.shop.upstream = async req => {
      const res = await real(req)
      h.shop.revokeAll()
      return res
    }
    expect(codeOf(await readQuery(h))).toBe('credentials_rejected')
    expect(h.store.record()).toMatchObject({ state: 'failed', token: null, lastError: { code: 'credentials_rejected' } })
    expect(h.shop.reads).toHaveLength(3)
  })

  it('after credentials_rejected, reads inside the cooldown answer the stored error with no token call', async () => {
    const h = harness()
    h.shop.grantMode = { kind: 'status', status: 401 }
    expect(codeOf(await readQuery(h))).toBe('credentials_rejected')
    h.shop.grantMode = { kind: 'ok' }
    h.clock.ms = START_MS + REJECTED_COOLDOWN_MS - 1
    expect(codeOf(await readQuery(h))).toBe('credentials_rejected')
    expect(codeOf(await readQuery(h))).toBe('credentials_rejected')
    expect(h.shop.grants).toBe(1)
    h.clock.ms = START_MS + REJECTED_COOLDOWN_MS
    expect(await readQuery(h)).toEqual(ok)
    expect(h.shop.grants).toBe(2)
  })

  it('a second 401 landing after another read stored a newer token leaves that token alone (generation check)', async () => {
    const h = harness()
    await readQuery(h) // generation 1
    h.shop.revokeAll()
    const real = h.shop.upstream
    let reads = 0
    h.shop.upstream = async req => {
      if (!new URL(req.url).pathname.endsWith('/access_token') && ++reads === 2) {
        // A's re-send (generation 2's token). Before it answers, C runs whole: its 401 grants generation 3, and its
        // re-send succeeds. Then A's re-send answers 401 too. Only the generation moved; the state is still active.
        h.shop.revokeAll()
        expect(await readQuery(h)).toEqual(ok)
      }
      return real(req)
    }
    expect(codeOf(await readQuery(h))).toBe('credentials_rejected')
    expect(h.store.record()).toMatchObject({ state: 'active', generation: 3, failures: 0, lastError: null })
    expect(h.store.record()!.token).not.toBeNull()
    const grants = h.shop.grants
    expect(await readQuery(h)).toEqual(ok)
    expect(h.shop.grants).toBe(grants)
  })
})

describe('pending items', () => {
  it('a second take gets null', async () => {
    const h = harness()
    expect((await h.core.putPending('state-abc', { verifier: 'v' }, 60_000)).ok).toBe(true)
    expect(JSON.stringify([...h.store.map.keys()])).not.toContain('state-abc')
    expect(await h.core.takePending('state-abc')).toEqual({ ok: true, value: { verifier: 'v' } })
    expect(await h.core.takePending('state-abc')).toEqual({ ok: true, value: null })
  })

  it('an expired item is deleted and returns null; the alarm sweeps expired ones', async () => {
    const h = harness()
    await h.core.putPending('a', 1, 1000)
    await h.core.putPending('b', 2, 5000)
    h.clock.ms += 1000
    expect(await h.core.takePending('a')).toEqual({ ok: true, value: null })
    expect([...h.store.map.keys()].filter(k => k.startsWith('pending:'))).toHaveLength(1)
    h.clock.ms += 4000
    await h.core.alarm()
    expect([...h.store.map.keys()].filter(k => k.startsWith('pending:'))).toHaveLength(0)
  })

  it('a TTL over 2 h, zero or negative is refused', async () => {
    const h = harness()
    for (const ttl of [MAX_PENDING_TTL_MS + 1, 0, -1, Number.NaN]) expect(codeOf(await h.core.putPending('k', 1, ttl))).toBe('invalid_args')
    expect((await h.core.putPending('k', 1, MAX_PENDING_TTL_MS)).ok).toBe(true)
  })
})

describe('disconnect and status', () => {
  it('disconnect deletes the token, bumps the generation, deletes the alarm; reads are not_configured', async () => {
    const h = harness()
    await readQuery(h)
    expect(await h.core.disconnect(ACCOUNT)).toEqual({ ok: true, value: { generation: 2 } })
    expect(h.store.record()).toMatchObject({ state: 'disconnected', token: null, refresh: null, generation: 2 })
    expect(h.alarm.at).toBeNull()
    expect(codeOf(await readQuery(h))).toBe('not_configured')
    await h.core.alarm()
    expect(h.shop.grants).toBe(1)
    expect(h.alarm.at).toBeNull()
  })

  it('a failed alarm write is logged and shown in status, never silent; the read still succeeds', async () => {
    const h = harness()
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    h.alarm.fail = true
    expect(await readQuery(h)).toEqual(ok)
    expect(lines.filter(l => l.includes('"alarm_op"'))).toHaveLength(1)
    const s = h.core.status(ACCOUNT)
    expect(s.ok && s.value).toMatchObject({ state: 'active', kid: 'k1', lastError: { code: 'internal', at: { ms: START_MS } } })
    expect(await h.core.disconnect(ACCOUNT)).toEqual({ ok: true, value: { generation: 2 } })
    expect(lines.filter(l => l.includes('"alarm_op"'))).toHaveLength(2)
    // The next good grant with a working alarm clears it.
    const h2 = harness()
    h2.alarm.fail = true
    await readQuery(h2)
    h2.alarm.fail = false
    h2.clock.ms = START_MS + LIFETIME_S * 1000
    expect(await readQuery(h2)).toEqual(ok)
    const s2 = h2.core.status(ACCOUNT)
    expect(s2.ok && s2.value.lastError).toBeNull()
    expect(h2.alarm.at).toBe(h2.clock.ms + (LIFETIME_S * 1000) / 2)
  })

  it('status reports state, kid, expiry and scopes, never the token', async () => {
    const h = harness()
    expect(h.core.status(ACCOUNT)).toEqual({
      ok: true,
      value: { accountId: ACCOUNT, state: 'empty', kid: null, expiresAt: null, scopes: [], lastError: null },
    })
    await readQuery(h)
    const s = h.core.status(ACCOUNT)
    expect(s.ok && s.value).toMatchObject({ state: 'active', kid: 'k1', scopes: ['read_orders', 'read_returns'] })
    expect(s.ok && s.value.expiresAt).toEqual({ ms: START_MS + LIFETIME_S * 1000, iso: new Date(START_MS + LIFETIME_S * 1000).toISOString() })
    expect(JSON.stringify(s)).not.toContain(h.shop.reads[0]!.token)
  })
})

// ---------- properties ----------

/** Runs `ops` concurrently under fast-check's scheduler, which orders every upstream delivery. */
async function interleave(s: fc.Scheduler, h: Harness, ops: (() => Promise<unknown>)[]) {
  h.shop.deliver = (p, label) => s.schedule(p, label)
  const running = ops.map(op => s.schedule(Promise.resolve(), 'start').then(op))
  await s.waitFor(Promise.all(running))
}

describe('single flight (property 5)', () => {
  test.prop([fc.scheduler(), fc.integer({ min: 1, max: 6 }), fc.boolean(), fc.integer({ min: 0, max: 2 }), fc.boolean()])(
    'at most one grant in flight, every read sent with a usable token, grants bounded by what needed them',
    async (s, reads, withAlarm, revokes, warm) => {
      const h = harness()
      if (warm) await readQuery(h)
      const grantsBefore = h.shop.grants
      const count401Before = h.shop.count401
      const ops: (() => Promise<unknown>)[] = []
      for (let i = 0; i < reads; i++) ops.push(() => readQuery(h))
      if (withAlarm) ops.push(() => h.core.alarm())
      for (let i = 0; i < revokes; i++) ops.push(async () => h.shop.revokeAll())
      await interleave(s, h, ops)
      expect(h.shop.maxGrantsInFlight).toBeLessThanOrEqual(1)
      expect(h.shop.reads.every(r => r.usableAtSend || h.shop.tokens.get(r.token)?.revoked)).toBe(true)
      const needed = (warm ? 0 : 1) + (h.shop.count401 - count401Before)
      expect(h.shop.grants - grantsBefore).toBeLessThanOrEqual(needed)
    },
  )
})

describe('refresh racing disconnect (property 6)', () => {
  test.prop([fc.scheduler(), fc.boolean(), fc.integer({ min: 1, max: 3 }), fc.boolean()])(
    'a disconnect landing while a grant is in flight ends disconnected with no token',
    async (s, warm, reads, viaAlarm) => {
      const h = harness()
      if (warm) {
        await readQuery(h)
        h.clock.ms = START_MS + LIFETIME_S * 1000 // expired: every path must grant
      }
      const ops: (() => Promise<unknown>)[] = []
      for (let i = 0; i < reads; i++) ops.push(() => readQuery(h))
      if (viaAlarm) ops.push(() => h.core.alarm())
      ops.push(async () => h.core.disconnect(ACCOUNT))
      await interleave(s, h, ops)
      const r = h.store.record()!
      expect(r.state).toBe('disconnected')
      expect(r.token).toBeNull()
      expect(r.refresh).toBeNull()
      expect(h.alarm.at).toBeNull()
    },
  )
})

describe('expiry and backoff (property 7)', () => {
  test.prop([fc.integer({ min: 0, max: 2 * LIFETIME_S * 1000 }), fc.integer({ min: 120, max: LIFETIME_S })])(
    'a token is never sent at or after expiresAtMs - 60 s',
    async (offset, lifetime) => {
      const h = harness()
      h.shop.expiresIn = lifetime
      await readQuery(h)
      h.clock.ms = START_MS + offset
      await readQuery(h)
      for (const r of h.shop.reads) expect(r.usableAtSend).toBe(true)
      const exp = START_MS + lifetime * 1000
      expect(h.shop.grants).toBe(START_MS + offset >= exp - EXPIRY_MARGIN_MS ? 2 : 1)
    },
  )

  it('the alarm refreshes at half the lifetime, then backs off 1, 5, 15, 60, 60 minutes while keeping the token', async () => {
    const h = harness()
    await readQuery(h)
    const half = START_MS + (LIFETIME_S * 1000) / 2
    expect(h.alarm.at).toBe(half)
    h.clock.ms = half
    h.shop.grantMode = { kind: 'status', status: 502 }
    const seen: number[] = []
    for (let i = 0; i < 5; i++) {
      await h.core.alarm()
      seen.push(h.alarm.at! - h.clock.ms)
      h.clock.ms = h.alarm.at!
    }
    expect(seen).toEqual([...BACKOFF_MS, BACKOFF_MS[3]])
    expect(h.store.record()).toMatchObject({ state: 'active', failures: 5 })
    expect(await readQuery(h)).toEqual(ok) // still usable: no inline grant succeeded, the old token was sent
    h.shop.grantMode = { kind: 'ok' }
    await h.core.alarm()
    expect(h.store.record()).toMatchObject({ state: 'active', failures: 0, generation: 2, obtainedAtMs: h.clock.ms })
    expect(h.alarm.at).toBe(h.clock.ms + (LIFETIME_S * 1000) / 2)
  })

  const misconfigured: [string, (h: Harness) => void, string][] = [
    ['no Shopify config', h => (h.config.value = null), 'not_configured'],
    ['a bad key ring', h => (h.ring.json = undefined), 'key_unavailable'],
  ]
  for (const [name, arrange, code] of misconfigured) {
    it(`a misconfigured alarm run (${name}) backs off 1, 5, 15, 60 minutes and status names ${code}`, async () => {
      const h = harness()
      await readQuery(h)
      h.clock.ms = START_MS + (LIFETIME_S * 1000) / 2
      arrange(h)
      const seen: number[] = []
      for (let i = 0; i < 4; i++) {
        await h.core.alarm()
        seen.push(h.alarm.at! - h.clock.ms)
        h.clock.ms = h.alarm.at!
      }
      expect(seen).toEqual([...BACKOFF_MS])
      const s = h.core.status(ACCOUNT)
      expect(s.ok && s.value).toMatchObject({ state: 'active', lastError: { code } })
      expect(h.shop.grants).toBe(1)
    })
  }

  it('a repeated alarm that is not due changes nothing', async () => {
    const h = harness()
    await readQuery(h)
    await h.core.alarm() // the same instant as the grant: not due
    h.clock.ms += 1000
    const before = structuredClone([...h.store.map])
    const alarmBefore = h.alarm.at
    await h.core.alarm()
    await h.core.alarm()
    expect([...h.store.map]).toEqual(before)
    expect(h.alarm.at).toBe(alarmBefore)
    expect(h.shop.grants).toBe(1)
  })

  it('the alarm survives a throwing dependency and sets its own next alarm', async () => {
    const h = harness()
    await readQuery(h)
    h.clock.ms = START_MS + LIFETIME_S * 1000
    vi.spyOn(console, 'log').mockImplementation(() => {})
    h.ring.json = undefined
    ;(h.store as MemStore).put('record', { ...h.store.record()!, failures: 2 })
    await expect(h.core.alarm()).resolves.toBeUndefined()
    // The bad ring is a failed grant now (failures 2 -> 3), so the third step.
    expect(h.alarm.at).toBe(h.clock.ms + BACKOFF_MS[2])
  })
})

describe('rotation (property 2)', () => {
  type Op = { kind: 'add' } | { kind: 'switch'; pick: number } | { kind: 'remove'; pick: number } | { kind: 'seal' }
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.constant({ kind: 'add' as const }),
    fc.nat().map(pick => ({ kind: 'switch' as const, pick })),
    fc.nat().map(pick => ({ kind: 'remove' as const, pick })),
    fc.constant({ kind: 'seal' as const }),
  )

  test.prop([fc.array(op, { maxLength: 12 })])(
    'opens while its kid is in the ring, re-seals under current on read, and a removed kid is key_unavailable',
    async ops => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const keys = new Map<string, string>()
      let kids = ['k0']
      let current = 'k0'
      let next = 1
      const ring = { json: ringJson(kids, current, keys) as string | undefined }
      const accounts: { h: Harness; token: string; kid: string }[] = []
      for (const o of ops) {
        if (o.kind === 'add') kids = [...kids, `k${next++}`]
        if (o.kind === 'switch') current = kids[o.pick % kids.length]!
        if (o.kind === 'remove') {
          const victim = kids[o.pick % kids.length]!
          if (victim !== current) kids = kids.filter(k => k !== victim)
        }
        ring.json = ringJson(kids, current, keys)
        if (o.kind === 'seal') {
          const h = harness({ ring })
          await readQuery(h)
          accounts.push({ h, token: h.shop.reads[0]!.token, kid: h.store.record()!.token!.kid })
        }
      }
      for (const a of accounts) {
        expect(a.kid).toBeDefined()
        const inRing = kids.includes(a.kid)
        const re = await a.h.core.reencrypt(ACCOUNT)
        if (inRing) {
          expect(re).toEqual({ ok: true, value: { kid: current, changed: a.kid !== current } })
          expect(await readQuery(a.h)).toEqual(ok)
          expect(a.h.shop.reads.at(-1)!.token).toBe(a.token)
          expect(a.h.store.record()!.token!.kid).toBe(current)
        } else {
          expect(codeOf(re)).toBe('key_unavailable')
          // Client credentials: a token under a removed key is discarded and granted again, never plaintext.
          expect(await readQuery(a.h)).toEqual(ok)
          expect(a.h.shop.reads.at(-1)!.token).not.toBe(a.token)
          expect(a.h.store.record()!.token!.kid).toBe(current)
        }
      }
    },
  )

  it('lazy re-encryption on read, under the generation check', async () => {
    const keys = new Map<string, string>()
    const ring = { json: ringJson(['k1'], 'k1', keys) as string | undefined }
    const h = harness({ ring })
    await readQuery(h)
    ring.json = ringJson(['k1', 'k2'], 'k2', keys)
    expect(await readQuery(h)).toEqual(ok)
    expect(h.store.record()).toMatchObject({ generation: 1, token: { kid: 'k2' } })
    expect(h.shop.grants).toBe(1)
    expect(await h.core.reencrypt(ACCOUNT)).toEqual({ ok: true, value: { kid: 'k2', changed: false } })
  })
})

describe('re-encryption racing a rejection (the sameEnvelope guard)', () => {
  // Captured once: each run re-mocks encrypt with its own scheduler.
  const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle)

  test.prop([fc.scheduler(), fc.constantFrom('read' as const, 'reencrypt' as const), fc.constantFrom('403' as const, 'write scope' as const)])(
    'a token deleted by a rejected refresh while a re-seal is in flight is never written back',
    async (s, via, rejection) => {
      const keys = new Map<string, string>()
      const ring = { json: ringJson(['k1'], 'k1', keys) as string | undefined }
      const h = harness({ ring })
      await readQuery(h)
      ring.json = ringJson(['k1', 'k2'], 'k2', keys) // the stored token now needs a re-seal
      h.clock.ms = START_MS + (LIFETIME_S * 1000) / 2 // the refresh is due; the token is still usable
      if (rejection === '403') h.shop.grantMode = { kind: 'status', status: 403 }
      else h.shop.scope = 'read_orders,read_returns,write_orders'
      vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(((...a: Parameters<typeof realEncrypt>) =>
        s.schedule(realEncrypt(...a), 'encrypt')) as typeof realEncrypt)
      await interleave(s, h, [via === 'read' ? () => readQuery(h) : () => h.core.reencrypt(ACCOUNT), () => h.core.alarm()])
      const r = h.store.record()!
      expect(r.state).toBe('failed') // the refresh is rejected in every order
      expect(r.token).toBeNull()
      expect(r.generation).toBe(1)
    },
  )
})

describe('the canary token (property 8)', () => {
  test.prop([fc.stringMatching(/^[A-Za-z0-9]{24,40}$/), fc.stringMatching(/^[A-Za-z0-9]{24,40}$/)])(
    'never appears in a result, an error message or a log line on any path',
    async (canary, secret) => {
      fc.pre(canary !== secret)
      const lines: string[] = []
      for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
        vi.spyOn(console, method).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))
      }
      const results: unknown[] = []
      const run = async (arrange: (h: Harness) => void, after?: (h: Harness) => Promise<void>) => {
        const h = harness({ secret })
        h.shop.nextToken = () => canary
        arrange(h)
        results.push(await readQuery(h))
        if (after) await after(h)
        results.push(h.core.status(ACCOUNT), await h.core.reencrypt(ACCOUNT))
        expect(JSON.stringify([...h.store.map])).not.toContain(canary)
        expect(JSON.stringify([...h.store.map])).not.toContain(secret)
      }
      await run(() => {})
      await run(h => (h.shop.grantMode = { kind: 'status', status: 401, body: `{"error":"${secret}"}` }))
      await run(h => (h.shop.grantMode = { kind: 'status', status: 500, body: canary }))
      await run(h => (h.shop.grantMode = { kind: 'throw' }))
      await run(h => (h.shop.scope = `read_returns,write_${canary.toLowerCase()}`))
      await run(h => (h.shop.readMode = { kind: 'throw' }))
      await run(h => (h.shop.readMode = { kind: 'response', make: () => new Response(canary, { status: 400 }) }))
      await run(h => (h.shop.readMode = { kind: 'response', make: () => new Response(JSON.stringify({ errors: [{ message: canary, extensions: { code: canary } }] })) }))
      await run(
        () => {},
        async h => {
          h.shop.revokeAll()
          results.push(await readQuery(h))
          h.shop.nextToken = () => `${canary}x`
          h.shop.revokeAll()
          results.push(await readQuery(h))
          results.push(await h.core.query({ accountId: 'shopify:other', document: '{ shop { currencyCode } }', apiVersion: API }))
          h.clock.ms += LIFETIME_S * 1000
          await h.core.alarm()
        },
      )
      const all = JSON.stringify(results) + '\n' + lines.join('\n')
      expect(all).not.toContain(canary)
      expect(all).not.toContain(secret)
    },
  )
})
