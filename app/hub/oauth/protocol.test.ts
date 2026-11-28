// P5 W1 brief "Unit cases": Slack's token answers, scope parsing, discovery refusals, the host check, and the MCP
// client's answers (isError, an SSE single event, 4 MiB + 1, 403 insufficient_scope). Literal fixtures throughout.
import { describe, expect, it, vi } from 'vitest'
import { reviewedCall } from '../connectors/mcp/reviewed-call'
import { EraCache, ERA_TTL_MS } from '../connectors/mcp/sdk'
import { slackConnector } from '../connectors/mcp/slack/route'
import { notesConnector } from '../connectors/mcp/testing/notes-connector'
import type { McpConnectorModule } from '../registry/registry'
import { MCP_MAX_BYTES, send } from './http'
import { asMetadataUrls, discover, exchangeCode, pinnedEndpoints, refreshTokens, resourceMetadataFrom, stateAccount, type ClientCreds } from './protocol'
import { createMcpUpstream } from '../../test/upstreams/mcp/server'

const client: ClientCreds = { clientId: 'cid', clientSecret: 'csecret', authMethod: 'client_secret_post', expiresAtMs: null }
const answering = (make: () => Response) => async () => make()
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const exchange = (make: () => Response, c: McpConnectorModule = slackConnector) =>
  exchangeCode(answering(make), c, pinnedEndpoints(slackConnector), client, { code: 'code', verifier: 'v', redirectUri: 'https://inhouse.example.com/api/connect/callback' })

describe("Slack's token answers", () => {
  const cases: [string, () => Response, string][] = [
    ['invalid_code', () => json({ ok: false, error: 'invalid_code' }), 'connect_refused'],
    ['bad_redirect_uri', () => json({ ok: false, error: 'bad_redirect_uri' }), 'connect_refused'],
    ['invalid_code_verifier', () => json({ ok: false, error: 'invalid_code_verifier' }), 'connect_refused'],
    ['ratelimited', () => json({ ok: false, error: 'ratelimited' }, 200, { 'Retry-After': '7' }), 'rate_limited'],
    ['another error as HTTP 200 ok: false', () => json({ ok: false, error: 'team_access_not_granted' }), 'upstream_rejected'],
  ]
  for (const [name, make, code] of cases) {
    it(`${name} is ${code}`, async () => {
      const r = await exchange(make)
      expect(!r.ok && r.code).toBe(code)
      if (code === 'rate_limited') expect(!r.ok && r.retryAfterMs).toBe(7000)
    })
  }

  it('scope under authed_user.scope, team.id and no refresh token (rotation off, S4 shape)', async () => {
    const r = await exchange(() => json({ ok: true, access_token: 'xoxp-1', token_type: 'Bearer', team: { id: 'T0TEST0001' }, authed_user: { id: 'U1', scope: 'channels:read, users:read,,' } }))
    expect(r).toEqual({ ok: true, tokens: { accessToken: 'xoxp-1', refreshToken: null, expiresInS: null, scopes: ['channels:read', 'users:read'], teamId: 'T0TEST0001' } })
  })

  it('a token answer with no scope carries null scopes (the exact check then fails closed)', async () => {
    const r = await exchange(() => json({ ok: true, access_token: 'xoxp-1', team: { id: 'T0TEST0001' } }))
    expect(r.ok && r.tokens.scopes).toBeNull()
  })

  it('rotation on: refresh_token and expires_in', async () => {
    const r = await exchange(() => json({ ok: true, access_token: 'xoxe.xoxp-1', refresh_token: 'xoxe-1', expires_in: 43200, scope: 'users:read', team: { id: 'T' } }))
    expect(r.ok && [r.tokens.refreshToken, r.tokens.expiresInS]).toEqual(['xoxe-1', 43200])
  })

  it('refresh classes from the answer alone', async () => {
    const ep = pinnedEndpoints(slackConnector)
    const refresh = (up: () => Promise<Response>) => refreshTokens(up, slackConnector, ep, client, 'xoxe-1')
    expect(await refresh(async () => json({ ok: false, error: 'invalid_refresh_token' }))).toEqual({ ok: false, code: 'credentials_rejected', cls: 'spent' })
    expect(await refresh(async () => json({ ok: false, error: 'ratelimited' }))).toMatchObject({ cls: 'not_consumed', code: 'rate_limited' })
    expect(await refresh(async () => Promise.reject(new TypeError('dns')))).toMatchObject({ cls: 'not_consumed' })
    expect(await refresh(async () => new Response(null, { status: 503 }))).toMatchObject({ cls: 'not_consumed' })
    expect(await refresh(async () => new Response('<html>oops</html>', { status: 502 }))).toMatchObject({ cls: 'unclear' })
    expect(await refresh(async () => new Response('{"ok":tr', { status: 200 }))).toMatchObject({ cls: 'unclear' })
  })
})

describe('discovery (dynamic connectors)', () => {
  it('follows resource_metadata, then RFC 8414, and validates every endpoint', async () => {
    const fake = createMcpUpstream('notes')
    const r = await discover(fake.fetch, notesConnector)
    expect(r).toEqual({
      ok: true,
      endpoints: {
        authorization: 'https://auth.notes.example.com/authorize',
        token: 'https://auth.notes.example.com/token',
        revoke: 'https://auth.notes.example.com/revoke',
        registration: 'https://auth.notes.example.com/register',
        authMethods: ['client_secret_post'],
      },
    })
  })

  it('without resource_metadata in the 401, the path-inserted well-known URI is tried first', async () => {
    const fake = createMcpUpstream('notes')
    fake.headerMetadata = false
    expect((await discover(fake.fetch, notesConnector)).ok).toBe(true)
    expect(fake.requests.filter(r => r.method === 'GET').map(r => r.path)[0]).toBe('/.well-known/oauth-protected-resource/mcp')
  })

  it('refuses an AS without S256', async () => {
    const fake = createMcpUpstream('notes')
    fake.noS256 = true
    expect(await discover(fake.fetch, notesConnector)).toEqual({ ok: false, code: 'connect_refused' })
  })

  it("refuses a PRM resource that isn't mcp.resource", async () => {
    const fake = createMcpUpstream('notes')
    fake.prmResource = 'https://other.example.com/mcp'
    expect(await discover(fake.fetch, notesConnector)).toEqual({ ok: false, code: 'connect_refused' })
  })

  it('accepts a PRM resource that differs from the endpoint when it is mcp.resource (Slack’s shape)', async () => {
    const fake = createMcpUpstream('notes')
    fake.prmResource = 'https://notes.example.com'
    expect((await discover(fake.fetch, { ...notesConnector, mcp: { ...notesConnector.mcp, resource: 'https://notes.example.com' } })).ok).toBe(true)
  })

  it('an endpoint on a host not allowed is refused before any request', async () => {
    const seen: string[] = []
    const up = async (req: Request) => {
      seen.push(req.url)
      return new Response('{}')
    }
    const r = await send(up, 'https://evil.example/token', { method: 'POST', headers: {} }, { allowedHosts: ['slack.com'], timeoutMs: 1000, maxBytes: 10 })
    expect(r).toEqual({ kind: 'blocked' })
    expect(await send(up, 'http://slack.com/x', { method: 'GET', headers: {} }, { allowedHosts: ['slack.com'], timeoutMs: 1000, maxBytes: 10 })).toEqual({ kind: 'blocked' })
    expect(seen).toEqual([])
  })

  it('AS metadata URLs in the spec’s order', () => {
    expect(asMetadataUrls('https://a.example.com')).toEqual(['https://a.example.com/.well-known/oauth-authorization-server', 'https://a.example.com/.well-known/openid-configuration'])
    expect(asMetadataUrls('https://a.example.com/t1')).toEqual([
      'https://a.example.com/.well-known/oauth-authorization-server/t1',
      'https://a.example.com/.well-known/openid-configuration/t1',
      'https://a.example.com/t1/.well-known/openid-configuration',
    ])
    expect(resourceMetadataFrom('Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"')).toBe('https://mcp.slack.com/.well-known/oauth-protected-resource')
  })

  it('state prefixes route only to well-formed account ids', () => {
    const rand = 'A'.repeat(43)
    expect(stateAccount(`c2xhY2s6d29ya3NwYWNl.${rand}`)).toBe('slack:workspace')
    expect(stateAccount(`U0xBQ0s.${rand}`)).toBeNull()
    expect(stateAccount(`c2xhY2s6d29ya3NwYWNl.short`)).toBeNull()
    expect(stateAccount('nodot')).toBeNull()
  })
})

describe('the MCP client (the SDK wrapper, through reviewed-call.ts since M4-C2)', () => {
  const endpoint = 'https://mcp.slack.com/mcp'
  /** A known 2025 server: the era is cached as legacy, so the call runs the plain handshake (no probe). */
  const deps = (upstream: (req: Request) => Promise<Response>) => {
    const eras = new EraCache()
    eras.set(endpoint, 1, { kind: 'legacy' }, Date.now() + ERA_TTL_MS)
    return { upstream, now: () => Date.now(), eras }
  }
  /** Answers initialize and the notification, then `last` (with the request's id) for tools/call. */
  const server = (last: (id: unknown) => Response) => async (req: Request) => {
    const msg = (await req.json()) as { method: string; id?: number }
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }, 200, { 'Mcp-Session-Id': 's1' })
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 })
    return last(msg.id)
  }
  const callWith = (upstream: (req: Request) => Promise<Response>, token: string) =>
    reviewedCall(deps(upstream), { endpoint, token, generation: 1, session: null, name: 'slack_search_public', args: {} })
  const call = (last: (id: unknown) => Response) => callWith(server(last), 'tok')

  it('an isError result is upstream_rejected with no upstream text', async () => {
    const r = await call(id => json({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'SECRET upstream detail' }] } }))
    expect(r).toEqual({ kind: 'error', code: 'upstream_rejected' })
  })

  it('a JSON-RPC error is upstream_rejected', async () => {
    expect(await call(id => json({ jsonrpc: '2.0', id, error: { code: -1, message: 'SECRET' } }))).toEqual({ kind: 'error', code: 'upstream_rejected' })
  })

  it('a single-event SSE answer is accepted; text parts kept, others counted', async () => {
    const body = (id: unknown) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'aGk=', mimeType: 'image/png' }] } })
    const r = await call(id => new Response(`event: message\ndata: ${JSON.stringify(body(id))}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }))
    expect(r).toMatchObject({ kind: 'ok', result: { content: [{ type: 'text', text: 'hi' }] }, dropped: 1 })
  })

  it('one invalid or unknown content part fails the whole read as upstream_unavailable (the SDK checks the schema; #695)', async () => {
    // The old client dropped and counted such a part; the SDK refuses a result that breaks the CallToolResult schema.
    // This pins today's strict reading until #695 decides strict or lenient.
    const answer = (part: Record<string, unknown>) => (id: unknown) => json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'hi' }, part] } })
    expect(await call(answer({ type: 'image', data: 'x' }))).toEqual({ kind: 'error', code: 'upstream_unavailable' })
    expect(await call(answer({ type: 'widget', value: 1 }))).toEqual({ kind: 'error', code: 'upstream_unavailable' })
    // Control: the same answer with a spec-valid part is read, the part dropped and counted.
    expect(await call(answer({ type: 'image', data: 'aGk=', mimeType: 'image/png' }))).toMatchObject({ kind: 'ok', dropped: 1 })
  })

  it('a body over 4 MiB is result_too_large', async () => {
    const big = 'x'.repeat(MCP_MAX_BYTES + 1)
    expect(await call(() => new Response(big, { headers: { 'Content-Type': 'application/json' } }))).toEqual({ kind: 'error', code: 'result_too_large' })
  })

  it('a 403 insufficient_scope is scope_mismatch; a 429 carries Retry-After; a 401 is unauthorized', async () => {
    expect(await call(() => new Response(null, { status: 403, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="files:read"' } }))).toEqual({ kind: 'error', code: 'scope_mismatch' })
    expect(await call(() => new Response(null, { status: 429, headers: { 'Retry-After': '3' } }))).toEqual({ kind: 'error', code: 'rate_limited', retryAfterMs: 3000 })
    expect(await call(() => new Response(null, { status: 401 }))).toEqual({ kind: 'unauthorized' })
  })

  it('the bearer is on every request, never in the URL', async () => {
    const seen: Request[] = []
    const up = server(id => json({ jsonrpc: '2.0', id, result: { content: [] } }))
    await callWith(async req => (seen.push(req.clone()), up(req)), 'tok-123')
    expect(seen).toHaveLength(3)
    for (const r of seen) {
      expect(r.headers.get('Authorization')).toBe('Bearer tok-123')
      expect(r.url).not.toContain('tok-123')
    }
    expect(seen[2]!.headers.get('Mcp-Session-Id')).toBe('s1')
  })

  it('no console output on an answered call, a refused one or a planted bad answer (N36)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}))
    try {
      expect(await call(id => json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'hi' }] } }))).toMatchObject({ kind: 'ok' })
      expect(await call(() => new Response(null, { status: 401 }))).toEqual({ kind: 'unauthorized' })
      expect(await call(id => json({ jsonrpc: '2.0', id, result: { content: 'SECRET not a list' } }))).toEqual({ kind: 'error', code: 'upstream_unavailable' })
      for (const s of spies) expect(s).not.toHaveBeenCalled()
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })
})
