// Helpers for M4-F's fixture tests (Stage 1 M4-F, N52). Test-only: under hub/testing/, never in a deployable bundle.
import { authorizationServerOf, clientDocument, endpointBaseOf, FIXTURE_APP, FIXTURE_REDIRECT_URIS, issuerOf, pkcePair, type ProfileId, PROFILES, type ProfileSpec } from '../../../test/upstreams/mcp/as'
import { createMcpFixtures, type McpFixtures } from '../../../test/upstreams/mcp/index'
import { modernRequest } from '../../../test/upstreams/mcp/modern'
import { HOSTS } from '../../../test/upstreams/mcp/wire'

export const MODERN = `https://${HOSTS.modern}`
export const LEGACY = `https://${HOSTS.legacy}`
export const HELPDESK = `https://${HOSTS.helpdesk}`
export const LOGIN = `https://${HOSTS.login}`
export const LOGIN_FOREIGN = `https://${HOSTS.loginForeign}`

/** The Client ID Metadata Document URL the tests use (the product's `/oauth/client.json`, N40). */
export const CLIENT_DOC_URL = 'https://brand.example.com/oauth/client.json'

/** A fresh fixture set whose login server serves our Client ID Metadata Document (and nothing else). */
export function fixtures(): McpFixtures {
  const fx = createMcpFixtures()
  fx.as.fetchClientDocument = async req => (req.url === CLIENT_DOC_URL ? Response.json(clientDocument(CLIENT_DOC_URL)) : new Response('no such document', { status: 404 }))
  return fx
}

/** The JSON-RPC message an answer carries (JSON, or the last SSE `data:` line). */
export async function rpcOf(res: Response): Promise<{ id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string; data?: Record<string, unknown> } }> {
  const ct = res.headers.get('Content-Type') ?? ''
  const text = await res.text()
  if (ct.includes('text/event-stream')) {
    const data = text.split('\n').filter(l => l.startsWith('data: ') && l.length > 6)
    return JSON.parse(data[data.length - 1]!.slice(6))
  }
  return JSON.parse(text)
}

let nextId = 100
/** A conforming modern request through the fixtures. */
export function modern(fx: McpFixtures, url: string, method: string, params: Record<string, unknown> = {}, opts: { headers?: Record<string, string>; capabilities?: Record<string, unknown>; id?: number } = {}): Promise<Response> {
  return fx.fetch(modernRequest(url, opts.id ?? ++nextId, method, params, opts))
}

/** Every tool an endpoint lists, following `nextCursor`. */
export async function listAll(fx: McpFixtures, url: string, headers: Record<string, string> = {}): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]> {
  const out: { name: string; description: string; inputSchema: Record<string, unknown> }[] = []
  let cursor: string | undefined
  do {
    const r = await rpcOf(await modern(fx, url, 'tools/list', cursor ? { cursor } : {}, { headers }))
    out.push(...(r.result!.tools as typeof out))
    cursor = r.result!.nextCursor as string | undefined
  } while (cursor)
  return out
}

export type SignedIn = { access: string; refresh: string; tokenAnswer: Record<string, unknown>; callback: URL; issuer: string }

/**
 * A whole sign-in at one profile, the way basic/authorization's flow lays it out: authorize (PKCE S256, `resource`,
 * state), the redirect back, then the code exchange. `client` picks the client: our ID document (public) or the
 * pre-registered app (Basic). Throws if any step doesn't answer as a clean sign-in would.
 */
export async function signIn(fx: McpFixtures, profile: ProfileId, opts: { resource?: string | null; client?: 'cimd' | 'app'; secretIn?: 'basic' | 'body'; scope?: string } = {}): Promise<SignedIn> {
  const p: ProfileSpec = PROFILES[profile]
  const resource = opts.resource === undefined ? `${MODERN}/as/${profile}/mcp` : opts.resource
  const client = opts.client ?? (p.cimd ? 'cimd' : 'app')
  const clientId = client === 'cimd' ? CLIENT_DOC_URL : FIXTURE_APP.clientId
  const redirect = FIXTURE_REDIRECT_URIS[0]
  const { verifier, challenge } = await pkcePair(profile)
  const ep = endpointBaseOf(profile)
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: `st-${profile}`, scope: opts.scope ?? 'notes:read notes:write' })
  if (resource !== null) q.set('resource', resource)
  const auth = await fx.fetch(new Request(`${ep}/authorize?${q}`))
  if (auth.status !== 302) throw new Error(`authorize answered ${auth.status}: ${await auth.text()}`)
  const callback = new URL(auth.headers.get('Location')!)
  const code = callback.searchParams.get('code')
  if (!code) throw new Error(`no code: ${callback}`)
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier })
  if (resource !== null) form.set('resource', resource)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (client === 'cimd') form.set('client_id', clientId)
  else if ((opts.secretIn ?? 'basic') === 'basic') headers.Authorization = `Basic ${btoa(`${FIXTURE_APP.clientId}:${FIXTURE_APP.clientSecret}`)}`
  else {
    form.set('client_id', FIXTURE_APP.clientId)
    form.set('client_secret', FIXTURE_APP.clientSecret)
  }
  const tok = await fx.fetch(new Request(`${ep}/token`, { method: 'POST', headers, body: form }))
  const tokenAnswer = (await tok.json()) as Record<string, unknown>
  if (tok.status !== 200 || typeof tokenAnswer.access_token !== 'string') throw new Error(`token answered ${tok.status}: ${JSON.stringify(tokenAnswer)}`)
  return { access: tokenAnswer.access_token, refresh: tokenAnswer.refresh_token as string, tokenAnswer, callback, issuer: issuerOf(profile) }
}

/** A renewal at one profile with the pre-registered app (Basic, or the body for E12). */
export function refresh(fx: McpFixtures, profile: ProfileId, refreshToken: string, opts: { secretIn?: 'basic' | 'body'; client?: 'cimd' | 'app' } = {}): Promise<Response> {
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (opts.client === 'cimd') form.set('client_id', CLIENT_DOC_URL)
  else if ((opts.secretIn ?? 'basic') === 'basic') headers.Authorization = `Basic ${btoa(`${FIXTURE_APP.clientId}:${FIXTURE_APP.clientSecret}`)}`
  else {
    form.set('client_id', FIXTURE_APP.clientId)
    form.set('client_secret', FIXTURE_APP.clientSecret)
  }
  return fx.fetch(new Request(`${endpointBaseOf(profile)}/token`, { method: 'POST', headers, body: form }))
}

export { authorizationServerOf, issuerOf }
