// A connection's record (connections/record.ts, Stage 1 M4-R1, N35). Ways it could go wrong, written first: a changed
// binding keeps the old credential, or keeps the generation (an era cache, a confirm or an in-flight call would then
// carry over); a learned era or a settings change bumps the generation (every confirm lost for nothing); a tombstone
// lets the generation go back; the caps (200 tools, 100 confirmed) don't hold on the stored record itself.
import { describe, expect, it } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import { CONNECTION_CAPS } from '../index/contract'
import {
  checkRecord, ConnectionRecordSchema, preparedRecord, rebound, bindingOf, tombstoneOf, withCredential, withPolicy, withSnapshot,
  type ConnectionRecord, type ConnectionToolRecord,
} from './record'
import { binding, START_MS } from './testing/kit'

const ENVELOPE = { kid: 'k1', iv: 'aaaaaaaaaaaaaaaa', ct: 'bbbbbbbbbbbbbbbbbbbbbbbb' }

const fresh = (input = binding()) => preparedRecord({ slug: 'helpdesk', input, adminMaySignIn: false, memberId: 'mem_1', nowMs: START_MS, after: null })
const held = (): ConnectionRecord => ({ ...fresh(binding(undefined, { path: 'key' })), key: ENVELOPE, client: ENVELOPE, token: ENVELOPE, refresh: ENVELOPE, state: 'live' })

function tool(i: number, mode: ConnectionToolRecord['mode'] = 'new'): ConnectionToolRecord {
  const hash = i.toString(16).padStart(64, '0')
  return { name: `t${i}`, hubName: `helpdesk_t${i}`, title: null, description: '', inputSchema: { type: 'object' }, readOnlyHint: null, defHash: hash, mode, confirmedHash: mode === 'new' ? null : hash, confirmedGen: mode === 'new' ? null : 1, hidden: null }
}

describe('a record is whole and checked', () => {
  it('a prepared record has every field, untrusted, no credential, generation 1, waiting for its credential', () => {
    const r = fresh(binding(undefined, { path: 'signin' }))
    expect(checkRecord(r)).toEqual({ ok: true })
    expect(Object.keys(r).sort()).toEqual(Object.keys(ConnectionRecordSchema.shape).sort())
    expect(r).toMatchObject({ generation: 1, policyRev: 1, trusted: false, key: null, client: null, token: null, refresh: null, tools: [], state: 'waiting_signin' })
  })

  it('a record missing any field fails the check', () => {
    const r = fresh() as Record<string, unknown>
    for (const k of Object.keys(r)) {
      const { [k]: _, ...partial } = r
      expect(checkRecord(partial as unknown as ConnectionRecord).ok, k).toBe(false)
    }
  })

  it('addresses are kept in one spelling, so the destination rule compares exact strings', () => {
    const r = fresh(binding('https://Modern.MCP-Fixtures.example.com:443/open/mcp'))
    expect(r.binding.destinations!.mcp).toBe('https://modern.mcp-fixtures.example.com/open/mcp')
  })
})

describe('a changed binding makes a new generation and drops the credential', () => {
  const addresses = ['https://a.example.com/mcp', 'https://b.example.com/mcp', 'https://a.example.com/other', 'https://a.example.com:8443/mcp']
  const arbBinding = fc.record({
    mcp: fc.constantFrom(...addresses),
    path: fc.constantFrom('none' as const, 'signin' as const, 'key' as const),
    token: fc.constantFrom(null, 'https://login.example.com/token', 'https://login.example.com/token2'),
    settings: fc.constantFrom<Record<string, string>>({}, { plain_tools: 'yes' }),
  }).map(b => binding(b.mcp, { path: b.path, extra: { token: b.token }, settings: b.settings }))

  test.prop([arbBinding, arbBinding])('generation moves exactly when the binding changes, and then every credential is gone', (a, b) => {
    const r = { ...held(), binding: bindingOf(a) }
    const next = rebound(r, bindingOf(b))
    const changed = JSON.stringify({ ...bindingOf(a), settings: {} }) !== JSON.stringify({ ...bindingOf(b), settings: {} })
    if (!changed) {
      expect(next).toBe(r)
      return
    }
    expect(next.generation).toBe(r.generation + 1)
    expect(next.policyRev).toBeGreaterThan(r.policyRev)
    expect([next.key, next.client, next.token, next.refresh]).toEqual([null, null, null, null])
    expect(next.list).toBeNull()
    expect(next.state).not.toBe('live')
    // The settings are policy and stay the record's own; the era is learned again.
    expect(next.binding.settings).toEqual(r.binding.settings)
    expect(next.binding.era).toBeNull()
    expect(checkRecord(next)).toEqual({ ok: true })
  })

  it('a learned era or a settings change is not a binding change', () => {
    const r = held()
    expect(rebound(r, { ...r.binding, era: 'modern' })).toBe(r)
    const s = withPolicy(r, { settings: { plain_tools: 'yes' } })
    expect(s.generation).toBe(r.generation)
    expect(s.policyRev).toBe(r.policyRev + 1)
    expect(s.key).toEqual(ENVELOPE)
  })

  it('a credential set is a new generation; a policy change is a new policyRev only, and only when something changed', () => {
    const r = fresh(binding(undefined, { path: 'key' }))
    expect(withCredential(r, 'key', ENVELOPE, 'needs_review')).toMatchObject({ generation: 2, policyRev: 1, key: ENVELOPE, state: 'needs_review' })
    expect(withPolicy(r, { paused: true })).toMatchObject({ generation: 1, policyRev: 2, paused: true })
    expect(withPolicy(r, { trusted: true })).toMatchObject({ generation: 1, policyRev: 2, trusted: true })
    expect(withPolicy(r, { paused: false, trusted: false, adminMaySignIn: false, settings: {} })).toBe(r)
  })

  it('a tombstone is past every generation and policy revision the record had, and holds no credential', () => {
    const r = held()
    const t = tombstoneOf(r, 'removed', START_MS, false)
    expect(t.generation).toBeGreaterThan(r.generation)
    expect(t.policyRev).toBeGreaterThan(r.policyRev)
    expect(Object.keys(t)).not.toContain('key')
    expect(checkRecord(t)).toEqual({ ok: true })
    // A prepare after an abandoned one continues its generation.
    expect(preparedRecord({ slug: 'helpdesk', input: binding(), adminMaySignIn: false, memberId: 'm', nowMs: 1, after: t }).generation).toBe(t.generation + 1)
  })
})

describe('caps: 200 tools in a snapshot, 100 confirmed', () => {
  it('200 tools store; 201 are refused, by withSnapshot and by the record check', () => {
    const r = fresh()
    const list = { fetchedAtMs: START_MS, ttlMs: 60_000, complete: true }
    const two00 = Array.from({ length: CONNECTION_CAPS.snapshotTools }, (_, i) => tool(i))
    const ok = withSnapshot(r, two00, list)
    expect(ok.ok).toBe(true)
    expect(ok.ok && checkRecord(ok.record)).toEqual({ ok: true })
    const over = [...two00, tool(200)]
    expect(withSnapshot(r, over, list)).toEqual({ ok: false, reason: 'snapshot_cap' })
    expect(checkRecord({ ...r, tools: over }).ok).toBe(false)
  })

  it('100 confirmed tools store; 101 are refused, by withSnapshot and by the record check', () => {
    const r = fresh()
    const list = { fetchedAtMs: START_MS, ttlMs: 60_000, complete: true }
    const tools = Array.from({ length: 150 }, (_, i) => tool(i, i < CONNECTION_CAPS.confirmedTools ? 'read' : 'new'))
    expect(withSnapshot(r, tools, list).ok).toBe(true)
    const over = tools.map((t, i) => (i === 100 ? tool(i, 'write') : t))
    expect(withSnapshot(r, over, list)).toEqual({ ok: false, reason: 'confirmed_cap' })
    expect(checkRecord({ ...r, tools: over }).ok).toBe(false)
  })

  it('a tool hidden as rejected is a record the check takes (#659: M4-H keeps it, counted, never listed)', () => {
    expect(checkRecord({ ...fresh(), tools: [{ ...tool(1), hidden: 'rejected' }] })).toEqual({ ok: true })
  })
})
