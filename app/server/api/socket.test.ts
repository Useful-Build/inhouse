// Route 34 (p3-design sections 3 and 4.10) through the whole /api/* path (server/api.ts) with the real sign-in, a local
// key set, in-memory auth stores, the real routes and matrix, and the real BrandAgent holding real sockets. Expected
// statuses and codes are literals. Ways it can fail, written down first:
//  1. an upgrade without a valid sign-in, or from another origin, gets a socket (must be 401, 403 `bad_origin`);
//  2. a plain GET answers 2xx (the route only upgrades) or reaches the object;
//  3. a principal header the browser sent reaches the object (a socket for someone else's runs);
//  4. a version this build doesn't speak streams anything (must close `4409`);
//  5. Inhouse without a live grant gets a socket.
import { runInDurableObject } from 'cloudflare:test'
import { env as baseEnv } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { routes } from '../routes.ts'
import { accessMatrix } from '../access-matrix.ts'
import { authenticate, checkAccess, checkOrigin } from '../auth/index.ts'
import { mintPerson } from '../auth/test-issuer-mint.ts'
import { BRAND, INHOUSE, TEAM, authEnv, fakeStores, issuer } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { PRINCIPAL_HEADER } from '../do/brand-agent/sockets.ts'

let good: Issuer
beforeAll(async () => { good = await issuer() })
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext

function setup(o: { grant?: boolean } = {}) {
  const s = fakeStores({ people: { member: { role: 'member' } }, grant: o.grant ? { id: 'g_sock', endsAtMs: Date.now() + 3_600_000 } : null })
  const parts: ApiParts = {
    authenticate: (r, e, st, n, id) => authenticate(r, e, st, n, id, good.keys),
    checkOrigin, checkAccess, stores: () => s.stores, routes, accessMatrix,
  }
  const env = { ...baseEnv, ...authEnv() } as Env
  const call = (origin: string, path: string, headers: Record<string, string>) =>
    api(parts, new Request(`${origin}${path}`, { headers }), env, ctx, 'req-sock')
  return { call, calls: s.calls }
}
const jwt = (who: 'member' | 'inhouse') =>
  mintPerson({ key: good.key.privateJwk, iss: TEAM, aud: who === 'inhouse' ? INHOUSE.aud : BRAND.aud, sub: who, email: `${who}@example.test` })
const upgrade = { Upgrade: 'websocket' }
const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

/** The next message or close on a client socket. */
function next(ws: WebSocket): Promise<{ message: unknown } | { close: number }> {
  return new Promise(resolve => {
    const onMessage = (e: MessageEvent) => { done(); resolve({ message: JSON.parse(e.data as string) }) }
    const onClose = (e: CloseEvent) => { done(); resolve({ close: e.code }) }
    const done = () => { ws.removeEventListener('message', onMessage); ws.removeEventListener('close', onClose) }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
  })
}

describe('route 34 (4.10)', () => {
  it('an upgrade without a sign-in is 401; from another origin 403 bad_origin; a plain GET 400', async () => {
    quiet()
    const { call } = setup()
    expect((await call(BRAND.origin, '/api/socket?v=1', { ...upgrade, Origin: BRAND.origin })).status).toBe(401)
    const res = await call(BRAND.origin, '/api/socket?v=1', { ...upgrade, Origin: 'https://elsewhere.example.test', 'Cf-Access-Jwt-Assertion': await jwt('member') })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'forbidden', reason: 'bad_origin' } })
    const plain = await call(BRAND.origin, '/api/socket?v=1', { Origin: BRAND.origin, 'Cf-Access-Jwt-Assertion': await jwt('member') })
    expect(plain.status).toBe(400)
    vi.restoreAllMocks()
  })

  it('a member gets a socket; a principal header the browser sent never reaches the object', async () => {
    const runId = 'r_SpoofSpoofSpoofSpoof01'
    await runInDurableObject(brandAgent(baseEnv), async (_i, state) => {
      state.storage.sql.exec("INSERT OR IGNORE INTO runs (run_id, chat_id, owner_id, state, last_seq, started_at_ms) VALUES (?, 'c_spoof', 'm_spoofed', 'ended', 0, 0)", runId)
    })
    const spoof = JSON.stringify({ kind: 'person', memberId: 'm_spoofed', role: 'member', grantId: null, grantEndsAtMs: null, expMs: Date.now() + 3_600_000, requestId: 'x' })
    const { call } = setup()
    const res = await call(BRAND.origin, '/api/socket?v=1', { ...upgrade, Origin: BRAND.origin, 'Cf-Access-Jwt-Assertion': await jwt('member'), [PRINCIPAL_HEADER]: spoof })
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    ws.accept()
    const answer = next(ws)
    ws.send(JSON.stringify({ type: 'attach', runId, fromSeq: 0 }))
    expect(await answer, 'the socket is m_member\'s, not the spoofed one').toEqual({ message: { type: 'refused', runId, code: 'not_found' } })
    ws.close(1000)
  })

  it('a version this build does not speak closes 4409', async () => {
    const { call } = setup()
    const res = await call(BRAND.origin, '/api/socket?v=2', { ...upgrade, Origin: BRAND.origin, 'Cf-Access-Jwt-Assertion': await jwt('member') })
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    const closed = next(ws)
    ws.accept()
    expect(await closed).toEqual({ close: 4409 })
  })

  it('Inhouse without a live grant is 403 grant_required; with one it gets a socket, its support.access line first', async () => {
    quiet()
    const none = setup({ grant: false })
    const refused = await none.call(INHOUSE.origin, '/api/socket?v=1', { ...upgrade, Origin: INHOUSE.origin, 'Cf-Access-Jwt-Assertion': await jwt('inhouse') })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: { code: 'forbidden', reason: 'grant_required' } })
    const live = setup({ grant: true })
    const res = await live.call(INHOUSE.origin, '/api/socket?v=1', { ...upgrade, Origin: INHOUSE.origin, 'Cf-Access-Jwt-Assertion': await jwt('inhouse') })
    expect(res.status).toBe(101)
    expect(live.calls.supportAccess).toEqual([expect.objectContaining({ method: 'GET', route: '/api/socket' })])
    res.webSocket!.accept()
    res.webSocket!.close(1000)
    vi.restoreAllMocks()
  })
})
