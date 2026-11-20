// The /api/* request path (server/api.ts) with W1's auth, the route table and the matrix stood in for: a handler's own
// Response still carries the security headers and no-store, and the Origin check runs on non-GET requests and on a
// WebSocket upgrade GET, never on a plain GET. (vi.mock fails in this pool, "asyncLocalStorage.disable() is not
// implemented", so the parts come in as arguments.)
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from './api.ts'
import type { ApiParts } from './api.ts'
import { unwiredStores } from './testing/auth-fixtures.ts'

const handler = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } }))
const checkOrigin = vi.fn<ApiParts['checkOrigin']>()
const parts: ApiParts = {
  authenticate: async (_r, _e, _s, _n, requestId) => ({ principal: { kind: 'person', memberId: 'm_probe', role: 'member', subject: 's', requestId } }),
  checkOrigin,
  checkAccess: () => ({ ok: true }),
  stores: () => unwiredStores,
  routes: (['GET', 'POST'] as const).map(method => ({ method, pattern: '/api/probe', handler })),
  accessMatrix: (['GET', 'POST'] as const).map(method => ({ method, pattern: '/api/probe', class: 'baseline', allow: ['member'] })),
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
const call = (init: RequestInit = {}) => api(parts, new Request('http://brand.localhost:8787/api/probe', init), env, ctx, 'req-1')

beforeEach(() => {
  checkOrigin.mockReset().mockReturnValue(null)
  handler.mockClear()
})

describe('a handler cannot opt out of the security headers', () => {
  test('its own Response gets the CSP, nosniff and no-store, and keeps its status, body and other headers', async () => {
    const res = await call()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})

describe('the Origin check', () => {
  test('runs on a WebSocket upgrade GET and refuses a bad Origin with 403 bad_origin, before the handler', async () => {
    checkOrigin.mockReturnValue('bad_origin')
    const res = await call({ headers: { Upgrade: 'websocket', Origin: 'http://evil.example.test' } })
    expect(checkOrigin).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalled()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'forbidden', reason: 'bad_origin' } })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
  test('runs on a POST', async () => {
    await call({ method: 'POST' })
    expect(checkOrigin).toHaveBeenCalledTimes(1)
  })
  test('does not run on a plain GET', async () => {
    const res = await call()
    expect(checkOrigin).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
  })
})
