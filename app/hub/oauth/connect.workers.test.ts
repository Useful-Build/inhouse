// P5 W1 on workerd (CI, the test config): SignIn on real SQLite with the fake OAuth MCP server through H0's seam, a
// connect across eviction, the alarm refreshing a rotating token and sweeping a non-expiring one, and ConnectGateway
// and ReadGateway through the Worker's exports. Needs the orchestrator's lines: the `notes` test connector in
// loadRegistry's guarded branch, `CONNECT_REDIRECT_URI` in wrangler.hub.test.jsonc, and index.ts's ConnectGateway
// re-export and ready-gateway wiring.
import { env, evictAllDurableObjects, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccountSummary, CallerScope, ConnectGateway, HubResult, ReadGateway } from '../index/contract'
import { testUpstreams } from '../testing/index'
import type { SignInRecord } from '../signin/core'
import { NOTES_ACCOUNT } from '../connectors/mcp/testing/notes-connector'
import { createMcpUpstream, mintTestCode, type FakeMcpServer } from '../../test/upstreams/mcp/server'

const server: CallerScope = { kind: 'server', job: 'test', requestId: 'req-w' }
const run: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'p-1', requestId: 'req-r' }
const MEMBER = 'mem_test_0001'
const gateways = exports as unknown as { ConnectGateway: ConnectGateway; ReadGateway: ReadGateway }
const stub = () => env.SIGNIN.get(env.SIGNIN.idFromName(NOTES_ACCOUNT))
const record = () => runInDurableObject(stub(), (_i, state) => state.storage.kv.get<SignInRecord>('record'))

let fake: FakeMcpServer

function install(rotation: boolean) {
  fake = createMcpUpstream('notes', { now: () => Date.now(), rotation })
  for (const h of fake.hosts) testUpstreams.set(h, fake.fetch)
}

beforeEach(async () => {
  await reset()
  install(false)
})
afterEach(() => {
  for (const h of fake.hosts) testUpstreams.delete(h)
})

async function connectNotes(): Promise<HubResult<{ accountId: string }>> {
  const started = await gateways.ConnectGateway.startConnect(server, { accountId: NOTES_ACCOUNT, memberId: MEMBER })
  if (!started.ok) throw new Error(started.error.code)
  const { code, state } = await mintTestCode(started.value.authorizeUrl, { nowMs: Date.now() })
  await evictAllDurableObjects()
  return gateways.ConnectGateway.completeConnect(server, { state, code, memberId: MEMBER })
}

describe('connect on SQLite storage', () => {
  it('a connect across eviction: the pending item and the token persist in storage', async () => {
    expect(await connectNotes()).toEqual({ ok: true, value: { accountId: NOTES_ACCOUNT } })
    await evictAllDurableObjects()
    const r = (await record())!
    expect(r).toMatchObject({ kind: 'oauth_mcp', state: 'active', connectedBy: MEMBER })
    const everything = await runInDurableObject(stub(), (_i, state) => JSON.stringify([...state.storage.kv.list()]))
    for (const t of fake.tokens.keys()) expect(everything).not.toContain(t)
    const tools = await gateways.ReadGateway.listTools(run)
    expect(tools.ok && tools.value.filter(t => t.connector === 'notes').map(t => t.name).sort()).toEqual(['notes_read', 'notes_search'])
    const called = await gateways.ReadGateway.callTool(run, 'notes_search', { query: 'fern' })
    expect(called.ok).toBe(true)
    expect(await gateways.ReadGateway.callTool(run, 'notes_delete', { id: 'n1' })).toMatchObject({ ok: false, error: { code: 'write_refused' } })
  })

  it('the alarm sweeps expired pending items on a non-expiring account and writes nothing else', async () => {
    await connectNotes()
    await gateways.ConnectGateway.startConnect(server, { accountId: NOTES_ACCOUNT, memberId: MEMBER })
    const before = await record()
    await runInDurableObject(stub(), (_i, state) => {
      for (const [k, v] of state.storage.kv.list<{ expiresAtMs: number }>({ prefix: 'pending:' })) state.storage.kv.put(k, { ...v, expiresAtMs: 0 })
      return state.storage.setAlarm(Date.now())
    })
    expect(await runDurableObjectAlarm(stub())).toBe(true)
    expect(await record()).toEqual(before)
    const keys = await runInDurableObject(stub(), (_i, state) => [...state.storage.kv.list()].map(([k]) => k))
    expect(keys).toEqual(['record'])
  })

  it('the alarm refreshes a rotating token when due', async () => {
    for (const h of fake.hosts) testUpstreams.delete(h)
    install(true)
    await connectNotes()
    const g0 = (await record())!.generation
    await runInDurableObject(stub(), (_i, state) => {
      const r = state.storage.kv.get<SignInRecord>('record')!
      state.storage.kv.put('record', { ...r, obtainedAtMs: Date.now() - 7 * 3600_000 })
      return state.storage.setAlarm(Date.now())
    })
    expect(await runDurableObjectAlarm(stub())).toBe(true)
    expect((await record())!.generation).toBe(g0 + 1)
    expect(fake.refreshSends).toHaveLength(1)
  })

  it('ConnectGateway refuses a run scope, lists one row per account, and disconnect revokes', async () => {
    expect(await gateways.ConnectGateway.listAccounts(run)).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    await connectNotes()
    const rows = (await gateways.ConnectGateway.listAccounts(server)) as HubResult<AccountSummary[]>
    const ids = rows.ok ? rows.value.map(r => r.accountId) : []
    expect(new Set(ids).size).toBe(ids.length)
    expect(await gateways.ConnectGateway.disconnect(server, NOTES_ACCOUNT)).toEqual({ ok: true, value: { revoked: true } })
    expect(fake.revoked).toHaveLength(1)
  })
})
