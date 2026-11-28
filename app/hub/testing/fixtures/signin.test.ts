// The login fixture (app/test/upstreams/mcp/as.ts): a clean sign-in round trip as basic/authorization (2026-07-28)
// lays it out, the client sources (client-registration), the `iss` table, and one plant per row of E1 to E12 and F1 to
// F4 (the connect plan's sections 6.3 and 7). The fixture only plants; how the hub reacts is M4-O1a's, M4-O2's and
// M4-O3's to prove.
import { beforeEach, describe, expect, it } from 'vitest'
import { E8_OTHER_TENANT, E8_TENANT, FIXTURE_APP, FIXTURE_REDIRECT_URIS, issuerOf, pkcePair, PROFILES, recordedIssuerOf, SIGNIN_VECTORS, type ProfileId } from '../../../test/upstreams/mcp/as'
import type { McpFixtures } from '../../../test/upstreams/mcp/index'
import { CLIENT_DOC_URL, fixtures, LOGIN, modern, MODERN, refresh, rpcOf, signIn } from './kit'

let fx: McpFixtures
beforeEach(() => {
  fx = fixtures()
})

const meta = async (url: string) => fx.fetch(new Request(url))

describe('a clean sign-in round trip (basic/authorization "Authorization Flow Steps")', () => {
  it('401, resource metadata, login metadata, our ID document fetched, the code with state and iss, the token, then the call', async () => {
    // 1. The MCP request without a token: 401 and where the metadata is.
    const first = await modern(fx, `${MODERN}/mcp`, 'tools/list')
    expect(first.status).toBe(401)
    const prmUrl = /resource_metadata="([^"]+)"/.exec(first.headers.get('WWW-Authenticate')!)![1]!
    // 2. The protected resource metadata names the resource (our endpoint) and one login server.
    const prm = (await (await meta(prmUrl)).json()) as { resource: string; authorization_servers: string[] }
    expect(prm.resource).toBe(`${MODERN}/mcp`)
    // 3. RFC 8414 path insertion for an issuer with a path; the document's issuer equals the one the address was built from.
    const issuer = prm.authorization_servers[0]!
    const asUrl = new URL(issuer)
    const doc = (await (await meta(`${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname}`)).json()) as Record<string, unknown>
    expect(doc).toMatchObject({ issuer, client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true, code_challenge_methods_supported: ['S256'] })
    // 4. Authorize with our ID document as the client: the login server really fetches it and checks it.
    const { verifier, challenge } = await pkcePair('round-trip')
    const redirect = FIXTURE_REDIRECT_URIS[0]
    const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT_DOC_URL, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', scope: 'notes:read', resource: prm.resource })
    const back = await fx.fetch(new Request(`${doc.authorization_endpoint}?${q}`))
    expect(back.status).toBe(302)
    expect(fx.as.clientDocFetches).toEqual([{ url: CLIENT_DOC_URL, outcome: 'ok' }])
    const cb = new URL(back.headers.get('Location')!)
    expect(`${cb.origin}${cb.pathname}`).toBe(redirect)
    expect(cb.searchParams.get('state')).toBe('st-1')
    // RFC 9207: iss present, byte-equal to the recorded issuer.
    expect(cb.searchParams.get('iss')).toBe(issuer)
    // 5. The code exchange: PKCE verifier and the same resource.
    const tok = await fx.fetch(new Request(doc.token_endpoint as string, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code')!, redirect_uri: redirect, code_verifier: verifier, client_id: CLIENT_DOC_URL, resource: prm.resource }) }))
    expect(tok.status).toBe(200)
    expect(tok.headers.get('Cache-Control')).toBe('no-store')
    const t = (await tok.json()) as { access_token: string; token_type: string; scope: string; refresh_token: string }
    expect(t).toMatchObject({ token_type: 'Bearer', scope: 'notes:read' })
    // 6. The MCP request with the token works.
    const list = await modern(fx, `${MODERN}/mcp`, 'tools/list', {}, { headers: { Authorization: `Bearer ${t.access_token}` } })
    expect(list.status).toBe(200)
    expect((await rpcOf(list)).result!.cacheScope).toBe('private')
    // The code is single use (OAuth 2.1 section 4.1.3).
    const again = await fx.fetch(new Request(doc.token_endpoint as string, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code')!, redirect_uri: redirect, code_verifier: verifier, client_id: CLIENT_DOC_URL, resource: prm.resource }) }))
    expect(again.status).toBe(400)
    // The log never carried the token's value, only its kind.
    expect(JSON.stringify(fx.log.entries)).not.toContain(t.access_token)
    expect(fx.log.entries.at(-2)).toMatchObject({ path: '/mcp', credential: 'bearer', status: 200 })
  })

  it('a wrong verifier, another resource or a wrong return address is refused at the exchange; renewal rotates', async () => {
    const s = await signIn(fx, 'std', { client: 'app' })
    const r1 = await refresh(fx, 'std', s.refresh)
    expect(r1.status).toBe(200)
    // The spent refresh token can't be used again.
    expect((await refresh(fx, 'std', s.refresh)).status).toBe(400)
    const { challenge } = await pkcePair('x')
    const q = new URLSearchParams({ response_type: 'code', client_id: FIXTURE_APP.clientId, redirect_uri: FIXTURE_REDIRECT_URIS[0], code_challenge: challenge, code_challenge_method: 'S256', resource: `${MODERN}/as/std/mcp` })
    const code = new URL((await fx.fetch(new Request(`${LOGIN}/std/authorize?${q}`))).headers.get('Location')!).searchParams.get('code')!
    const basic = `Basic ${btoa(`${FIXTURE_APP.clientId}:${FIXTURE_APP.clientSecret}`)}`
    const exchange = (body: Record<string, string>) => fx.fetch(new Request(`${LOGIN}/std/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic }, body: new URLSearchParams({ grant_type: 'authorization_code', code, ...body }) }))
    const { verifier } = await pkcePair('x')
    expect(await (await exchange({ redirect_uri: FIXTURE_REDIRECT_URIS[0], code_verifier: 'wrong-verifier-0000000000000000000000000000000', resource: `${MODERN}/as/std/mcp` })).json()).toEqual({ error: 'invalid_grant' })
    expect(await (await exchange({ redirect_uri: FIXTURE_REDIRECT_URIS[0], code_verifier: verifier, resource: `${MODERN}/mcp` })).json()).toEqual({ error: 'invalid_target' })
    expect(await (await exchange({ redirect_uri: FIXTURE_REDIRECT_URIS[1], code_verifier: verifier, resource: `${MODERN}/as/std/mcp` })).json()).toEqual({ error: 'invalid_grant' })
    // Control: the right three together work.
    expect((await exchange({ redirect_uri: FIXTURE_REDIRECT_URIS[0], code_verifier: verifier, resource: `${MODERN}/as/std/mcp` })).status).toBe(200)
  })
})

describe('where the client comes from (client-registration 2026-07-28)', () => {
  it("the ID document is refused when the fetch fails, its client_id differs, or it doesn't list the return address; never redirected to", async () => {
    const { challenge } = await pkcePair('cimd')
    const go = (clientId: string, redirect: string = FIXTURE_REDIRECT_URIS[0]) => fx.fetch(new Request(`${LOGIN}/std/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256' })}`))
    const missing = await go('https://brand.example.com/oauth/missing.json')
    expect(missing.status).toBe(400)
    expect(missing.headers.get('Location')).toBeNull()
    fx.as.fetchClientDocument = async () => Response.json({ client_id: 'https://elsewhere.example.com/client.json', client_name: 'x', redirect_uris: [...FIXTURE_REDIRECT_URIS] })
    expect((await go(CLIENT_DOC_URL)).status).toBe(400)
    fx.as.fetchClientDocument = async req => Response.json({ client_id: req.url, client_name: 'Inhouse', redirect_uris: ['https://other.example.com/cb'] })
    expect((await go(CLIENT_DOC_URL)).status).toBe(400)
    expect(fx.as.clientDocFetches.map(f => f.outcome)).toEqual(['fetch_failed', 'bad_document', 'redirect_not_listed'])
  })

  it('registration needs application_type ("web" works, "native" with an https return address is refused); "reg-refused" refuses all; "noreg" offers neither', async () => {
    const reg = (profile: string, body: Record<string, unknown>) => fx.fetch(new Request(`${LOGIN}/${profile}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
    expect((await reg('reg-only', { redirect_uris: [...FIXTURE_REDIRECT_URIS] })).status).toBe(400)
    expect((await reg('reg-only', { redirect_uris: [...FIXTURE_REDIRECT_URIS], application_type: 'native' })).status).toBe(400)
    const ok = await reg('reg-only', { redirect_uris: [...FIXTURE_REDIRECT_URIS], application_type: 'web', client_name: 'Inhouse' })
    expect(ok.status).toBe(201)
    expect(await ok.json()).toMatchObject({ client_id: expect.stringMatching(/^reg-only-client-/), client_secret: expect.any(String), application_type: 'web' })
    expect((await reg('reg-refused', { redirect_uris: [...FIXTURE_REDIRECT_URIS], application_type: 'web' })).status).toBe(400)
    // Falls through to the pre-registered app, which works at that issuer.
    await expect(signIn(fx, 'reg-refused', { client: 'app' })).resolves.toMatchObject({ access: expect.any(String) })
    const noreg = (await (await meta(`${LOGIN}/.well-known/oauth-authorization-server/noreg`)).json()) as Record<string, unknown>
    expect(noreg.registration_endpoint).toBeUndefined()
    expect(noreg.client_id_metadata_document_supported).toBeUndefined()
    expect((await reg('noreg', { redirect_uris: [...FIXTURE_REDIRECT_URIS], application_type: 'web' })).status).toBe(404)
  })

  it("a client from one issuer isn't valid at another (\"Authorization Server Binding\")", async () => {
    const created = (await (await fx.fetch(new Request(`${LOGIN}/reg-only/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [...FIXTURE_REDIRECT_URIS], application_type: 'web' }) }))).json()) as { client_id: string }
    const { challenge } = await pkcePair('bind')
    const elsewhere = await fx.fetch(new Request(`${LOGIN}/std/authorize?${new URLSearchParams({ response_type: 'code', client_id: created.client_id, redirect_uri: FIXTURE_REDIRECT_URIS[0], code_challenge: challenge, code_challenge_method: 'S256' })}`))
    expect(elsewhere.status).toBe(400)
  })
})

describe('the iss table (basic/authorization "Authorization Response Validation", RFC 9207)', () => {
  const issOf = async (profile: ProfileId) => {
    const { challenge } = await pkcePair(profile)
    const res = await fx.fetch(new Request(`${LOGIN}/${profile.split('/')[0]}/authorize?${new URLSearchParams({ response_type: 'code', client_id: FIXTURE_APP.clientId, redirect_uri: FIXTURE_REDIRECT_URIS[0], code_challenge: challenge, code_challenge_method: 'S256', state: 's' })}`))
    expect(res.status).toBe(302)
    return new URL(res.headers.get('Location')!).searchParams
  }
  const advertised = async (profile: ProfileId) => {
    const doc = (await (await meta(`${LOGIN}/.well-known/oauth-authorization-server/${profile}`)).json()) as Record<string, unknown>
    return doc.authorization_response_iss_parameter_supported === true
  }

  it('row 1: advertised and present, equal (std); row 2: advertised, absent (iss-absent); row 4: neither (iss-quiet)', async () => {
    expect([await advertised('std'), (await issOf('std')).get('iss')]).toEqual([true, issuerOf('std')])
    expect([await advertised('iss-absent'), (await issOf('iss-absent')).get('iss')]).toEqual([true, null])
    expect([await advertised('iss-quiet'), (await issOf('iss-quiet')).get('iss')]).toEqual([false, null])
  })

  it('row 3: not advertised but present: e11 sends it with a trailing slash (not byte-equal), e11-match sends it equal', async () => {
    expect([await advertised('e11'), (await issOf('e11')).get('iss')]).toEqual([false, `${issuerOf('e11')}/`])
    expect([await advertised('e11-match'), (await issOf('e11-match')).get('iss')]).toEqual([false, issuerOf('e11-match')])
  })

  it('an error reply carries an iss that names another issuer (iss-error-mismatch): its error must not be shown or used', async () => {
    const p = await issOf('iss-error-mismatch')
    expect(p.get('error')).toBe('access_denied')
    expect(p.get('code')).toBeNull()
    expect(p.get('iss')).toBe(issuerOf('std'))
    expect(p.get('iss')).not.toBe(issuerOf('iss-error-mismatch'))
  })
})

/** One check per profile in SIGNIN_VECTORS: that the plant is on the wire as its row describes. */
const PLANT_CHECKS: Partial<Record<ProfileId, () => Promise<void>>> = {
  e1: async () => {
    expect((await signIn(fx, 'e1')).tokenAnswer.token_type).toBeUndefined()
  },
  e2: async () => {
    expect((await signIn(fx, 'e2')).tokenAnswer.token_type).toBe('bot')
  },
  'e2-dpop': async () => {
    expect((await signIn(fx, 'e2-dpop')).tokenAnswer.token_type).toBe('DPoP')
  },
  'e3-null': async () => {
    const s = await signIn(fx, 'e3-null', { client: 'app' })
    expect(s.tokenAnswer).toHaveProperty('scope', null)
    expect(await (await refresh(fx, 'e3-null', s.refresh)).json()).toHaveProperty('scope', null)
  },
  'e3-absent': async () => {
    const s = await signIn(fx, 'e3-absent', { client: 'app' })
    expect(s.tokenAnswer).not.toHaveProperty('scope')
    expect(await (await refresh(fx, 'e3-absent', s.refresh)).json()).not.toHaveProperty('scope')
  },
  e4: async () => {
    expect((await signIn(fx, 'e4')).tokenAnswer.scope).toBe('notes:read,notes:write')
  },
  e5: async () => {
    const s = await signIn(fx, 'e5', { client: 'app' })
    const r = await refresh(fx, 'e5', s.refresh)
    expect([r.status, await r.json()]).toEqual([200, { error: 'invalid_grant' }])
  },
  'e6-code': async () => {
    await expect(signIn(fx, 'e6-code', { client: 'app' })).rejects.toThrow(/token answered 401: {"error":"incorrect_client_credentials"}/)
  },
  'e6-refresh': async () => {
    const s = await signIn(fx, 'e6-refresh', { client: 'app' })
    const r = await refresh(fx, 'e6-refresh', s.refresh)
    expect([r.status, await r.json()]).toEqual([401, { error: 'incorrect_client_credentials' }])
  },
  'e7-grant': async () => {
    const r = await refresh(fx, 'e7-grant', (await signIn(fx, 'e7-grant', { client: 'app' })).refresh)
    expect([r.status, await r.json()]).toEqual([400, { error: 'invalid_grant' }])
  },
  'e7-client': async () => {
    const r = await refresh(fx, 'e7-client', (await signIn(fx, 'e7-client', { client: 'app' })).refresh)
    expect([r.status, await r.json()]).toEqual([401, { error: 'invalid_client' }])
  },
  'e7-unavailable': async () => {
    const r = await refresh(fx, 'e7-unavailable', (await signIn(fx, 'e7-unavailable', { client: 'app' })).refresh)
    expect([r.status, r.headers.get('Retry-After')]).toEqual([503, '30'])
  },
  'e7-rate-limited': async () => {
    const r = await refresh(fx, 'e7-rate-limited', (await signIn(fx, 'e7-rate-limited', { client: 'app' })).refresh)
    expect([r.status, r.headers.get('Retry-After'), await r.json()]).toEqual([429, '30', { error: 'slow_down' }])
  },
  e8: async () => {
    // Discovery by appending under the pinned path; the issuer is a template; the callback names the tenant's issuer.
    expect((await meta(`${LOGIN}/.well-known/oauth-authorization-server/e8`)).status).toBe(404)
    const doc = (await (await meta(`${LOGIN}/e8/common/v2.0/.well-known/openid-configuration`)).json()) as Record<string, unknown>
    expect(doc.issuer).toBe(`${LOGIN}/e8/{tenantid}/v2.0`)
    const s = await signIn(fx, 'e8')
    expect(s.callback.searchParams.get('iss')).toBe(`${LOGIN}/e8/${E8_TENANT}/v2.0`)
    expect(recordedIssuerOf('e8')).toBe(`${LOGIN}/e8/${E8_TENANT}/v2.0`)
  },
  'e8-other': async () => {
    expect((await signIn(fx, 'e8-other')).callback.searchParams.get('iss')).toBe(`${LOGIN}/e8-other/${E8_OTHER_TENANT}/v2.0`)
  },
  'e8-foreign': async () => {
    const doc = (await (await meta(`${LOGIN}/e8-foreign/common/v2.0/.well-known/openid-configuration`)).json()) as Record<string, unknown>
    expect(doc.issuer).toBe(`${LOGIN}/e8-foreign/{tenantid}/v2.0`)
  },
  e9: async () => {
    const { challenge } = await pkcePair('e9')
    const withResource = await fx.fetch(new Request(`${LOGIN}/e9/authorize?${new URLSearchParams({ response_type: 'code', client_id: CLIENT_DOC_URL, redirect_uri: FIXTURE_REDIRECT_URIS[0], code_challenge: challenge, code_challenge_method: 'S256', resource: `${MODERN}/as/e9/mcp` })}`))
    expect(new URL(withResource.headers.get('Location')!).searchParams.get('error')).toBe('invalid_target')
    // Without resource it signs in, and its token is still good only at its own server.
    const s = await signIn(fx, 'e9', { resource: null })
    expect((await modern(fx, `${MODERN}/as/e9/mcp`, 'tools/list', {}, { headers: { Authorization: `Bearer ${s.access}` } })).status).toBe(200)
    expect((await modern(fx, `${MODERN}/mcp`, 'tools/list', {}, { headers: { Authorization: `Bearer ${s.access}` } })).status).toBe(401)
  },
  'e10-redirect': async () => {
    const first = await meta(`${LOGIN}/.well-known/oauth-authorization-server/e10-redirect`)
    expect(first.status).toBe(302)
    // Following it would land on another issuer's document.
    const followed = (await (await meta(first.headers.get('Location')!)).json()) as Record<string, unknown>
    expect(followed.issuer).not.toBe(issuerOf('e10-redirect'))
    const next = (await (await meta(`${LOGIN}/.well-known/openid-configuration/e10-redirect`)).json()) as Record<string, unknown>
    expect(next.issuer).toBe(issuerOf('e10-redirect'))
  },
  'e10-401': async () => {
    expect((await meta(`${LOGIN}/.well-known/oauth-authorization-server/e10-401`)).status).toBe(401)
    expect(((await (await meta(`${LOGIN}/.well-known/openid-configuration/e10-401`)).json()) as Record<string, unknown>).issuer).toBe(issuerOf('e10-401'))
  },
  e11: async () => {
    expect((await signIn(fx, 'e11')).callback.searchParams.get('iss')).toBe(`${issuerOf('e11')}/`)
  },
  'e11-match': async () => {
    expect((await signIn(fx, 'e11-match')).callback.searchParams.get('iss')).toBe(issuerOf('e11-match'))
  },
  e12: async () => {
    await expect(signIn(fx, 'e12', { client: 'app', secretIn: 'basic' })).rejects.toThrow(/token answered 401/)
    const s = await signIn(fx, 'e12', { client: 'app', secretIn: 'body' })
    expect(s.access).toBeTruthy()
    const doc = (await (await meta(`${LOGIN}/.well-known/oauth-authorization-server/e12`)).json()) as Record<string, unknown>
    expect(doc.token_endpoint_auth_methods_supported).toEqual(['client_secret_post', 'none'])
    expect(fx.as.tokenRequests.map(t => t.authMethod)).toEqual(['client_secret_basic', 'client_secret_post'])
  },
}

describe('one plant per row of E1 to E12 and F1 to F4 (connect plan sections 6.3 and 7)', () => {
  it('the rows cover E1 to E12 and F1 to F4, and every row has a check', () => {
    const rows = new Set(SIGNIN_VECTORS.flatMap(v => v.rows))
    expect([...rows].sort()).toEqual([...Array.from({ length: 12 }, (_, i) => `E${i + 1}`), 'F1', 'F2', 'F3', 'F4'].sort())
    for (const v of SIGNIN_VECTORS) expect(PLANT_CHECKS[v.profile], v.profile).toBeTypeOf('function')
    for (const v of SIGNIN_VECTORS) expect(PROFILES[v.profile], v.profile).toBeDefined()
  })

  it.each(SIGNIN_VECTORS.map(v => [v.rows.join(' '), v.profile, v.plant] as const))('%s (%s): %s', async (_rows, profile) => {
    await PLANT_CHECKS[profile]!()
  })

  it('std (control): Bearer, a space-separated scope, Basic auth, a renewal that works', async () => {
    const s = await signIn(fx, 'std', { client: 'app' })
    expect(s.tokenAnswer).toMatchObject({ token_type: 'Bearer', scope: 'notes:read notes:write' })
    expect((await refresh(fx, 'std', s.refresh)).status).toBe(200)
  })
})
