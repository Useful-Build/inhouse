// A connection in the SignIn core and the gateway's methods (Stage 1 M4-R1, N35). Ways it could go wrong, written
// first: a record put half written or with a field missing; a v1 or v2 record no longer read (Shopify and Slack break),
// or a v1/v2 path overwriting a connection's record; a `run` scope getting past any new method; an Admin preparing,
// changing or removing a connection; key rotation or teardown missing a listed connection.
import { describe, expect, it } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import type { CallerScope } from '../index/contract'
import { createMcpFixtures } from '../../test/upstreams/mcp/index'
import { open, seal } from '../crypto/envelope'
import { parseKeyRing } from '../crypto/keyring'
import type { SignInRecord } from '../signin/core'
import { MemStore, ringJson } from '../signin/testing/kit'
import * as G from './gateway'
import { setPaused as gatewaySetPaused, disconnect as gatewayDisconnect } from '../oauth/gateway'
import { INDEX_OBJECT } from './index'
import { checkRecord, ConnectionRecordSchema, ConnectionTombstoneSchema, isStoredConnection, type ConnectionRecord } from './record'
import { admin, binding, ConnWorld, inhouse, KEYED, run, server } from './testing/kit'
import { notesConnector } from '../connectors/mcp/testing/notes-connector'

const ID = 'mcp:helpdesk'
const world = () => new ConnWorld(createMcpFixtures().fetch)
const prep = (w: ConnWorld, slug = 'helpdesk', b = binding()) => G.prepareConnection(w.deps(), server, { actor: inhouse, slug, adminMaySignIn: false, binding: b })

/** A store that keeps every value put under `record`. */
class WatchedStore extends MemStore {
  puts: unknown[] = []
  override put<T>(key: string, value: T): void {
    if (key === 'record') this.puts.push(structuredClone(value))
    super.put(key, value)
  }
}

describe('a record is written whole', () => {
  const OPS = ['prepare', 'prepareKey', 'pause', 'resume', 'settings', 'admin', 'disconnect', 'remove', 'reencrypt', 'abandon'] as const
  test.prop([fc.array(fc.constantFrom(...OPS), { minLength: 1, maxLength: 25 })], { numRuns: 200 })('every put of a connection\'s record is the whole record or tombstone, every field, checked', async ops => {
    const w = world()
    const store = new WatchedStore()
    w.stores.set(ID, store)
    const core = w.core(ID)
    for (const op of ops) {
      const r = w.raw(ID) as ConnectionRecord | undefined
      switch (op) {
        case 'prepare':
        case 'prepareKey':
          await core.prepareConnection({ accountId: ID, slug: 'helpdesk', adminMaySignIn: false, binding: binding(op === 'prepare' ? undefined : KEYED, { path: op === 'prepare' ? 'none' : 'key' }), memberId: 'mem_1' })
          break
        case 'pause':
        case 'resume':
          await core.setPaused(ID, op === 'pause')
          break
        case 'settings':
        case 'admin':
          if (r && !r.removed) await core.updateConnection({ accountId: ID, ifRev: r.policyRev, ...(op === 'settings' ? { settings: { plain_tools: String(r.policyRev) } } : { adminMaySignIn: !r.adminMaySignIn }) })
          break
        case 'disconnect':
          await core.disconnect(ID)
          break
        case 'remove':
          await core.removeConnection(ID)
          break
        case 'reencrypt':
          await core.reencrypt(ID)
          break
        case 'abandon':
          if (r && !r.removed) await core.abandonConnection(ID, r.generation)
          break
      }
    }
    for (const put of store.puts) {
      expect(isStoredConnection(put)).toBe(true)
      const removed = (put as { removed: boolean }).removed
      const shape = removed ? ConnectionTombstoneSchema.shape : ConnectionRecordSchema.shape
      expect(Object.keys(put as object).sort()).toEqual(Object.keys(shape).sort())
      expect(checkRecord(put as ConnectionRecord)).toEqual({ ok: true })
    }
    // Generations and policy revisions never go back across the puts.
    for (let i = 1; i < store.puts.length; i++) {
      const [a, b] = [store.puts[i - 1] as ConnectionRecord, store.puts[i] as ConnectionRecord]
      expect(b.generation).toBeGreaterThanOrEqual(a.generation)
      expect(b.policyRev).toBeGreaterThanOrEqual(a.policyRev)
    }
  })

  it('a record that fails its check is never put (the core refuses, the object answers internal)', async () => {
    const w = world()
    await prep(w)
    const before = w.raw(ID)
    // A settings value past the schema's bound: withPolicy builds it, the put's check refuses it.
    await expect(w.core(ID).updateConnection({ accountId: ID, ifRev: 1, settings: { plain_tools: 'x'.repeat(201) } })).rejects.toThrow('failed its check')
    expect(w.raw(ID)).toEqual(before)
  })
})

describe('a changed binding or credential: a new generation, and the credential dropped', () => {
  it('disconnect drops every credential and moves the generation; pause and settings move only policyRev', async () => {
    const w = world()
    await prep(w, 'helpdesk', binding(KEYED, { path: 'key' }))
    const ring = await parseKeyRing(w.ringJson)
    if (!ring.ok) throw new Error('ring')
    const key = await seal(ring.ring, ID, 'key', 'sk_test_canary')
    w.store(ID).put('record', { ...(w.raw(ID) as ConnectionRecord), key, generation: 2, state: 'needs_review' })
    expect(await w.core(ID).setPaused(ID, true)).toEqual({ ok: true, value: { paused: true } })
    expect(w.raw(ID)).toMatchObject({ generation: 2, policyRev: 2, paused: true, key })
    expect(await w.core(ID).updateConnection({ accountId: ID, ifRev: 2, settings: { plain_tools: 'yes' } })).toMatchObject({ ok: true, value: { generation: 2, policyRev: 3 } })
    expect(await w.core(ID).disconnect(ID)).toMatchObject({ ok: true, value: { generation: 3, revoked: true } })
    expect(w.raw(ID)).toMatchObject({ generation: 3, key: null, client: null, token: null, refresh: null, state: 'waiting_key' })
  })

  it('a stale ifRev changes nothing', async () => {
    const w = world()
    await prep(w)
    expect(await w.core(ID).updateConnection({ accountId: ID, ifRev: 7, adminMaySignIn: true })).toMatchObject({ ok: false, error: { code: 'connect_stale' } })
    expect(w.raw(ID)).toMatchObject({ policyRev: 1, adminMaySignIn: false })
  })

  it('a key is sealed under its own field: it opens as nothing else', async () => {
    const ring = await parseKeyRing(ringJson(['k1'], 'k1'))
    if (!ring.ok) throw new Error('ring')
    const key = await seal(ring.ring, ID, 'key', 'sk_test_canary')
    expect(await open(ring.ring, ID, 'key', key)).toMatchObject({ ok: true, plaintext: 'sk_test_canary' })
    for (const other of ['token', 'refresh', 'client', 'pkce'] as const) expect((await open(ring.ring, ID, other, key)).ok).toBe(false)
  })
})

describe('version 1 and 2 records still read, and never mix with a connection\'s', () => {
  async function legacy(v: 1 | 2): Promise<{ w: ConnWorld; accountId: string; record: SignInRecord }> {
    const w = world()
    const ring = await parseKeyRing(w.ringJson)
    if (!ring.ok) throw new Error('ring')
    const accountId = v === 1 ? 'shopify' : 'slack'
    const token = await seal(ring.ring, accountId, 'token', 'tok-legacy')
    const base: SignInRecord = { v, accountId, state: 'active', generation: 4, token, refresh: null, obtainedAtMs: w.clock.ms, expiresAtMs: w.clock.ms + 3_600_000, scopes: ['read_orders'], failures: 0, lastError: null }
    const record: SignInRecord = v === 1 ? base : { ...base, kind: 'oauth_mcp', paused: false, connectEpoch: 2, connectedBy: 'mem_1', connectedAtMs: w.clock.ms, workspace: 'T1', client: null, endpoints: null, revokeFailedAtMs: null, refreshUnclear: false, retryAtMs: null }
    w.store(accountId).put('record', record)
    return { w, accountId, record }
  }

  for (const v of [1, 2] as const) {
    it(`a v${v} record reads: status, and key rotation re-seals it`, async () => {
      const { w, accountId, record } = await legacy(v)
      expect(w.core(accountId).status(accountId)).toMatchObject({ ok: true, value: { accountId, state: 'active', kid: 'k1', scopes: ['read_orders'] } })
      w.ringJson = ringJson(['k1', 'k2'], 'k2', new Map([['k1', JSON.parse(w.ringJson).keys.k1]]))
      expect(await w.core(accountId).reencrypt(accountId)).toMatchObject({ ok: true, value: { kid: 'k2', changed: true } })
      expect(w.raw(accountId)).toMatchObject({ v, generation: record.generation, state: 'active' })
    })

    it(`a v${v} object refuses every connection method and keeps its record`, async () => {
      const { w, accountId, record } = await legacy(v)
      const core = w.core(accountId)
      expect(await core.prepareConnection({ accountId: ID, slug: 'helpdesk', adminMaySignIn: false, binding: binding(), memberId: 'm' })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
      expect(await core.removeConnection(ID)).toMatchObject({ ok: false })
      expect(await core.getConnection(ID)).toMatchObject({ ok: false })
      expect(await core.connectionCall(ID, { kind: 'list' })).toMatchObject({ ok: false, sent: 'no' })
      expect(w.raw(accountId)).toEqual(record)
    })
  }

  it('a connection\'s object refuses every v1 and v2 path, and none of them writes', async () => {
    const w = world()
    await prep(w)
    const before = w.raw(ID)
    const core = w.core(ID)
    expect(await core.query({ accountId: ID, document: '{ shop { currencyCode } }', apiVersion: '2026-10' })).toMatchObject({ ok: false, error: { code: 'not_configured' } })
    expect(await core.warm(ID)).toMatchObject({ ok: false, error: { code: 'not_configured' } })
    expect(await core.beginConnect({ accountId: ID, memberId: 'm' })).toMatchObject({ ok: false, error: { code: 'not_configured' } })
    expect(await core.mcpCall({ accountId: ID, upstream: 'notes_search', args: {} })).toMatchObject({ ok: false, error: { code: 'not_configured' } })
    expect(await core.slackChannelInfo(ID, 'C123')).toMatchObject({ ok: false, error: { code: 'not_configured' } })
    expect(await core.ready(ID)).toEqual({ ok: true, value: { ready: false, code: 'not_configured' } })
    expect(await core.accountStatus(ID)).toMatchObject({ ok: true, value: { kind: 'mcp_runtime', state: 'active', paused: false, connectedBy: inhouse.memberId } })
    expect(w.raw(ID)).toEqual(before)
    // A v1 or v2 path that slipped past its gate fails loud on a v3 record (the object answers internal) and writes nothing.
    w.store('shopify').put('record', before)
    expect(() => w.core('shopify').status('shopify')).toThrow('connection record')
    expect(w.raw('shopify')).toEqual(before)
  })
})

describe('the new methods: scope and actor', () => {
  const ref = { actor: inhouse, accountId: ID }
  const CALLS: Record<string, (deps: ReturnType<ConnWorld['deps']>, scope: CallerScope) => Promise<unknown>> = {
    detectConnection: (d, s) => G.detectConnection(d, s, { actor: inhouse, url: KEYED }),
    prepareConnection: (d, s) => G.prepareConnection(d, s, { actor: inhouse, slug: 'helpdesk', adminMaySignIn: false, binding: binding() }),
    getConnection: (d, s) => G.getConnection(d, s, ref),
    updateConnection: (d, s) => G.updateConnection(d, s, { ...ref, ifRev: 1 }),
    setTrusted: (d, s) => G.setTrusted(d, s, { ...ref, trusted: true, ifRev: 1 }),
    startConnectionSignIn: (d, s) => G.startConnectionSignIn(d, s, ref),
    setConnectionCredential: (d, s) => G.setConnectionCredential(d, s, { ...ref, credential: { kind: 'key', key: 'sk_test_canary' } }),
    checkConnection: (d, s) => G.checkConnection(d, s, ref),
    listConnectionTools: (d, s) => G.listConnectionTools(d, s, ref),
    confirmConnectionTools: (d, s) => G.confirmConnectionTools(d, s, { ...ref, generation: 1, ifRev: 1, tools: [{ name: 'notes_search', defHash: 'a'.repeat(64), mode: 'read' }] }),
    removeConnection: (d, s) => G.removeConnection(d, s, ref),
    listConnections: (d, s) => G.listConnections(d, s),
    listWriteTools: (d, s) => G.listWriteTools(d, s),
    reencryptConnections: (d, s) => G.reencryptConnections(d, s),
    teardownConnections: (d, s) => G.teardownConnections(d, s),
  }

  it('lists every function connections/gateway.ts exports', () => {
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(G).filter(k => typeof (G as Record<string, unknown>)[k] === 'function').sort())
  })

  for (const [name, call] of Object.entries(CALLS)) {
    it(`${name}: a run scope is refused before any object is asked`, async () => {
      const w = world()
      expect(await call(w.deps(), run)).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: scope' } })
      expect(await call(w.deps(), { kind: 'server' } as CallerScope)).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: scope' } })
      expect(w.calls).toEqual([])
    })
  }

  it('the methods later packages own answer not_built to a well-formed request, invalid_args to a malformed one, and echo nothing', async () => {
    const w = world()
    for (const name of ['detectConnection', 'setTrusted', 'startConnectionSignIn', 'setConnectionCredential', 'checkConnection', 'listConnectionTools', 'confirmConnectionTools', 'listWriteTools']) {
      const r = await CALLS[name]!(w.deps(), server)
      expect(r, name).toEqual({ ok: false, error: { code: 'not_built', message: `not built yet: ${name}` } })
      expect(JSON.stringify(r)).not.toContain('sk_test_canary')
    }
    expect(await G.setTrusted(w.deps(), server, { junk: true } as never)).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: req' } })
  })

  it('an Admin may read a connection, never prepare, change or remove one, or give a hand-registered app', async () => {
    const w = world()
    await prep(w)
    const asAdmin = { actor: admin, accountId: ID }
    expect(await G.getConnection(w.deps(), server, asAdmin)).toMatchObject({ ok: true, value: { accountId: ID } })
    const refusedActor = { ok: false, error: { code: 'invalid_args', message: 'invalid arguments: actor' } }
    expect(await G.prepareConnection(w.deps(), server, { actor: admin, slug: 'other', adminMaySignIn: true, binding: binding() })).toEqual(refusedActor)
    expect(await G.updateConnection(w.deps(), server, { ...asAdmin, ifRev: 1, adminMaySignIn: true })).toEqual(refusedActor)
    expect(await G.removeConnection(w.deps(), server, asAdmin)).toEqual(refusedActor)
    expect(await G.setConnectionCredential(w.deps(), server, { ...asAdmin, credential: { kind: 'client', clientId: 'app', clientSecret: 'sk_test_canary' } })).toEqual(refusedActor)
    expect(w.raw(ID)).toMatchObject({ removed: false, adminMaySignIn: false })
    expect(w.raw('mcp:other')).toBeUndefined()
  })

  it('prepare refuses a compiled connector\'s name, a private address, a connector transport (M4-P1) and a key path with no key place', async () => {
    const w = world()
    w.modules = [...w.modules, notesConnector]
    expect(await G.prepareConnection(w.deps(), server, { actor: inhouse, slug: 'notes', adminMaySignIn: false, binding: binding() })).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: slug' } })
    expect(w.stores.has('mcp:notes')).toBe(false)
    expect(await G.prepareConnection(w.deps(), server, { actor: inhouse, slug: 'helpdesk', adminMaySignIn: false, binding: binding('https://10.0.0.7/mcp') })).toMatchObject({ ok: false, error: { message: 'invalid arguments: destination_address' } })
    expect(await G.prepareConnection(w.deps(), server, { actor: inhouse, slug: 'helpdesk', adminMaySignIn: false, binding: { transport: 'connector', connector: 'rest-fixture', settings: {} } })).toMatchObject({ ok: false, error: { code: 'not_built' } })
    expect(await G.prepareConnection(w.deps(), server, { actor: inhouse, slug: 'helpdesk', adminMaySignIn: false, binding: { ...binding(KEYED, { path: 'key' }), key: undefined } as never })).toMatchObject({ ok: false, error: { message: 'invalid arguments: key' } })
    expect(w.stores.has(ID)).toBe(false)
  })
})

describe('pause and disconnect (routes 71, 72) take a connection\'s account id', () => {
  it('pause bumps policyRev; disconnect drops the credential; both through the existing gateway functions', async () => {
    const w = world()
    await prep(w)
    const legacyDeps = { registry: w.deps().registry, isConfigured: () => true, signIn: (id: string) => w.core(id) as never }
    expect(await gatewaySetPaused(legacyDeps, server, ID, true)).toEqual({ ok: true, value: { paused: true } })
    expect(w.raw(ID)).toMatchObject({ paused: true, policyRev: 2 })
    expect(await gatewayDisconnect(legacyDeps, server, ID)).toEqual({ ok: true, value: { revoked: true } })
    expect(w.raw(ID)).toMatchObject({ generation: 2 })
    expect(await gatewaySetPaused(legacyDeps, run, ID, false)).toMatchObject({ ok: false, error: { message: 'invalid arguments: scope' } })
  })
})

describe('key rotation and teardown walk the index', () => {
  it('rotation re-seals every listed connection\'s envelopes; teardown removes every listed connection', async () => {
    const w = world()
    const ring1 = await parseKeyRing(w.ringJson)
    if (!ring1.ok) throw new Error('ring')
    for (const slug of ['alpha', 'beta']) {
      await prep(w, slug, binding(KEYED, { path: 'key' }))
      const id = `mcp:${slug}`
      w.store(id).put('record', { ...(w.raw(id) as ConnectionRecord), key: await seal(ring1.ring, id, 'key', `sk_${slug}`) })
    }
    w.ringJson = ringJson(['k1', 'k2'], 'k2', new Map([['k1', JSON.parse(w.ringJson).keys.k1]]))
    const rotated = await G.reencryptConnections(w.deps(), server)
    expect(rotated).toEqual({ ok: true, value: [{ accountId: 'mcp:alpha', kid: 'k2', changed: true, code: null }, { accountId: 'mcp:beta', kid: 'k2', changed: true, code: null }] })
    const ring2 = await parseKeyRing(w.ringJson)
    if (!ring2.ok) throw new Error('ring')
    expect(await open(ring2.ring, 'mcp:alpha', 'key', (w.raw('mcp:alpha') as ConnectionRecord).key!)).toMatchObject({ ok: true, plaintext: 'sk_alpha', kid: 'k2' })
    // Re-sealing isn't a credential change: the generation stays.
    expect(w.raw('mcp:alpha')).toMatchObject({ generation: 1 })

    const torn = await G.teardownConnections(w.deps(), server)
    expect(torn).toEqual({ ok: true, value: [{ accountId: 'mcp:alpha', revoked: true, code: null }, { accountId: 'mcp:beta', revoked: true, code: null }] })
    expect((await w.core(INDEX_OBJECT).indexList())).toEqual({ ok: true, value: [] })
    expect(w.raw('mcp:alpha')).toMatchObject({ removed: true })
    expect(w.raw('mcp:beta')).toMatchObject({ removed: true })
  })
})
