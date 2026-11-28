// Routes A and B (P5 W1) and the connector_accounts store, on the real migrations, with a fake ConnectGateway. Ways
// they can fail, written down first:
//  1. an Admin or a Member reaches the hub (the matrix refuses first; the handler refuses again);
//  2. the callback forwards something besides `code` and `state`, or echoes the AS's `error`, or redirects with text
//     that isn't a closed-list code;
//  3. a row sticks on `connecting` after a refused or failed connect, or the row and its line aren't written exactly
//     once per accepted outcome, or a `state_invalid` writes anything;
//  4. a forged state prefix changes anything but the redirect path;
//  5. a row change lands without its audit line, or a line without its change (one batch).
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountSummary, HubErrorCode, HubResult } from '../../hub/index/contract.ts'
import { openStores } from '../db/stores.ts'
import type { Stores } from '../db/stores.ts'
import { brokenAudit, ctx, lastLineId, linesSince, person, personPrincipal, reqId } from '../db/test-support.ts'
import type { Principal } from '../auth/principal.ts'
import { connectCallback, PROVEN, startConnect, stateAccountHint } from './connect.ts'
import { HUB_ERROR_CODES } from '../egress/hub.ts'
import type { ConnectBinding } from './connect.ts'

const db = env.DB
const stores = openStores(env)
const T = 1_800_000_000_000
const SLACK = 'slack:workspace'
/** base64url('slack:workspace') + '.' + 43 random-looking characters. */
const STATE = `c2xhY2s6d29ya3NwYWNl.${'A'.repeat(43)}`
const FORGED = `c2hvcGlmeTpzdG9yZQ.${'B'.repeat(43)}` // base64url('shopify:store')
let u = 0
const uniq = () => `${++u}-${Math.random().toString(36).slice(2, 7)}`

type Call = { method: string; args: unknown[] }

function fakeHub(answers: { complete?: HubResult<{ accountId: string }>; fail?: HubResult<{ accountId: string | null }>; state?: AccountSummary['status']['state'] } = {}) {
  const calls: Call[] = []
  const hub: ConnectBinding = {
    async startConnect(...args) {
      calls.push({ method: 'startConnect', args })
      return { ok: true, value: { authorizeUrl: 'https://slack.com/oauth/v2_user/authorize?state=x', expiresAt: { iso: new Date(T + 600_000).toISOString(), ms: T + 600_000 } } }
    },
    async completeConnect(...args) {
      calls.push({ method: 'completeConnect', args })
      return answers.complete ?? { ok: true, value: { accountId: SLACK } }
    },
    async failConnect(...args) {
      calls.push({ method: 'failConnect', args })
      return answers.fail ?? { ok: true, value: { accountId: SLACK } }
    },
    async listAccounts(...args) {
      calls.push({ method: 'listAccounts', args })
      const status: AccountSummary['status'] = { accountId: SLACK, state: answers.state ?? 'failed', kid: null, expiresAt: null, scopes: [], lastError: null, paused: false, kind: 'oauth_mcp', connectedBy: null, connectedAt: null, revokeFailedAt: null, needsReconnect: false }
      return { ok: true, value: [{ accountId: SLACK, connector: 'slack', configured: true, status }] }
    },
  }
  return { hub, calls }
}

async function inhouse(s: Stores = stores): Promise<Principal> {
  const id = await s.members.resolveInhouse({ subject: `ih-${uniq()}`, email: `ih-${uniq()}@example.test`, requestId: reqId(), nowMs: T })
  return { kind: 'inhouse', memberId: id.memberId, subject: id.subject, grant: null, requestId: reqId(), expMs: 4_102_444_800_000 }
}

const start = (p: Principal, hub: ConnectBinding, accountId = SLACK) =>
  startConnect({ ...ctx(stores, p, { method: 'POST', path: `/api/connect/${accountId}/start`, params: { accountId }, nowMs: T }).c, env: { HUB_CONNECT: hub as unknown as Service } })
const callback = (p: Principal, hub: ConnectBinding, query: string, s: Stores = stores) =>
  connectCallback({ ...ctx(s, p, { path: `/api/connect/callback?${query}`, nowMs: T }).c, env: { HUB_CONNECT: hub as unknown as Service } })
const row = () => db.prepare('SELECT * FROM connector_accounts WHERE account_id = ?').bind(SLACK).first<Record<string, unknown>>()

beforeEach(async () => {
  await db.prepare('DELETE FROM connector_accounts').run()
})

describe('who may connect (failure 1)', () => {
  it('an Admin or a Member never reaches the hub', async () => {
    for (const role of ['admin', 'member'] as const) {
      const p = personPrincipal(await person(stores, { email: `c-${uniq()}@example.test`, subject: `sc-${uniq()}`, role }), role)
      const { hub, calls } = fakeHub()
      expect((await start(p, hub)).status).toBe(403)
      expect((await callback(p, hub, `code=c&state=${STATE}`)).status).toBe(403)
      expect(calls).toEqual([])
    }
  })
})

describe('route A', () => {
  it('starts at the hub with the member id, marks the row connecting with one line', async () => {
    const p = await inhouse()
    const { hub, calls } = fakeHub()
    const before = await lastLineId(db)
    const res = await start(p, hub)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authorizeUrl: 'https://slack.com/oauth/v2_user/authorize?state=x', expiresAt: { iso: new Date(T + 600_000).toISOString(), ms: T + 600_000 } })
    expect(calls).toEqual([{ method: 'startConnect', args: [{ kind: 'server', job: 'connect', requestId: p.requestId }, { accountId: SLACK, memberId: (p as { memberId: string }).memberId }] }])
    expect(await row()).toMatchObject({ account_id: SLACK, connector: 'slack', last_state: 'connecting', rev: 1 })
    const lines = await linesSince(db, before)
    expect(lines.map(l => [l.action, l.target_kind, l.target_id, JSON.parse(l.args_json)])).toEqual([['tools.connect_start', 'connector', SLACK, { accountId: SLACK }]])
  })

  it('a bad account id is 404 before the hub; a hub refusal writes nothing', async () => {
    const p = await inhouse()
    const { hub, calls } = fakeHub()
    expect((await start(p, hub, 'Slack Workspace')).status).toBe(404)
    expect(calls).toEqual([])
    const refusing: ConnectBinding = { ...hub, startConnect: async () => ({ ok: false, error: { code: 'not_configured', message: 'connector not configured' } }) }
    const res = await start(p, refusing)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: 'conflict', reason: 'not_configured' } })
    expect(await row()).toBeNull()
  })
})

describe('route B (failures 2 to 4)', () => {
  it('forwards only code and state, answers 303 to the connector, no-store and no-referrer', async () => {
    const p = await inhouse()
    const { hub, calls } = fakeHub()
    const res = await callback(p, hub, `code=the-code&state=${STATE}&extra=injected&scope=x`)
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/tools/slack?connected=1')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    // Stage 1 M4 (#674): who finished it and the return's `iss` always go along (null: the return carried none).
    expect(calls).toEqual([{ method: 'completeConnect', args: [expect.anything(), { state: STATE, code: 'the-code', memberId: (p as { memberId: string }).memberId, actorKind: 'inhouse', iss: null }] }])
    expect(await row()).toMatchObject({ last_state: 'connected', connected_by: (p as { memberId: string }).memberId, connected_at_ms: T })
  })

  // Stage 1 M4 (N40, #674): every `iss` the return carried reaches the hub as it is, in order, a doubled one included,
  // on success and on the AS's error; the hub (M4-O1a) decides. Nothing else from the query goes along.
  it('forwards every iss and the actor kind, on success and on error', async () => {
    const p = await inhouse()
    const memberId = (p as { memberId: string }).memberId
    const { hub, calls } = fakeHub()
    await callback(p, hub, `code=the-code&state=${STATE}&iss=${encodeURIComponent('https://slack.com')}`)
    await callback(p, hub, `code=the-code&state=${STATE}&iss=a&iss=b`)
    await callback(p, hub, `error=access_denied&state=${STATE}&iss=${encodeURIComponent('https://slack.com')}`)
    await callback(p, hub, `error=access_denied&state=${STATE}`)
    expect(calls.filter(c => c.method === 'completeConnect' || c.method === 'failConnect').map(c => c.args[1])).toEqual([
      { state: STATE, code: 'the-code', memberId, actorKind: 'inhouse', iss: ['https://slack.com'] },
      { state: STATE, code: 'the-code', memberId, actorKind: 'inhouse', iss: ['a', 'b'] },
      { state: STATE, memberId, error: 'access_denied', actorKind: 'inhouse', iss: ['https://slack.com'] },
      { state: STATE, memberId, error: 'access_denied', actorKind: 'inhouse', iss: null },
    ])
  })

  it("the AS's error is never echoed: connect_refused, and the row goes back to the hub's state", async () => {
    const p = await inhouse()
    const { hub } = fakeHub({ state: 'active' })
    await start(p, hub)
    const res = await callback(p, hub, `error=access_denied%3Cscript%3E&state=${STATE}`)
    expect(res.headers.get('Location')).toBe('/tools/slack?connect_error=connect_refused')
    expect(await row()).toMatchObject({ last_state: 'connected', rev: 2 })
    expect(JSON.stringify(await linesSince(db, 0))).not.toContain('access_denied')
  })

  // Review fold (#251): every accepted-state failure against every hub state, in a plain loop (7 x 4). `internal` is
  // not among them: it doesn't prove the hub took the state, so it writes nothing (next test).
  const accepted: HubErrorCode[] = ['scope_mismatch', 'workspace_mismatch', 'connect_stale', 'connect_refused', 'upstream_unavailable', 'rate_limited', 'not_configured']
  const states = ['failed', 'disconnected', 'active', 'empty'] as const
  it('an accepted state that failed: one row change and one line, never connecting, a closed-list code (7 x 4)', async () => {
    for (const code of accepted) {
      for (const hubState of states) {
        await db.prepare('DELETE FROM connector_accounts').run()
        const p = await inhouse()
        const { hub } = fakeHub({ complete: { ok: false, error: { code, message: 'ignored upstream words' } }, state: hubState })
        await start(p, hub)
        const before = await lastLineId(db)
        const res = await callback(p, hub, `code=c&state=${STATE}`)
        const at = `${code} with the hub ${hubState}`
        expect(res.headers.get('Location'), at).toBe(`/tools/slack?connect_error=${code}`)
        const expected = { active: 'connected', failed: 'failed', disconnected: 'disconnected', empty: 'never' }[hubState]
        expect(await row(), at).toMatchObject({ last_state: expected, rev: 2 })
        const lines = await linesSince(db, before)
        expect(lines.map(l => JSON.parse(l.args_json)), at).toEqual([{ accountId: SLACK, outcome: code }])
      }
    }
  })

  // #676: the codes that prove the hub took the state are an allow-list. Every hub code is tried; only the ones the hub
  // answers after its state check (written out here, as the hub's signin/core.ts gives them) write a row, and any code
  // added later (M4's included) writes nothing until someone shows it's proof.
  const PROVEN_BY_HUB = ['not_configured', 'key_unavailable', 'credentials_rejected', 'upstream_rejected', 'upstream_unavailable', 'rate_limited',
    'connect_refused', 'workspace_mismatch', 'scope_mismatch', 'connect_stale']
  it('only a code the hub gives after its state check writes the row; every other code, new ones included, writes nothing', async () => {
    expect([...PROVEN].sort()).toEqual([...PROVEN_BY_HUB].sort())
    for (const code of HUB_ERROR_CODES) {
      await db.prepare('DELETE FROM connector_accounts').run()
      const p = await inhouse()
      const { hub } = fakeHub({ complete: { ok: false, error: { code, message: 'x' } } })
      const before = await lastLineId(db)
      const res = await callback(p, hub, `code=c&state=${STATE}`)
      expect(res.status, code).toBe(303)
      const rows = await db.prepare('SELECT COUNT(*) AS n FROM connector_accounts').first<number>('n')
      expect(rows, code).toBe(PROVEN_BY_HUB.includes(code) ? 1 : 0)
      expect((await linesSince(db, before)).length, code).toBe(PROVEN_BY_HUB.includes(code) ? 1 : 0)
    }
    // Control: every M4 code is among those tried, and none is proof.
    for (const code of ['needs_key', 'definition_changed', 'needs_input', 'leak', 'client_fault', 'not_built', 'connections_off'] as const) {
      expect(HUB_ERROR_CODES, code).toContain(code)
      expect(PROVEN.has(code), code).toBe(false)
    }
  })

  it("the hub's internal, invalid_args and state_invalid answers write nothing, for a real or a forged prefix", async () => {
    for (const code of ['internal', 'invalid_args', 'state_invalid'] as const) {
      for (const state of [STATE, FORGED]) {
        await db.prepare('DELETE FROM connector_accounts').run()
        const p = await inhouse()
        const { hub } = fakeHub({ complete: { ok: false, error: { code, message: 'x' } } })
        const before = await lastLineId(db)
        const res = await callback(p, hub, `code=c&state=${state}`)
        expect(res.status).toBe(303)
        expect(res.headers.get('Location')).toBe(`/tools/${state === STATE ? 'slack' : 'shopify'}?connect_error=${code}`)
        expect(await db.prepare('SELECT COUNT(*) AS n FROM connector_accounts').first<number>('n'), `${code} ${state}`).toBe(0)
        expect(await linesSince(db, before)).toEqual([])
      }
    }
  })

  it('a thrown completeConnect or failConnect still redirects (connect_error=internal) and writes nothing', async () => {
    const p = await inhouse()
    const { hub } = fakeHub()
    const throwing: ConnectBinding = {
      ...hub,
      completeConnect: async () => {
        throw new Error('rpc lost')
      },
      failConnect: async () => {
        throw new Error('rpc lost')
      },
    }
    const before = await lastLineId(db)
    for (const q of [`code=c&state=${STATE}`, `error=access_denied&state=${STATE}`]) {
      const res = await callback(p, throwing, q)
      expect(res.status).toBe(303)
      expect(res.headers.get('Location')).toBe('/tools/slack?connect_error=internal')
    }
    expect(await row()).toBeNull()
    expect(await linesSince(db, before)).toEqual([])
  })

  it('a thrown listAccounts after an accepted failure records failed: the row and its line land, the redirect happens', async () => {
    const p = await inhouse()
    const { hub } = fakeHub({ complete: { ok: false, error: { code: 'scope_mismatch', message: 'x' } } })
    await start(p, hub)
    const throwing: ConnectBinding = {
      ...hub,
      listAccounts: async () => {
        throw new Error('rpc lost')
      },
    }
    const before = await lastLineId(db)
    const res = await callback(p, throwing, `code=c&state=${STATE}`)
    expect(res.headers.get('Location')).toBe('/tools/slack?connect_error=scope_mismatch')
    expect(await row()).toMatchObject({ last_state: 'failed', rev: 2 })
    expect((await linesSince(db, before)).map(l => JSON.parse(l.args_json))).toEqual([{ accountId: SLACK, outcome: 'scope_mismatch' }])
  })

  it('a state the hub refuses writes nothing; an unreadable prefix redirects to /tools', async () => {
    const p = await inhouse()
    const { hub } = fakeHub({ complete: { ok: false, error: { code: 'state_invalid', message: 'x' } }, fail: { ok: true, value: { accountId: null } } })
    const before = await lastLineId(db)
    expect((await callback(p, hub, `code=c&state=${STATE}`)).headers.get('Location')).toBe('/tools/slack?connect_error=state_invalid')
    expect((await callback(p, hub, 'code=c&state=not-a-state')).headers.get('Location')).toBe('/tools?connect_error=state_invalid')
    expect((await callback(p, hub, 'error=access_denied&state=nope')).headers.get('Location')).toBe('/tools?connect_error=state_invalid')
    expect((await callback(p, hub, 'state=only')).headers.get('Location')).toBe('/tools?connect_error=state_invalid')
    expect(await row()).toBeNull()
    expect(await linesSince(db, before)).toEqual([])
  })

  it('a forged prefix only changes the redirect path, never the outcome or what is written (failure 4)', async () => {
    const p = await inhouse()
    const { hub, calls } = fakeHub({ complete: { ok: false, error: { code: 'state_invalid', message: 'x' } } })
    const before = await lastLineId(db)
    const res = await callback(p, hub, `code=c&state=${FORGED}`)
    expect(res.headers.get('Location')).toBe('/tools/shopify?connect_error=state_invalid')
    expect(calls.map(c => c.method)).toEqual(['completeConnect'])
    expect(await db.prepare('SELECT COUNT(*) AS n FROM connector_accounts').first<number>('n')).toBe(0)
    expect(await linesSince(db, before)).toEqual([])
    expect(stateAccountHint(FORGED)).toBe('shopify:store')
    expect(stateAccountHint(STATE)).toBe(SLACK)
    expect(stateAccountHint(`${btoa('Not An Id')}.x`)).toBeNull()
  })

  it('a hub code outside the closed list redirects as internal', async () => {
    const p = await inhouse()
    const { hub } = fakeHub({ complete: { ok: false, error: { code: '<b>raw</b>' as HubErrorCode, message: '' } } })
    expect((await callback(p, hub, `code=c&state=${STATE}`)).headers.get('Location')).toBe('/tools/slack?connect_error=internal')
  })
})

describe('the store writes a change and its line together (failure 5)', () => {
  it('a broken audit insert rolls the row change back', async () => {
    const broken = openStores(env, brokenAudit)
    const p = await inhouse()
    const { hub } = fakeHub()
    await expect(callback(p, hub, `code=c&state=${STATE}`, broken)).rejects.toThrow()
    expect(await row()).toBeNull()
  })

  it('W3 functions: list, recordPause (line only), recordDisconnect (row and line, rev + 1)', async () => {
    const p = await inhouse()
    const at = { actorId: (p as { memberId: string }).memberId, requestId: reqId(), nowMs: T }
    await stores.connectors.connectStarted(SLACK, 'slack', at)
    const before = await lastLineId(db)
    await stores.connectors.recordPause(SLACK, { action: 'tools.connect_start', accountId: SLACK }, { ...at, requestId: reqId() })
    expect((await row())!.rev).toBe(1)
    await stores.connectors.recordDisconnect(SLACK, 'slack', { action: 'tools.connect', accountId: SLACK, outcome: 'ok' }, { ...at, requestId: reqId(), nowMs: T + 5 })
    expect(await stores.connectors.list()).toEqual([
      expect.objectContaining({ accountId: SLACK, lastState: 'disconnected', disconnectedBy: at.actorId, disconnectedAtMs: T + 5, rev: 2 }),
    ])
    expect((await linesSince(db, before)).map(l => l.target_kind)).toEqual(['connector', 'connector'])
  })
})
