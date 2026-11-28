// The fixture login server (Stage 1 M4-F, N52): one OAuth 2.1 authorization server on `login.mcp-fixtures.example.com`
// with one issuer per profile, `https://login.mcp-fixtures.example.com/<profile>`. A profile is a path, never a global
// flip, so a test picks its plant by the issuer it points at. Owners after M4-F: M4-O2, then M4-O3 (plan section 2).
//
// What it stands for (MCP 2026-07-28, read 2026-11-28):
// - basic/authorization "Authorization Flow Steps" and "Resource Parameter Implementation": PKCE S256, `resource` on
//   both requests, and an access token bound to that one resource (resource servers check the audience).
// - basic/authorization "Authorization Response Validation": `iss` on success and on error replies (RFC 9207), and
//   `authorization_response_iss_parameter_supported` advertised when it's sent. Plants cover each row of the table.
// - basic/authorization/authorization-server-discovery: RFC 8414 path insertion, then OpenID Connect insertion, then
//   appending, and the metadata's `issuer` equal to the issuer the address was built from.
// - basic/authorization/client-registration: a Client ID Metadata Document is really fetched (through
//   `fetchClientDocument`), its `client_id` must equal the URL exactly and the redirect URI must be listed in it;
//   Dynamic Client Registration (deprecated, kept for compatibility) needs an `application_type`; a pre-registered app
//   (the Inhouse team's) is known per issuer, so a client from one issuer isn't valid at another.
// - The connect plan's exceptions table (docs/plans/2026-11-26-connect-any-tool.md section 6.3, E1 to E12, per Executor
//   at d30f09c) and its flaws F1 to F4 (section 7): one profile per row (SIGNIN_VECTORS below).
//
// The "person" never sees a page: GET on the authorize endpoint approves at once and answers the redirect, so a test
// reads `Location`. Deterministic: ids from counters, time from the injected clock. Every value here is invented.

import { b64url, FIXTURE_EPOCH_MS, HOSTS, json, s256 } from './wire'

const LOGIN = `https://${HOSTS.login}`

/** Where the Inhouse team's (and a brand's) sign-in return lands in the test build. Invented. */
export const FIXTURE_REDIRECT_URIS = [
  'https://inhouse.example.com/api/connect/callback',
  'https://brand.example.com/api/connect/callback',
] as const

/** The app the Inhouse team "registered in the service's developer settings", known at every issuer. Invented. */
export const FIXTURE_APP = {
  clientId: 'fixture-app-0001',
  clientSecret: 'test-only-fixture-app-secret-6e0b',
} as const

export const FIXTURE_USER = 'fixture-user-0001'
/** E8: the tenant the connection names, and another one (the negative control's). */
export const E8_TENANT = '7f3c2a10-0000-4000-8000-00000000e801'
export const E8_OTHER_TENANT = '7f3c2a10-0000-4000-8000-00000000e802'

export const SCOPES = ['notes:read', 'notes:write'] as const

type AuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none'
type MetaAnswer = 'serve' | 'absent' | 'redirect' | 'unauthorized'

export type ProfileSpec = {
  /** Where the metadata lives: RFC 8414 insertion, OIDC insertion, OIDC appending (each its own answer). */
  meta: { oauth: MetaAnswer; oidcInsert: MetaAnswer; oidcAppend: MetaAnswer }
  cimd: boolean
  /** `register` offered; `refuses` offers it then answers every registration with an error. */
  registration: 'none' | 'offered' | 'refuses'
  authMethods: AuthMethod[]
  /** Advertised `authorization_response_iss_parameter_supported`. */
  issAdvertised: boolean
  /** What the redirect carries in `iss`. */
  issSent: 'match' | 'absent' | 'trailing-slash' | 'other-tenant'
  /** Every authorize ends in an `access_denied` error reply whose `iss` names another issuer. */
  errorWithWrongIss?: boolean
  /** `token_type` in a token answer: a value, or null to leave it out. */
  tokenType: string | null
  scopeAnswer: 'space' | 'comma' | 'null' | 'absent'
  /** E5: errors from the token endpoint come with status 200. */
  errorsWithOk?: boolean
  /** E6: our client refused with the service's own code, on the code exchange or on renewal. */
  clientFault?: 'code' | 'refresh'
  /** E7: how a renewal is refused. */
  renewal?: 'invalid_grant' | 'invalid_client' | 'unavailable' | 'rate_limited'
  /** E8: the issuer is published as `.../{tenantid}/v2.0` under this issuer path. */
  template?: boolean
  /** E9: `invalid_target` whenever `resource` is sent. */
  refusesResource?: boolean
  /** The issuer's path; defaults to the profile id. */
  issuerPath?: string
  /** The login host; defaults to `login.mcp-fixtures.example.com`. */
  host?: string
}

const base: ProfileSpec = {
  meta: { oauth: 'serve', oidcInsert: 'absent', oidcAppend: 'absent' },
  cimd: true,
  registration: 'offered',
  authMethods: ['client_secret_basic', 'client_secret_post', 'none'],
  issAdvertised: true,
  issSent: 'match',
  tokenType: 'Bearer',
  scopeAnswer: 'space',
}

/** Every profile, by id (its path). `std` is the clean one. */
export const PROFILES = {
  std: base,
  /** No Client ID Metadata Documents and no registration: only a pre-registered app works (detect's `signin_needs_app`). */
  noreg: { ...base, cimd: false, registration: 'none' },
  /** Registration only (no Client ID Metadata Documents). */
  'reg-only': { ...base, cimd: false },
  /** Registration offered, then refused: falls through to the pre-registered app (N40). */
  'reg-refused': { ...base, cimd: false, registration: 'refuses' },
  /** OpenID Connect discovery only (insertion), no RFC 8414 document. */
  oidc: { ...base, meta: { oauth: 'absent', oidcInsert: 'serve', oidcAppend: 'absent' } },
  // ---- the iss table (basic/authorization "Authorization Response Validation") ----
  /** Row 2: advertised, absent: the client must reject. */
  'iss-absent': { ...base, issSent: 'absent' },
  /** Row 4: not advertised, absent: proceed. */
  'iss-quiet': { ...base, issAdvertised: false, issSent: 'absent' },
  /** Error reply whose `iss` doesn't match: nothing in it may be shown or used. */
  'iss-error-mismatch': { ...base, errorWithWrongIss: true },
  // ---- E1 to E12 ----
  e1: { ...base, tokenType: null },
  e2: { ...base, tokenType: 'bot' },
  'e2-dpop': { ...base, tokenType: 'DPoP' },
  'e3-null': { ...base, scopeAnswer: 'null' },
  'e3-absent': { ...base, scopeAnswer: 'absent' },
  e4: { ...base, scopeAnswer: 'comma' },
  e5: { ...base, errorsWithOk: true, renewal: 'invalid_grant' },
  'e6-code': { ...base, clientFault: 'code' },
  'e6-refresh': { ...base, clientFault: 'refresh' },
  'e7-grant': { ...base, renewal: 'invalid_grant' },
  'e7-client': { ...base, renewal: 'invalid_client' },
  'e7-unavailable': { ...base, renewal: 'unavailable' },
  'e7-rate-limited': { ...base, renewal: 'rate_limited' },
  e8: { ...base, template: true, issuerPath: 'e8/common/v2.0', meta: { oauth: 'absent', oidcInsert: 'absent', oidcAppend: 'serve' } },
  /** E8's negative control: the sign-in comes back from another tenant. */
  'e8-other': { ...base, template: true, issuerPath: 'e8-other/common/v2.0', issSent: 'other-tenant', meta: { oauth: 'absent', oidcInsert: 'absent', oidcAppend: 'serve' } },
  /** E8's other negative control: a template from a server (another origin) no named profile pins. */
  'e8-foreign': { ...base, template: true, host: HOSTS.loginForeign, issuerPath: 'e8-foreign/common/v2.0', meta: { oauth: 'absent', oidcInsert: 'absent', oidcAppend: 'serve' } },
  e9: { ...base, refusesResource: true },
  /** E10 (Apple): the RFC 8414 address redirects (to another issuer's document); OIDC insertion serves the real one. */
  'e10-redirect': { ...base, meta: { oauth: 'redirect', oidcInsert: 'serve', oidcAppend: 'absent' } },
  /** E10 (Atlassian): the RFC 8414 address answers 401; OIDC insertion serves the real one. */
  'e10-401': { ...base, meta: { oauth: 'unauthorized', oidcInsert: 'serve', oidcAppend: 'absent' } },
  /** E11 (Google): `iss` sent but not advertised, and not byte-equal to the issuer (a trailing slash). */
  e11: { ...base, issAdvertised: false, issSent: 'trailing-slash' },
  /** E11's control: sent, not advertised, equal (row 3 of the table: compare, it matches). */
  'e11-match': { ...base, issAdvertised: false, issSent: 'match' },
  /** E12 (HubSpot): the client secret only from the body. No ID documents and no public clients, so a client must send it. */
  e12: { ...base, cimd: false, authMethods: ['client_secret_post'] },
} satisfies Record<string, ProfileSpec>

export type ProfileId = keyof typeof PROFILES
export const PROFILE_IDS = Object.keys(PROFILES) as ProfileId[]
const profileOf = (id: string): ProfileSpec | undefined => (PROFILES as Record<string, ProfileSpec>)[id]

/** One row per exception or flaw: the profile that plants it, and the reaction the connect plan's table asks for. */
export const SIGNIN_VECTORS: readonly { rows: string[]; profile: ProfileId; plant: string; reaction: string }[] = [
  { rows: ['E1', 'F1'], profile: 'e1', plant: 'token answer has no token_type', reaction: 'treat it as Bearer' },
  { rows: ['E2', 'F1'], profile: 'e2', plant: 'token_type is "bot"', reaction: 'accept any type except DPoP' },
  { rows: ['E2'], profile: 'e2-dpop', plant: 'token_type is "DPoP"', reaction: 'refuse: we never send DPoP proofs' },
  { rows: ['E3', 'F4'], profile: 'e3-null', plant: 'scope is null (code and renewal)', reaction: 'granted what was asked; on renewal, what it held' },
  { rows: ['E3', 'F4'], profile: 'e3-absent', plant: 'scope left out (code and renewal)', reaction: 'granted what was asked; on renewal, what it held' },
  { rows: ['E4', 'F4'], profile: 'e4', plant: 'scope is comma-separated', reaction: 'split on the comma' },
  { rows: ['E5', 'F3'], profile: 'e5', plant: 'token endpoint errors come with status 200', reaction: "read the answer's error whatever the status" },
  { rows: ['E6', 'F2'], profile: 'e6-code', plant: '401 incorrect_client_credentials on the code exchange', reaction: "a client fault, not the account's" },
  { rows: ['E6', 'F2'], profile: 'e6-refresh', plant: '401 incorrect_client_credentials on renewal', reaction: 'client fault: keep the login, report client_fault' },
  { rows: ['E7', 'F2'], profile: 'e7-grant', plant: 'renewal refused invalid_grant', reaction: 'the grant is over: Reconnect' },
  { rows: ['E7', 'F2'], profile: 'e7-client', plant: 'renewal refused invalid_client', reaction: 'client fault: keep the login, report client_fault' },
  { rows: ['E7', 'F2'], profile: 'e7-unavailable', plant: 'renewal answered 503 with Retry-After', reaction: 'temporary: retry later, keep the old credential' },
  { rows: ['E7', 'F2'], profile: 'e7-rate-limited', plant: 'renewal answered 429 slow_down with Retry-After', reaction: 'temporary: retry later, keep the old credential' },
  { rows: ['E8', 'F3'], profile: 'e8', plant: 'issuer published as .../{tenantid}/v2.0', reaction: "match the connection's tenant against the template, exactly" },
  { rows: ['E8'], profile: 'e8-other', plant: 'the callback comes back from another tenant', reaction: 'refuse' },
  { rows: ['E8'], profile: 'e8-foreign', plant: 'a template from another login origin no named profile pins', reaction: 'refuse' },
  { rows: ['E9'], profile: 'e9', plant: 'invalid_target whenever resource is sent', reaction: 'leave resource out only for the named profile' },
  { rows: ['E10'], profile: 'e10-redirect', plant: 'RFC 8414 address redirects to another issuer\'s document', reaction: 'never follow; try the next address in the spec order' },
  { rows: ['E10'], profile: 'e10-401', plant: 'RFC 8414 address answers 401', reaction: 'try the next address in the spec order' },
  { rows: ['E11'], profile: 'e11', plant: 'iss sent but not advertised, with a trailing slash', reaction: 'v1 compares a present iss exactly: refuse (section 0)' },
  { rows: ['E11'], profile: 'e11-match', plant: 'iss sent but not advertised, equal', reaction: 'compare, it matches: proceed' },
  { rows: ['E12'], profile: 'e12', plant: 'client secret read only from the body', reaction: 'use the body form when the server lists only that' },
]

type Client = { id: string; secret: string | null; redirectUris: string[]; authMethod: AuthMethod; kind: 'cimd' | 'registered' | 'preregistered'; applicationType?: string }
type CodeRecord = { profile: string; client: Client; redirectUri: string; challenge: string; scopes: string[]; resource: string | null; tenant: string; expiresAtMs: number; used: boolean }
export type TokenRecord = { profile: string; clientId: string; user: string; tenant: string; scopes: string[]; resource: string | null; expiresAtMs: number; revoked: boolean; refresh: string | null }
type RefreshRecord = { profile: string; client: Client; access: string; used: boolean; scopes: string[]; resource: string | null; tenant: string }

const originOf = (p: ProfileSpec): string => `https://${p.host ?? HOSTS.login}`

/** The issuer a profile's metadata names (the template itself for E8's profiles). */
export function issuerOf(profile: ProfileId): string {
  const p: ProfileSpec = PROFILES[profile]
  if (p.template) return `${originOf(p)}/${p.issuerPath!.split('/')[0]}/{tenantid}/v2.0`
  return `${originOf(p)}/${p.issuerPath ?? profile}`
}

/** Where a profile's authorize, token, register and revoke endpoints live (`<base>/authorize` and so on). */
export function endpointBaseOf(profile: ProfileId): string {
  return `${originOf(PROFILES[profile])}/${profile}`
}

/** The issuer a client records for a sign-in at this profile (E8: the template with the connection's tenant). */
export function recordedIssuerOf(profile: ProfileId, tenant = E8_TENANT): string {
  return issuerOf(profile).replace('{tenantid}', tenant)
}

/** What a protected resource's metadata names in `authorization_servers` (E8: the pinned discovery base). */
export function authorizationServerOf(profile: ProfileId): string {
  const p: ProfileSpec = PROFILES[profile]
  return `${originOf(p)}/${p.issuerPath ?? profile}`
}

export class FixtureLoginServer {
  now: () => number
  /** Fetches a Client ID Metadata Document. The seam wires it to the test upstreams; unset, every fetch fails. */
  fetchClientDocument: (req: Request) => Promise<Response> = async () => new Response('no client document fetcher', { status: 599 })
  /** Access token lifetime, seconds. */
  expiresInS = 3600
  // ---- logs (no secret values) ----
  clientDocFetches: { url: string; outcome: 'ok' | 'fetch_failed' | 'bad_document' | 'redirect_not_listed' }[] = []
  registrations: { profile: string; applicationType: string | null; outcome: 'created' | 'refused' }[] = []
  tokenRequests: { profile: string; grant: string; authMethod: AuthMethod | 'unknown'; resourceSent: boolean; outcome: string }[] = []
  revoked: string[] = []
  // ---- state ----
  clients = new Map<string, Map<string, Client>>()
  codes = new Map<string, CodeRecord>()
  tokens = new Map<string, TokenRecord>()
  refreshes = new Map<string, RefreshRecord>()
  #n = 0

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => FIXTURE_EPOCH_MS)
    this.reset()
  }

  /** Clears logs, codes, tokens and registered clients; the pre-registered app is known again at every issuer. */
  reset(): void {
    this.clientDocFetches = []
    this.registrations = []
    this.tokenRequests = []
    this.revoked = []
    this.codes.clear()
    this.tokens.clear()
    this.refreshes.clear()
    this.clients.clear()
    for (const id of PROFILE_IDS) this.registerApp(id, { id: FIXTURE_APP.clientId, secret: FIXTURE_APP.clientSecret, redirectUris: [...FIXTURE_REDIRECT_URIS] })
  }

  /** Registers an app at one issuer (what the Inhouse team does in a service's developer settings). */
  registerApp(profile: ProfileId, app: { id: string; secret: string; redirectUris: string[] }): void {
    const map = this.clients.get(profile) ?? new Map<string, Client>()
    map.set(app.id, { id: app.id, secret: app.secret, redirectUris: [...app.redirectUris], authMethod: 'client_secret_basic', kind: 'preregistered' })
    this.clients.set(profile, map)
  }

  /** The resource servers' token check: live, unexpired, unrevoked; `null` otherwise. */
  introspect(token: string): TokenRecord | null {
    const t = this.tokens.get(token)
    if (!t || t.revoked || this.now() >= t.expiresAtMs) return null
    return t
  }

  /** Revokes every token issued so far (a test's "the login was ended at the service"). */
  revokeAll(): void {
    for (const t of this.tokens.values()) t.revoked = true
  }

  #id(prefix: string): string {
    return `${prefix}${String(++this.#n).padStart(4, '0')}`
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const path = url.pathname
    // Discovery (authorization-server-discovery: RFC 8414 insertion, OIDC insertion, OIDC appending).
    if (req.method === 'GET') {
      let m = /^\/\.well-known\/oauth-authorization-server\/(.+)$/.exec(path)
      if (m) return this.#meta(url.host, m[1]!, 'oauth')
      m = /^\/\.well-known\/openid-configuration\/(.+)$/.exec(path)
      if (m) return this.#meta(url.host, m[1]!, 'oidcInsert')
      m = /^\/(.+)\/\.well-known\/openid-configuration$/.exec(path)
      if (m) return this.#meta(url.host, m[1]!, 'oidcAppend')
    }
    if (req.method === 'GET') {
      // OpenID Connect Discovery's `jwks_uri`: this fixture signs no ID tokens, so the set is empty.
      const jwks = /^\/([a-z0-9-]+)\/jwks\.json$/.exec(path)
      if (jwks && (profileOf(jwks[1]!)?.host ?? HOSTS.login) === url.host) return json({ keys: [] })
    }
    const m = /^\/([a-z0-9-]+)\/(authorize|token|register|revoke)$/.exec(path)
    const id = m?.[1]
    const found = id === undefined ? undefined : profileOf(id)
    // A profile answers only on its own login host.
    const profile = found && (found.host ?? HOSTS.login) === url.host ? found : undefined
    if (!m || !profile || id === undefined) return json({ error: 'not_found' }, 404)
    if (m[2] === 'authorize' && req.method === 'GET') return this.#authorize(id as ProfileId, profile, url)
    if (m[2] === 'token' && req.method === 'POST') return this.#token(id as ProfileId, profile, req)
    if (m[2] === 'register' && req.method === 'POST' && profile.registration !== 'none') return this.#register(id as ProfileId, profile, req)
    if (m[2] === 'revoke' && req.method === 'POST') return this.#revoke(req)
    return json({ error: 'not_found' }, 404)
  }

  // ---------- discovery ----------

  #meta(host: string, issuerPath: string, where: keyof ProfileSpec['meta']): Response {
    const id = PROFILE_IDS.find(p => {
      const spec: ProfileSpec = PROFILES[p]
      return (spec.host ?? HOSTS.login) === host && (spec.issuerPath === issuerPath || (spec.issuerPath === undefined && p === issuerPath))
    })
    if (!id) return json({ error: 'not_found' }, 404)
    const p: ProfileSpec = PROFILES[id]
    const answer = p.meta[where]
    if (answer === 'absent') return json({ error: 'not_found' }, 404)
    if (answer === 'unauthorized') return json({ error: 'unauthorized' }, 401)
    // E10 (Apple): a redirect, to another issuer's document. A client that follows it gets `std`'s issuer.
    if (answer === 'redirect') return new Response(null, { status: 302, headers: { Location: `${LOGIN}/.well-known/oauth-authorization-server/std` } })
    const ep = endpointBaseOf(id)
    const doc: Record<string, unknown> = {
      issuer: issuerOf(id),
      authorization_endpoint: `${ep}/authorize`,
      token_endpoint: `${ep}/token`,
      revocation_endpoint: `${ep}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: p.authMethods,
      scopes_supported: [...SCOPES],
    }
    if (p.registration !== 'none') doc.registration_endpoint = `${ep}/register`
    if (p.cimd) doc.client_id_metadata_document_supported = true
    if (p.issAdvertised) doc.authorization_response_iss_parameter_supported = true
    // OpenID Connect Discovery 1.0 section 3: an OpenID Provider's metadata also needs these (REQUIRED), and the official
    // client 2.4.0 parses every openid-configuration answer with a schema that requires them.
    if (where !== 'oauth') {
      doc.jwks_uri = `${ep}/jwks.json`
      doc.subject_types_supported = ['public']
      doc.id_token_signing_alg_values_supported = ['RS256']
    }
    return json(doc)
  }

  // ---------- registration (client-registration "Dynamic Client Registration", RFC 7591) ----------

  async #register(id: ProfileId, p: ProfileSpec, req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const applicationType = typeof body?.application_type === 'string' ? body.application_type : null
    const refuse = (error: string) => {
      this.registrations.push({ profile: id, applicationType, outcome: 'refused' })
      return json({ error }, 400)
    }
    if (p.registration === 'refuses') return refuse('invalid_client_metadata')
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
    if (uris.length === 0 || uris.some(u => !u.startsWith('https://'))) return refuse('invalid_redirect_uri')
    // The client MUST send `application_type`; a remote web client sends "web" (SEP-837). A native one with a remote
    // https return address is what an OIDC server refuses.
    if (applicationType === null) return refuse('invalid_client_metadata')
    if (applicationType === 'native') return refuse('invalid_redirect_uri')
    const requested = typeof body?.token_endpoint_auth_method === 'string' ? (body.token_endpoint_auth_method as AuthMethod) : 'client_secret_basic'
    const authMethod: AuthMethod = p.authMethods.includes(requested) ? requested : p.authMethods[0]!
    const client: Client = { id: this.#id(`${id}-client-`), secret: authMethod === 'none' ? null : this.#id('test-only-reg-secret-'), redirectUris: uris, authMethod, kind: 'registered', applicationType }
    const map = this.clients.get(id) ?? new Map<string, Client>()
    map.set(client.id, client)
    this.clients.set(id, map)
    this.registrations.push({ profile: id, applicationType, outcome: 'created' })
    return json({
      client_id: client.id,
      ...(client.secret !== null ? { client_secret: client.secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(this.now() / 1000),
      redirect_uris: uris,
      token_endpoint_auth_method: authMethod,
      application_type: applicationType,
    }, 201)
  }

  // ---------- authorize ----------

  /** A client by id at this issuer: a URL-shaped id is a Client ID Metadata Document, fetched now. */
  async #client(id: ProfileId, p: ProfileSpec, clientId: string, redirectUri: string): Promise<Client | null> {
    if (p.cimd && clientId.startsWith('https://')) {
      let res: Response
      try {
        res = await this.fetchClientDocument(new Request(clientId, { headers: { Accept: 'application/json' } }))
      } catch {
        this.clientDocFetches.push({ url: clientId, outcome: 'fetch_failed' })
        return null
      }
      if (res.status !== 200) {
        this.clientDocFetches.push({ url: clientId, outcome: 'fetch_failed' })
        return null
      }
      const doc = (await res.json().catch(() => null)) as Record<string, unknown> | null
      const uris = Array.isArray(doc?.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === 'string') : null
      // The document's client_id must equal the URL exactly; client_name and redirect_uris are required.
      if (!doc || doc.client_id !== clientId || typeof doc.client_name !== 'string' || !uris || uris.length === 0 || (doc.token_endpoint_auth_method ?? 'none') !== 'none') {
        this.clientDocFetches.push({ url: clientId, outcome: 'bad_document' })
        return null
      }
      if (!uris.includes(redirectUri)) {
        this.clientDocFetches.push({ url: clientId, outcome: 'redirect_not_listed' })
        return null
      }
      this.clientDocFetches.push({ url: clientId, outcome: 'ok' })
      return { id: clientId, secret: null, redirectUris: uris, authMethod: 'none', kind: 'cimd' }
    }
    return this.clients.get(id)?.get(clientId) ?? null
  }

  async #authorize(id: ProfileId, p: ProfileSpec, url: URL): Promise<Response> {
    const q = url.searchParams
    const clientId = q.get('client_id') ?? ''
    const redirectUri = q.get('redirect_uri') ?? ''
    const client = await this.#client(id, p, clientId, redirectUri)
    // An unknown client or an unlisted return address is never redirected to (OAuth 2.1 section 4.1.2.1).
    if (!client) return json({ error: 'invalid_client' }, 400)
    if (!client.redirectUris.includes(redirectUri)) return json({ error: 'invalid_request', error_description: 'redirect_uri' }, 400)
    const tenant = p.issSent === 'other-tenant' ? E8_OTHER_TENANT : E8_TENANT
    const recorded = recordedIssuerOf(id, tenant)
    const back = (params: Record<string, string>, iss: string | null) => {
      const cb = new URL(redirectUri)
      for (const [k, v] of Object.entries(params)) cb.searchParams.set(k, v)
      if (q.get('state') !== null) cb.searchParams.set('state', q.get('state')!)
      if (iss !== null) cb.searchParams.set('iss', iss)
      return new Response(null, { status: 302, headers: { Location: cb.toString() } })
    }
    const issFor = (): string | null => {
      switch (p.issSent) {
        case 'absent':
          return null
        case 'trailing-slash':
          return `${recorded}/`
        default:
          return recorded
      }
    }
    if (p.errorWithWrongIss) return back({ error: 'access_denied', error_description: 'UPSTREAM TEXT: do not show this' }, `${LOGIN}/std`)
    if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' }, issFor())
    if (!q.get('code_challenge') || q.get('code_challenge_method') !== 'S256') return back({ error: 'invalid_request', error_description: 'PKCE S256 required' }, issFor())
    const resource = q.get('resource')
    if (p.refusesResource && resource !== null) return back({ error: 'invalid_target' }, issFor())
    const scopes = (q.get('scope') ?? '').split(' ').filter(s => s.length > 0)
    const code = this.#id('fixture-code-')
    this.codes.set(code, { profile: id, client, redirectUri, challenge: q.get('code_challenge')!, scopes, resource, tenant, expiresAtMs: this.now() + 10 * 60_000, used: false })
    return back({ code }, issFor())
  }

  // ---------- token ----------

  #tokenError(p: ProfileSpec, status: number, error: string, headers: Record<string, string> = {}): Response {
    return json({ error }, p.errorsWithOk ? 200 : status, headers)
  }

  async #token(id: ProfileId, p: ProfileSpec, req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text())
    const grant = form.get('grant_type') ?? ''
    const resourceSent = form.get('resource') !== null
    let authMethod: AuthMethod | 'unknown' = 'unknown'
    const log = (outcome: string) => this.tokenRequests.push({ profile: id, grant, authMethod, resourceSent, outcome })
    // Client authentication: Basic (RFC 6749 section 2.3.1, form-encoded parts), the body, or none (a public client).
    let clientId = form.get('client_id')
    let secret: string | null = form.get('client_secret')
    const basic = /^Basic (.+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1]
    if (basic) {
      authMethod = 'client_secret_basic'
      const decoded = (() => {
        try {
          return atob(basic)
        } catch {
          return ''
        }
      })()
      const i = decoded.indexOf(':')
      const parts = (() => {
        try {
          return i < 0 ? null : [decodeURIComponent(decoded.slice(0, i)), decodeURIComponent(decoded.slice(i + 1))]
        } catch {
          return null
        }
      })()
      // A malformed credential (no colon, a bad percent escape) is a failed client authentication, never a throw.
      if (parts === null) {
        log('invalid_client')
        return this.#tokenError(p, 401, 'invalid_client')
      }
      clientId = parts[0]!
      secret = parts[1]!
    } else authMethod = secret !== null ? 'client_secret_post' : 'none'
    if (!p.authMethods.includes(authMethod)) {
      log('invalid_client')
      return this.#tokenError(p, 401, 'invalid_client')
    }
    const known = clientId === null ? undefined : this.clients.get(id)?.get(clientId)
    // A Client ID Metadata Document client is public here (`none`): it sends no secret.
    const isUrlClient = clientId !== null && clientId.startsWith('https://') && p.cimd && authMethod === 'none'
    if (!isUrlClient && (!known || known.secret !== secret)) {
      log('invalid_client')
      return this.#tokenError(p, 401, 'invalid_client')
    }
    if (p.refusesResource && resourceSent) {
      log('invalid_target')
      return this.#tokenError(p, 400, 'invalid_target')
    }
    if (grant === 'authorization_code') return this.#codeGrant(id, p, form, clientId!, log)
    if (grant === 'refresh_token') return this.#refreshGrant(id, p, form, clientId!, log)
    log('unsupported_grant_type')
    return this.#tokenError(p, 400, 'unsupported_grant_type')
  }

  async #codeGrant(id: ProfileId, p: ProfileSpec, form: URLSearchParams, clientId: string, log: (o: string) => void): Promise<Response> {
    if (p.clientFault === 'code') {
      log('incorrect_client_credentials')
      return this.#tokenError(p, 401, 'incorrect_client_credentials')
    }
    const code = form.get('code') ?? ''
    const c = this.codes.get(code)
    const bad = (error: string, status = 400) => {
      log(error)
      return this.#tokenError(p, status, error)
    }
    if (!c || c.used || c.profile !== id || this.now() >= c.expiresAtMs) return bad('invalid_grant')
    if (c.client.id !== clientId) return bad('invalid_grant')
    if (c.redirectUri !== form.get('redirect_uri')) return bad('invalid_grant')
    if ((await s256(form.get('code_verifier') ?? '')) !== c.challenge) return bad('invalid_grant')
    // RFC 8707: the token request names the same resource the authorization request did.
    if (c.resource !== form.get('resource')) return bad('invalid_target')
    c.used = true
    const access = this.#issue(id, c.client, c.scopes, c.resource, c.tenant)
    log('ok')
    return this.#tokenAnswer(p, access, c.scopes)
  }

  async #refreshGrant(id: ProfileId, p: ProfileSpec, form: URLSearchParams, clientId: string, log: (o: string) => void): Promise<Response> {
    if (p.clientFault === 'refresh') {
      log('incorrect_client_credentials')
      return this.#tokenError(p, 401, 'incorrect_client_credentials')
    }
    switch (p.renewal) {
      case 'invalid_grant':
        log('invalid_grant')
        return this.#tokenError(p, 400, 'invalid_grant')
      case 'invalid_client':
        log('invalid_client')
        return this.#tokenError(p, 401, 'invalid_client')
      case 'unavailable':
        log('temporarily_unavailable')
        return this.#tokenError(p, 503, 'temporarily_unavailable', { 'Retry-After': '30' })
      case 'rate_limited':
        log('slow_down')
        return this.#tokenError(p, 429, 'slow_down', { 'Retry-After': '30' })
    }
    const r = this.refreshes.get(form.get('refresh_token') ?? '')
    if (!r || r.used || r.profile !== id || r.client.id !== clientId) {
      log('invalid_grant')
      return this.#tokenError(p, 400, 'invalid_grant')
    }
    if (form.get('resource') !== null && form.get('resource') !== r.resource) {
      log('invalid_target')
      return this.#tokenError(p, 400, 'invalid_target')
    }
    r.used = true
    const access = this.#issue(id, r.client, r.scopes, r.resource, r.tenant)
    log('ok')
    return this.#tokenAnswer(p, access, r.scopes)
  }

  #issue(profile: string, client: Client, scopes: string[], resource: string | null, tenant: string): string {
    const access = this.#id(`fixture-at-${profile}-`)
    const refresh = this.#id(`fixture-rt-${profile}-`)
    this.tokens.set(access, { profile, clientId: client.id, user: FIXTURE_USER, tenant, scopes: [...scopes], resource, expiresAtMs: this.now() + this.expiresInS * 1000, revoked: false, refresh })
    this.refreshes.set(refresh, { profile, client, access, used: false, scopes: [...scopes], resource, tenant })
    return access
  }

  #tokenAnswer(p: ProfileSpec, access: string, scopes: string[]): Response {
    const t = this.tokens.get(access)!
    const body: Record<string, unknown> = { access_token: access, expires_in: this.expiresInS, refresh_token: t.refresh }
    if (p.tokenType !== null) body.token_type = p.tokenType
    if (p.scopeAnswer === 'space') body.scope = scopes.join(' ')
    else if (p.scopeAnswer === 'comma') body.scope = scopes.join(',')
    else if (p.scopeAnswer === 'null') body.scope = null
    return json(body, 200, { 'Cache-Control': 'no-store' })
  }

  async #revoke(req: Request): Promise<Response> {
    const token = new URLSearchParams(await req.text()).get('token') ?? ''
    const t = this.tokens.get(token)
    if (t) t.revoked = true
    const r = this.refreshes.get(token)
    if (r) {
      r.used = true
      const a = this.tokens.get(r.access)
      if (a) a.revoked = true
    }
    this.revoked.push(token)
    return new Response(null, { status: 200 })
  }
}

/** A Client ID Metadata Document as the product's `GET /oauth/client.json` serves it (N40), for tests that serve one. */
export function clientDocument(clientId: string, redirectUris: readonly string[] = FIXTURE_REDIRECT_URIS): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: 'Inhouse',
    redirect_uris: [...redirectUris],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

/** A PKCE pair for tests (deterministic, from a seed). */
export async function pkcePair(seed = 'fixture'): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(new TextEncoder().encode(`${seed}-verifier-${'x'.repeat(43)}`)).slice(0, 64)
  return { verifier, challenge: await s256(verifier) }
}
