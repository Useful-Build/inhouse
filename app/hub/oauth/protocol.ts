// The OAuth pieces of the connect flow (P5 W1 section 5): PKCE, the state, discovery, dynamic registration, the
// authorization URL, the code exchange, refresh and revoke. Pure functions over an injected upstream and randomness;
// SignIn (signin/core.ts) holds every record decision. Nothing here logs, and no result carries upstream text.
// Docs read 2026-11-21:
// - https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization (PRM first: `resource_metadata` from
//   WWW-Authenticate, then path-inserted then root well-known; AS metadata RFC 8414 then OIDC in the listed order;
//   PKCE S256, refuse when `code_challenge_methods_supported` is absent; `resource` in both requests)
// - https://datatracker.ietf.org/doc/html/rfc7636 (S256, Appendix B), RFC 7591 (registration), RFC 7009 (revoke)
// - https://docs.slack.dev/reference/methods/oauth.v2.user.access (errors as HTTP 200 `ok: false`; scope under
//   `authed_user.scope` or top level; `team.id`), https://docs.slack.dev/authentication/using-token-rotation/
//   (43200 s tokens, single-use refresh tokens), https://docs.slack.dev/reference/methods/auth.revoke
import type { HubErrorCode } from '../index/contract'
import { fromBase64Url, toBase64Url } from '../crypto/envelope'
import { ACCOUNT_ID } from '../index/schemas'
import type { McpConnectorModule } from '../registry/registry'
import { allowedUrl, jsonObject, retryAfterMs, send, TOKEN_MAX_BYTES, TOKEN_TIMEOUT_MS, type Upstream } from './http'

export type Random = (n: number) => Uint8Array
export const defaultRandom: Random = n => crypto.getRandomValues(new Uint8Array(n))

/** OC-W1-2: a connect is one person at one screen. */
export const STATE_TTL_MS = 10 * 60_000

// ---------- PKCE and state ----------

/** 32 random bytes, base64url: 43 characters. */
export const newVerifier = (random: Random): string => toBase64Url(random(32))

export async function challengeFor(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

/** base64url(accountId) + '.' + base64url(32 random bytes). The prefix only routes; the binding is the stored item. */
export const newState = (accountId: string, random: Random): string => `${toBase64Url(new TextEncoder().encode(accountId))}.${toBase64Url(random(32))}`

/** The account a state routes to, or null when the prefix isn't a base64url account id. */
export function stateAccount(state: string): string | null {
  const dot = state.indexOf('.')
  if (dot <= 0 || dot !== state.lastIndexOf('.')) return null
  const random = fromBase64Url(state.slice(dot + 1))
  if (!random || random.length !== 32) return null
  const bytes = fromBase64Url(state.slice(0, dot))
  if (!bytes) return null
  let id: string
  try {
    id = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return null
  }
  return ACCOUNT_ID.test(id) ? id : null
}

// ---------- endpoints ----------

export type Endpoints = {
  authorization: string
  token: string
  revoke: string | null
  registration: string | null
  /** From AS metadata; pre-registered Slack uses client_secret_post. */
  authMethods: readonly string[]
}

export type Refused = { ok: false; code: Extract<HubErrorCode, 'connect_refused' | 'upstream_unavailable' | 'rate_limited' | 'internal'>; retryAfterMs?: number }

export function pinnedEndpoints(c: McpConnectorModule): Endpoints {
  const e = c.endpoints!
  return { authorization: e.authorization, token: e.token, revoke: e.revoke, registration: null, authMethods: ['client_secret_post'] }
}

async function getJson(upstream: Upstream, url: string, hosts: readonly string[]): Promise<{ status: number; json: Record<string, unknown> | null } | { status: 0; json: null; blocked: boolean }> {
  const sent = await send(upstream, url, { method: 'GET', headers: { Accept: 'application/json' } }, { allowedHosts: hosts, timeoutMs: TOKEN_TIMEOUT_MS, maxBytes: TOKEN_MAX_BYTES })
  if (sent.kind === 'blocked') return { status: 0, json: null, blocked: true }
  if (sent.kind !== 'response') return { status: 0, json: null, blocked: false }
  return { status: sent.status, json: sent.status >= 200 && sent.status < 300 ? jsonObject(sent.text) : null }
}

/** `resource_metadata="…"` from a Bearer challenge. */
export function resourceMetadataFrom(challenge: string | null): string | null {
  if (!challenge) return null
  const m = /resource_metadata="([^"]+)"/.exec(challenge)
  return m ? m[1]! : null
}

/** RFC 8414 then OIDC URLs for an issuer, in the MCP spec's order (path-inserted forms for an issuer with a path). */
export function asMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/+$/, '')
  if (path === '') return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
}

const sameResource = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * Discovery for a dynamic connector, exactly in the MCP spec's order. Refuses (`connect_refused`) when PRM's `resource`
 * isn't `mcp.resource`, an endpoint isn't https on an allowed host, or the AS doesn't list S256.
 */
export async function discover(upstream: Upstream, c: McpConnectorModule): Promise<{ ok: true; endpoints: Endpoints } | Refused> {
  const hosts = c.mcp.allowedHosts
  // 1. An unauthenticated POST to the MCP endpoint, for the 401's resource_metadata.
  const probe = await send(upstream, c.mcp.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Inhouse', version: '1.0.0' } } }),
  }, { allowedHosts: hosts, timeoutMs: TOKEN_TIMEOUT_MS, maxBytes: TOKEN_MAX_BYTES })
  if (probe.kind === 'blocked') return { ok: false, code: 'connect_refused' }
  const endpoint = new URL(c.mcp.endpoint)
  const path = endpoint.pathname.replace(/\/+$/, '')
  const candidates: string[] = []
  const fromHeader = probe.kind === 'response' ? resourceMetadataFrom(probe.headers.get('WWW-Authenticate')) : null
  if (fromHeader) candidates.push(fromHeader)
  else {
    if (path !== '') candidates.push(`${endpoint.origin}/.well-known/oauth-protected-resource${path}`)
    candidates.push(`${endpoint.origin}/.well-known/oauth-protected-resource`)
  }
  let prm: Record<string, unknown> | null = null
  for (const url of candidates) {
    if (!allowedUrl(url, hosts)) return { ok: false, code: 'connect_refused' }
    const r = await getJson(upstream, url, hosts)
    if (r.json) {
      prm = r.json
      break
    }
  }
  if (!prm) return { ok: false, code: 'upstream_unavailable' }
  if (typeof prm.resource !== 'string' || !sameResource(prm.resource, c.mcp.resource)) return { ok: false, code: 'connect_refused' }
  const servers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter((s): s is string => typeof s === 'string') : []
  const issuer = servers.find(s => allowedUrl(s, hosts) !== null)
  if (!issuer) return { ok: false, code: 'connect_refused' }

  let as: Record<string, unknown> | null = null
  for (const url of asMetadataUrls(issuer)) {
    const r = await getJson(upstream, url, hosts)
    if (r.json) {
      as = r.json
      break
    }
  }
  if (!as) return { ok: false, code: 'upstream_unavailable' }
  const methods = Array.isArray(as.code_challenge_methods_supported) ? as.code_challenge_methods_supported : null
  if (!methods || !methods.includes('S256')) return { ok: false, code: 'connect_refused' }
  const url = (v: unknown) => (typeof v === 'string' && allowedUrl(v, hosts) ? v : null)
  const authorization = url(as.authorization_endpoint)
  const token = url(as.token_endpoint)
  if (!authorization || !token) return { ok: false, code: 'connect_refused' }
  const optional = (v: unknown) => (v === undefined ? null : url(v) ?? false)
  const revoke = optional(as.revocation_endpoint)
  const registration = optional(as.registration_endpoint)
  if (revoke === false || registration === false) return { ok: false, code: 'connect_refused' }
  const authMethods = Array.isArray(as.token_endpoint_auth_methods_supported)
    ? as.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === 'string')
    : ['client_secret_basic'] // RFC 8414's default
  return { ok: true, endpoints: { authorization, token, revoke, registration, authMethods } }
}

// ---------- clients ----------

/** The client the hub authenticates as. A dynamic one is sealed in the SignIn record (`client` envelope) as JSON. */
export type ClientCreds = { clientId: string; clientSecret: string | null; authMethod: 'client_secret_post' | 'client_secret_basic' | 'none'; expiresAtMs: number | null }

/** RFC 7591 registration: `client_name` Inhouse, our redirect URI, code and refresh grants, client_secret_post preferred. */
export async function register(upstream: Upstream, c: McpConnectorModule, endpoints: Endpoints, redirectUri: string): Promise<{ ok: true; client: ClientCreds } | Refused> {
  if (!endpoints.registration) return { ok: false, code: 'connect_refused' }
  const prefer = ['client_secret_post', 'client_secret_basic', 'none'] as const
  const authMethod = prefer.find(m => endpoints.authMethods.includes(m))
  if (!authMethod) return { ok: false, code: 'connect_refused' }
  const sent = await send(upstream, endpoints.registration, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_name: 'Inhouse', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: authMethod }),
  }, { allowedHosts: c.mcp.allowedHosts, timeoutMs: TOKEN_TIMEOUT_MS, maxBytes: TOKEN_MAX_BYTES })
  if (sent.kind === 'blocked') return { ok: false, code: 'connect_refused' }
  if (sent.kind !== 'response' || sent.status >= 500) return { ok: false, code: 'upstream_unavailable' }
  const json = sent.status >= 200 && sent.status < 300 ? jsonObject(sent.text) : null
  if (!json || typeof json.client_id !== 'string' || json.client_id.length === 0) return { ok: false, code: 'connect_refused' }
  const secret = typeof json.client_secret === 'string' && json.client_secret.length > 0 ? json.client_secret : null
  if (authMethod !== 'none' && !secret) return { ok: false, code: 'connect_refused' }
  const exp = typeof json.client_secret_expires_at === 'number' && json.client_secret_expires_at > 0 ? json.client_secret_expires_at * 1000 : null
  return { ok: true, client: { clientId: json.client_id, clientSecret: secret, authMethod, expiresAtMs: exp } }
}

// ---------- the authorization URL ----------

export function authorizeUrl(c: McpConnectorModule, endpoints: Endpoints, p: { clientId: string; redirectUri: string; scopes: readonly string[]; state: string; challenge: string; teamId: string | null }): string {
  const u = new URL(endpoints.authorization)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', p.clientId)
  u.searchParams.set('redirect_uri', p.redirectUri)
  // Slack's user flow takes `scope` on v2_user/authorize; comma or space both parse there, space is RFC 6749's.
  u.searchParams.set('scope', p.scopes.join(' '))
  u.searchParams.set('state', p.state)
  u.searchParams.set('code_challenge', p.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  if (c.mcp.sendResource !== false) u.searchParams.set('resource', c.mcp.resource)
  if (c.profile === 'slack' && p.teamId) u.searchParams.set('team', p.teamId)
  return u.toString()
}

// ---------- the token endpoint ----------

export type Tokens = {
  accessToken: string
  refreshToken: string | null
  expiresInS: number | null
  /** Null when the answer carried no scope (fails the exact check closed). */
  scopes: string[] | null
  teamId: string | null
}

/** How a refresh answer is handled (brief section 4): not consumed (retry on backoff), unclear (once more), spent. */
export type RefreshClass = 'not_consumed' | 'unclear' | 'spent'

export type TokenFail = { ok: false; code: HubErrorCode; retryAfterMs?: number; cls: RefreshClass }
export type TokenResult = { ok: true; tokens: Tokens } | TokenFail

export function splitScopes(raw: unknown, profile: McpConnectorModule['profile']): string[] | null {
  if (typeof raw !== 'string') return null
  return [...new Set(raw.split(profile === 'slack' ? ',' : ' ').map(s => s.trim()).filter(s => s.length > 0))]
}

const SLACK_REFUSED = new Set(['invalid_code', 'bad_redirect_uri', 'invalid_code_verifier'])

function clientAuth(form: URLSearchParams, headers: Record<string, string>, client: ClientCreds): void {
  if (client.authMethod === 'client_secret_basic' && client.clientSecret) {
    headers.Authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`
  } else {
    form.set('client_id', client.clientId)
    if (client.authMethod === 'client_secret_post' && client.clientSecret) form.set('client_secret', client.clientSecret)
  }
}

async function tokenRequest(upstream: Upstream, c: McpConnectorModule, endpoints: Endpoints, client: ClientCreds, form: URLSearchParams, kind: 'code' | 'refresh'): Promise<TokenResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  clientAuth(form, headers, client)
  if (c.mcp.sendResource !== false) form.set('resource', c.mcp.resource)
  const sent = await send(upstream, endpoints.token, { method: 'POST', headers, body: form.toString() }, { allowedHosts: c.mcp.allowedHosts, timeoutMs: TOKEN_TIMEOUT_MS, maxBytes: TOKEN_MAX_BYTES })
  if (sent.kind === 'blocked') return { ok: false, code: 'internal', cls: 'not_consumed' }
  if (sent.kind === 'network') return { ok: false, code: 'upstream_unavailable', cls: 'not_consumed' }
  if (sent.kind === 'lost') return { ok: false, code: 'upstream_unavailable', cls: 'unclear' }
  const { status, headers: h, text } = sent
  if (status === 429) return { ok: false, code: 'rate_limited', retryAfterMs: retryAfterMs(h), cls: 'not_consumed' }
  if (status >= 500) return { ok: false, code: 'upstream_unavailable', cls: text === null || text.length === 0 ? 'not_consumed' : 'unclear' }
  const json = jsonObject(text)
  if (c.profile === 'slack') {
    if (status !== 200 || !json) return status === 400 || status === 401 ? spentOrRefused(kind) : { ok: false, code: 'upstream_unavailable', cls: 'unclear' }
    if (json.ok !== true) {
      const error = typeof json.error === 'string' ? json.error : ''
      if (error === 'ratelimited') return { ok: false, code: 'rate_limited', retryAfterMs: retryAfterMs(h), cls: 'not_consumed' }
      if (kind === 'refresh') return error === 'invalid_refresh_token' ? { ok: false, code: 'credentials_rejected', cls: 'spent' } : { ok: false, code: 'upstream_rejected', cls: 'unclear' }
      return { ok: false, code: SLACK_REFUSED.has(error) ? 'connect_refused' : 'upstream_rejected', cls: 'spent' }
    }
    const authed = typeof json.authed_user === 'object' && json.authed_user !== null ? (json.authed_user as Record<string, unknown>) : {}
    const access = typeof json.access_token === 'string' ? json.access_token : typeof authed.access_token === 'string' ? authed.access_token : ''
    if (access.length === 0) return { ok: false, code: 'upstream_unavailable', cls: 'unclear' }
    const team = typeof json.team === 'object' && json.team !== null ? (json.team as Record<string, unknown>).id : undefined
    return tokensFrom(access, json.refresh_token ?? authed.refresh_token, json.expires_in ?? authed.expires_in, splitScopes(json.scope ?? authed.scope, 'slack'), typeof team === 'string' ? team : null)
  }
  // RFC 6749: errors as 400 (401 for client auth) with `error`.
  if (status === 400 || status === 401) {
    if (kind === 'refresh') return { ok: false, code: 'credentials_rejected', cls: 'spent' }
    return { ok: false, code: json?.error === 'invalid_grant' ? 'connect_refused' : 'upstream_rejected', cls: 'spent' }
  }
  if (status < 200 || status > 299 || !json) return { ok: false, code: status >= 400 ? 'upstream_rejected' : 'upstream_unavailable', cls: 'unclear' }
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) return { ok: false, code: 'upstream_unavailable', cls: 'unclear' }
  if (typeof json.token_type !== 'string' || json.token_type.toLowerCase() !== 'bearer') return { ok: false, code: 'upstream_rejected', cls: 'unclear' }
  return tokensFrom(json.access_token, json.refresh_token, json.expires_in, splitScopes(json.scope, 'generic'), null)
}

function spentOrRefused(kind: 'code' | 'refresh'): TokenFail {
  return kind === 'refresh' ? { ok: false, code: 'credentials_rejected', cls: 'spent' } : { ok: false, code: 'upstream_rejected', cls: 'spent' }
}

function tokensFrom(access: string, refresh: unknown, expiresIn: unknown, scopes: string[] | null, teamId: string | null): TokenResult {
  const refreshToken = typeof refresh === 'string' && refresh.length > 0 ? refresh : null
  const expiresInS = typeof expiresIn === 'number' && Number.isSafeInteger(expiresIn) && expiresIn > 0 ? expiresIn : null
  // A refresh token without a lifetime, or a lifetime without a way to renew it, both still work: the token is used
  // until it expires (or forever), and a refresh token is kept for the 401 path.
  return { ok: true, tokens: { accessToken: access, refreshToken, expiresInS, scopes, teamId } }
}

/** The code exchange: 10 s, 64 KiB, no retry. */
export function exchangeCode(upstream: Upstream, c: McpConnectorModule, endpoints: Endpoints, client: ClientCreds, p: { code: string; verifier: string; redirectUri: string }): Promise<TokenResult> {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier })
  return tokenRequest(upstream, c, endpoints, client, form, 'code')
}

/** A refresh at the AS's token endpoint, classified (brief section 4). */
export function refreshTokens(upstream: Upstream, c: McpConnectorModule, endpoints: Endpoints, client: ClientCreds, refreshToken: string): Promise<TokenResult> {
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  return tokenRequest(upstream, c, endpoints, client, form, 'refresh')
}

/** Best-effort revoke. Slack: `auth.revoke` with the token as a bearer; generic: RFC 7009. True only on a clear yes. */
export async function revokeToken(upstream: Upstream, c: McpConnectorModule, endpoints: Endpoints, client: ClientCreds | null, token: string): Promise<boolean> {
  if (!endpoints.revoke) return false
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  const form = new URLSearchParams()
  if (c.profile === 'slack') headers.Authorization = `Bearer ${token}`
  else {
    form.set('token', token)
    form.set('token_type_hint', 'access_token')
    if (client) clientAuth(form, headers, client)
  }
  const sent = await send(upstream, endpoints.revoke, { method: 'POST', headers, body: form.toString() }, { allowedHosts: c.mcp.allowedHosts, timeoutMs: TOKEN_TIMEOUT_MS, maxBytes: TOKEN_MAX_BYTES })
  if (sent.kind !== 'response') return false
  if (c.profile === 'slack') return sent.status === 200 && jsonObject(sent.text)?.ok === true
  return sent.status === 200
}
