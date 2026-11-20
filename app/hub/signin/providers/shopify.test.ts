import { describe, expect, it } from 'vitest'
import { MAX_BODY_BYTES, parseShopifyConfig, requestGrant, sendRead, type ShopifyConfig, type Upstream } from './shopify'

const config: ShopifyConfig = { shop: 'example-fixture', clientId: 'test-client', clientSecret: 'test-secret' }
const now = () => 1_000_000
const answer = (res: Response | (() => Response)): { upstream: Upstream; seen: Request[] } => {
  const seen: Request[] = []
  return {
    seen,
    upstream: async req => {
      seen.push(req)
      return typeof res === 'function' ? res() : res
    },
  }
}
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'Content-Type': 'application/json', ...init.headers } })

describe('the Shopify config', () => {
  it('needs a valid shop handle, a client id and a client secret', () => {
    expect(parseShopifyConfig({ SHOPIFY_SHOP: 'example-fixture', SHOPIFY_CLIENT_ID: 'a', SHOPIFY_CLIENT_SECRET: 'b' })).toEqual({
      shop: 'example-fixture',
      clientId: 'a',
      clientSecret: 'b',
    })
    for (const env of [
      {},
      { SHOPIFY_SHOP: '', SHOPIFY_CLIENT_ID: 'a', SHOPIFY_CLIENT_SECRET: 'b' },
      { SHOPIFY_SHOP: 'evil.example/x', SHOPIFY_CLIENT_ID: 'a', SHOPIFY_CLIENT_SECRET: 'b' },
      { SHOPIFY_SHOP: 'Example', SHOPIFY_CLIENT_ID: 'a', SHOPIFY_CLIENT_SECRET: 'b' },
      { SHOPIFY_SHOP: 'example-fixture', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: 'b' },
      { SHOPIFY_SHOP: 'example-fixture', SHOPIFY_CLIENT_ID: 'a' },
    ]) {
      expect(parseShopifyConfig(env)).toBeNull()
    }
  })
})

describe('the client credentials grant', () => {
  it('posts the form to the shop, with no scope, manual redirects and a timeout', async () => {
    const { upstream, seen } = answer(json({ access_token: 'tok', scope: 'read_orders', expires_in: 86399 }))
    expect(await requestGrant(upstream, config, now)).toEqual({
      ok: true,
      accessToken: 'tok',
      scope: 'read_orders',
      expiresAtMs: 1_000_000 + 86399 * 1000,
      startMs: 1_000_000,
    })
    const req = seen[0]!
    expect(req.url).toBe('https://example-fixture.myshopify.com/admin/oauth/access_token')
    expect(req.method).toBe('POST')
    expect(req.redirect).toBe('manual')
    expect(req.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(await req.text())
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: 'test-client', client_secret: 'test-secret' })
  })

  const cases: [string, Response | (() => Response), string][] = [
    ['400', new Response('{"error":"invalid_client"}', { status: 400 }), 'credentials_rejected'],
    ['401', new Response('', { status: 401 }), 'credentials_rejected'],
    ['403', new Response('', { status: 403 }), 'credentials_rejected'],
    ['shop_not_permitted', new Response('{"error":"shop_not_permitted"}', { status: 422 }), 'credentials_rejected'],
    ['a redirect', new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }), 'upstream_unavailable'],
    ['a 5xx', new Response('', { status: 503 }), 'upstream_unavailable'],
    ['not JSON', new Response('<html>', { status: 200 }), 'upstream_unavailable'],
    ['no access_token', json({ scope: 'read_orders', expires_in: 86399 }), 'upstream_unavailable'],
    ['an empty access_token', json({ access_token: '', scope: 'read_orders', expires_in: 86399 }), 'upstream_unavailable'],
    ['expires_in 0', json({ access_token: 'tok', scope: 'read_orders', expires_in: 0 }), 'upstream_unavailable'],
    ['expires_in negative', json({ access_token: 'tok', scope: 'read_orders', expires_in: -5 }), 'upstream_unavailable'],
    ['expires_in fractional', json({ access_token: 'tok', scope: 'read_orders', expires_in: 1.5 }), 'upstream_unavailable'],
    ['expires_in a string', json({ access_token: 'tok', scope: 'read_orders', expires_in: '86399' }), 'upstream_unavailable'],
    ['a JSON array', json([1]), 'upstream_unavailable'],
  ]
  for (const [name, res, code] of cases) {
    it(`maps ${name} to ${code}`, async () => {
      expect(await requestGrant(answer(res).upstream, config, now)).toEqual({ ok: false, code })
    })
  }

  it('maps a network error to upstream_unavailable', async () => {
    const upstream: Upstream = async () => {
      throw new TypeError('network down')
    }
    expect(await requestGrant(upstream, config, now)).toEqual({ ok: false, code: 'upstream_unavailable' })
  })

  it('passes a missing scope on to the scope check (which fails it closed)', async () => {
    const r = await requestGrant(answer(json({ access_token: 'tok', expires_in: 10 })).upstream, config, now)
    expect(r.ok && r.scope).toBeUndefined()
  })
})

describe('the read call', () => {
  const read = (res: Response | (() => Response), version = '2026-10') => sendRead(answer(res).upstream, config, 'tok', version, '{ shop { name } }', undefined)

  it('posts the document to the pinned version with the token header', async () => {
    const { upstream, seen } = answer(json({ data: { shop: { name: 'x' } } }, { headers: { 'X-Shopify-API-Version': '2026-10' } }))
    expect(await sendRead(upstream, config, 'tok', '2026-10', '{ shop { name } }', { a: 1 })).toEqual({
      kind: 'result',
      result: { ok: true, value: { data: { shop: { name: 'x' } } } },
    })
    const req = seen[0]!
    expect(req.url).toBe('https://example-fixture.myshopify.com/admin/api/2026-10/graphql.json')
    expect(req.redirect).toBe('manual')
    expect(req.headers.get('X-Shopify-Access-Token')).toBe('tok')
    expect(await req.json()).toEqual({ query: '{ shop { name } }', variables: { a: 1 } })
  })

  it('maps a 401 to the re-grant path', async () => {
    expect(await read(new Response('', { status: 401 }))).toEqual({ kind: 'unauthorized' })
  })

  const codeOf = async (res: Response | (() => Response), version?: string) => {
    const r = await read(res, version)
    return r.kind === 'result' && !r.result.ok ? r.result.error : null
  }

  it('maps statuses', async () => {
    expect((await codeOf(new Response('', { status: 503 })))?.code).toBe('upstream_unavailable')
    expect((await codeOf(new Response(null, { status: 301, headers: { Location: 'https://x.example' } })))?.code).toBe('upstream_unavailable')
    expect((await codeOf(new Response('', { status: 404 })))?.code).toBe('upstream_rejected')
    expect((await codeOf(new Response('', { status: 429 })))?.code).toBe('upstream_rejected')
  })

  it('maps THROTTLED to rate_limited with retryAfterMs from throttleStatus', async () => {
    const body = {
      errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
      extensions: { cost: { requestedQueryCost: 500, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 100, restoreRate: 100 } } },
    }
    expect(await codeOf(json(body))).toEqual({ code: 'rate_limited', message: 'rate limited by the upstream', retryAfterMs: 4000 })
    const tiny = { ...body, extensions: { cost: { requestedQueryCost: 101, throttleStatus: { currentlyAvailable: 100, restoreRate: 100 } } } }
    expect((await codeOf(json(tiny)))?.retryAfterMs).toBe(1000)
  })

  it('maps ACCESS_DENIED and other errors to upstream_rejected with the codes only', async () => {
    const e = await codeOf(json({ errors: [{ message: 'Access denied for orders field. secret-ish detail', extensions: { code: 'ACCESS_DENIED' } }] }))
    expect(e).toEqual({ code: 'upstream_rejected', message: 'upstream rejected the request: ACCESS_DENIED' })
    const other = await codeOf(json({ errors: [{ message: 'Field x does not exist' }] }))
    expect(other).toEqual({ code: 'upstream_rejected', message: 'upstream rejected the request' })
  })

  it('maps a version header mismatch to upstream_version_mismatch', async () => {
    expect((await codeOf(json({ data: {} }, { headers: { 'X-Shopify-API-Version': '2027-01' } })))?.code).toBe('upstream_version_mismatch')
  })

  it('refuses a body over 4 MiB as result_too_large, streamed or declared', async () => {
    const big = () => new Response(new Uint8Array(MAX_BODY_BYTES + 1).fill(32), { status: 200 })
    expect((await codeOf(big))?.code).toBe('result_too_large')
    const declared = () =>
      new Response(new ReadableStream({ start: c => c.close() }), { status: 200, headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } })
    expect((await codeOf(declared))?.code).toBe('result_too_large')
  })

  it('maps a network error and a malformed 200 to upstream_unavailable', async () => {
    const r = await sendRead(
      async () => {
        throw new TypeError('down')
      },
      config,
      'tok',
      '2026-10',
      '{ a }',
      undefined,
    )
    expect(r).toEqual({ kind: 'result', result: { ok: false, error: { code: 'upstream_unavailable', message: 'upstream unavailable' } } })
    expect((await codeOf(new Response('nope', { status: 200 })))?.code).toBe('upstream_unavailable')
    expect((await codeOf(json({ extensions: {} })))?.code).toBe('upstream_unavailable')
  })
})
