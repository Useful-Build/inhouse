// Stage 1 M4-R1's done-when (N35): a connection is prepared, listed and removed through the gateway, in workerd, with the
// real SignIn objects, the `__connections__` index and the test seam's fixture servers. Also: a list through
// connectionCall reaches the open fixture (the address check's test-build resolver takes a seam host), and a `run` scope
// is refused on every new method of ConnectGateway and ServerGateway through the Worker's exports.
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { CallerScope, ConnectionView, HubResult } from '../index/contract'
import { HOSTS } from '../../test/upstreams/mcp/wire'

const server: CallerScope = { kind: 'server', job: 'test', requestId: 'req-r1' }
const run: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'p-1', requestId: 'req-r1' }
type Method = (scope: CallerScope, req?: unknown) => Promise<HubResult<unknown>>
const gateways = exports as unknown as Record<'ConnectGateway' | 'ServerGateway', Record<string, Method>>
const connect = gateways.ConnectGateway
const actor = { kind: 'inhouse', memberId: 'mem_test_r1' }
const OPEN = `https://${HOSTS.modern}/open/mcp`
const destinations = (mcp: string) => ({ mcp, metadata: [], issuer: null, authorize: null, token: null, registration: null, revoke: null })
const binding = { transport: 'https', path: 'none', destinations: destinations(OPEN), settings: {} }
/** The SignIn object methods this file calls, typed plainly (the generated stub type is too deep to infer here). */
type ObjectStub = {
  connectionCall(accountId: string, req: unknown): Promise<unknown>
  setPaused(accountId: string, paused: boolean): Promise<unknown>
  indexList(): Promise<unknown>
}

describe('a connection is prepared, listed and removed through the gateway', () => {
  it('prepare, get, list, update, remove, then the list no longer holds it and the slug stays removed', async () => {
    const prepared = await connect.prepareConnection!(server, { actor, slug: 'wkopen', adminMaySignIn: false, binding })
    expect(prepared).toMatchObject({ ok: true, value: { accountId: 'mcp:wkopen', slug: 'wkopen', generation: 1, policyRev: 1, trusted: false, paused: false, state: 'needs_review', destinations: destinations(OPEN) } })
    expect(await connect.getConnection!(server, { actor: { kind: 'admin', memberId: 'mem_admin' }, accountId: 'mcp:wkopen' })).toEqual(prepared)
    const listed = await connect.listConnections!(server)
    expect(listed.ok && (listed.value as ConnectionView[]).map(c => c.accountId)).toContain('mcp:wkopen')
    expect(await connect.updateConnection!(server, { actor, accountId: 'mcp:wkopen', ifRev: 1, adminMaySignIn: true })).toMatchObject({ ok: true, value: { policyRev: 2, adminMaySignIn: true } })

    expect(await connect.removeConnection!(server, { actor, accountId: 'mcp:wkopen' })).toEqual({ ok: true, value: { revoked: true } })
    const after = await connect.listConnections!(server)
    expect(after.ok && (after.value as ConnectionView[]).map(c => c.accountId)).not.toContain('mcp:wkopen')
    expect(await connect.getConnection!(server, { actor, accountId: 'mcp:wkopen' })).toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
    expect(await connect.prepareConnection!(server, { actor, slug: 'wkopen', adminMaySignIn: false, binding })).toMatchObject({ ok: false, error: { message: 'invalid arguments: slug_removed' } })
    // The status row says what the object holds.
    expect(await gateways.ServerGateway.status!(server, 'mcp:wkopen')).toMatchObject({ ok: true, value: { kind: 'mcp_runtime', state: 'disconnected' } })
  })

  it('connectionCall lists the open fixture\'s tools from the wire, through the object', async () => {
    expect((await connect.prepareConnection!(server, { actor, slug: 'wklist', adminMaySignIn: false, binding })).ok).toBe(true)
    const stub = env.SIGNIN.get(env.SIGNIN.idFromName('mcp:wklist')) as unknown as ObjectStub
    const listed = (await stub.connectionCall('mcp:wklist', { kind: 'list' })) as { ok: boolean; value?: { kind: string; tools: { name: string }[] } }
    expect(listed.ok).toBe(true)
    expect(listed.value!.tools.map(t => t.name)).toContain('notes_search')
    // Paused: refused before anything is sent.
    await stub.setPaused('mcp:wklist', true)
    expect(await stub.connectionCall('mcp:wklist', { kind: 'list' })).toMatchObject({ ok: false, error: { code: 'paused' }, sent: 'no' })
    await connect.removeConnection!(server, { actor, accountId: 'mcp:wklist' })
  })

  it('only the index object answers the index methods', async () => {
    const other = env.SIGNIN.get(env.SIGNIN.idFromName('mcp:wkother')) as unknown as ObjectStub
    expect(await other.indexList()).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
  })
})

describe('a run scope is refused on every new method', () => {
  const ref = { actor, accountId: 'mcp:wkscope' }
  const CONNECT: Record<string, unknown> = {
    detectConnection: { actor, url: OPEN },
    prepareConnection: { actor, slug: 'wkscope', adminMaySignIn: false, binding },
    getConnection: ref,
    updateConnection: { ...ref, ifRev: 1 },
    setTrusted: { ...ref, trusted: true, ifRev: 1 },
    startConnectionSignIn: ref,
    setConnectionCredential: { ...ref, credential: { kind: 'key', key: 'sk_test_canary' } },
    checkConnection: ref,
    listConnectionTools: ref,
    confirmConnectionTools: { ...ref, generation: 1, ifRev: 1, tools: [{ name: 'search', defHash: 'a'.repeat(64), mode: 'read' }] },
    removeConnection: ref,
    listConnections: undefined,
    listWriteTools: undefined,
  }
  for (const [method, req] of Object.entries(CONNECT)) {
    it(`ConnectGateway.${method}`, async () => {
      expect(await connect[method]!(run, req)).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: scope' } })
    })
  }
  for (const method of ['reencryptConnections', 'teardownConnections']) {
    it(`ServerGateway.${method}`, async () => {
      expect(await gateways.ServerGateway[method]!(run)).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: scope' } })
    })
  }
  it('nothing was prepared by any of them', async () => {
    expect(await connect.getConnection!(server, ref)).toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
  })
})
