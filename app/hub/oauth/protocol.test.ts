// P5 W1 brief "Unit cases": Slack's token answers, scope parsing, discovery refusals, the host check, and the MCP
// client's answers (isError, an SSE single event, 4 MiB + 1, 403 insufficient_scope). Literal fixtures throughout.
import { describe, expect, it } from 'vitest'
import { callMcpTool, singleEvent } from '../connectors/mcp/client'
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

describe('the MCP client', () => {
  const target = { endpoint: 'https://mcp.slack.com/mcp', allowedHosts: ['mcp.slack.com'] }
  /** Answers initialize and the notification, then `last` for tools/call. */
  const server = (last: () => Response) => async (req: Request) => {
    const msg = (await req.json()) as { method: string; id?: number }
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25' } }, 200, { 'Mcp-Session-Id': 's1' })
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 })
    return last()
  }
  const call = (last: () => Response) => callMcpTool(server(last), target, 'tok', 1, null, 'slack_search_public', {})

  it('an isError result is upstream_rejected with no upstream text', async () => {
    const r = await call(() => json({ jsonrpc: '2.0', id: 3, result: { isError: true, content: [{ type: 'text', text: 'SECRET upstream detail' }] } }))
    expect(r).toEqual({ kind: 'error', code: 'upstream_rejected' })
  })

  it('a JSON-RPC error is upstream_rejected', async () => {
    expect(await call(() => json({ jsonrpc: '2.0', id: 3, error: { code: -1, message: 'SECRET' } }))).toEqual({ kind: 'error', code: 'upstream_rejected' })
  })

  it('a single-event SSE answer is accepted; text parts kept, others counted', async () => {
    const body = { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'x' }] } }
    const r = await call(() => new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }))
    expect(r).toMatchObject({ kind: 'ok', result: { content: [{ type: 'text', text: 'hi' }] }, dropped: 1 })
    expect(singleEvent('data: {"a":1}\n\ndata: {"b":2}\n\n')).toBeNull()
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
    const up = server(() => json({ jsonrpc: '2.0', id: 3, result: { content: [] } }))
    await callMcpTool(async req => (seen.push(req.clone()), up(req)), target, 'tok-123', 1, null, 'slack_search_public', {})
    expect(seen).toHaveLength(3)
    for (const r of seen) {
      expect(r.headers.get('Authorization')).toBe('Bearer tok-123')
      expect(r.url).not.toContain('tok-123')
    }
    expect(seen[2]!.headers.get('Mcp-Session-Id')).toBe('s1')
  })
})
