// Property tests for the fetch leak check (M1-G, N8) on the real taint store and real handleWebFetch.
// Ways it can fail, written down before the implementation:
//  1. a token from a private result (email, 8+ digit run, #order with 3+ digits, 12+ mixed alphanumeric), captured
//     from plain text, from a JSON result with escapes next to it, or placed in the URL with adjacent characters, and
//     placed raw, percent-encoded (1 or 2 rounds), base64url or hex, in a subdomain, path, query name/value, fragment,
//     or behind a redirect, in any letter case the encoding allows, is not refused with `leak`, or reaches DNS or the
//     page upstream. Every type x encoding x placement x context is enumerated; fast-check draws the values;
//  2. ordinary public URLs (dates, years, blog paths, timestamps, pagination, docs fragments) and URLs built from the
//     store's own catalogue (storefront pages, product ids, `?variant=<id>`, skus, titles; decision L2) are refused
//     when a full store (the recorded fixture with synthetic customers and real-length ids) has been captured chunk
//     by chunk (products through `products_search`, orders through `orders_search`), while its customer and order
//     data is refused.
import { fc } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { dataset as FIXTURE_DATASET } from '../../test/upstreams/shopify/recordings/fixture/dataset.ts'
import { resultTokens, TAINT_MAX_TOKENS_PER_RESULT, taintStore, type TaintSource } from './taint.ts'
import { handleWebFetch, type FetchRecord } from './webfetch.ts'

const db = env.DB
const HASH_KEY = 'taint-property-test-hash-key-0123456789'
const NOW = 1_800_000_000_000
const RUNS = Number(import.meta.env.VITE_PROP_RUNS) || 2
const BASE_HOST = 'docs.example.com'

const hubBody = (data: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } })

const toBase64Url = (s: string): string => {
  let bin = ''
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const toHex = (s: string): string => [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('')
const percentEncodeAll = (s: string): string => [...new TextEncoder().encode(s)].map(b => `%${b.toString(16).padStart(2, '0').toUpperCase()}`).join('')
const isDnsLabel = (s: string) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(s)
const isDateShaped = (s: string) => /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2})?$/.test(s) || /^\d{8}[Tt]\d{2,6}[Zz]?$/.test(s)

type TokenType = 'email' | 'digits' | 'order' | 'mixed'
type Encoding = 'raw' | 'pct1' | 'pct2' | 'b64url' | 'hex'
type Placement = 'subdomain' | 'path' | 'queryValue' | 'queryName' | 'fragment' | 'redirect'
type Context = 'plain' | 'json-escaped' | 'adjacent'

const TYPES: readonly TokenType[] = ['email', 'digits', 'order', 'mixed']
const ENCODINGS: readonly Encoding[] = ['raw', 'pct1', 'pct2', 'b64url', 'hex']
const PLACEMENTS: readonly Placement[] = ['subdomain', 'path', 'queryValue', 'queryName', 'fragment', 'redirect']
const CONTEXTS: readonly Context[] = ['plain', 'json-escaped', 'adjacent']

const TOKEN_ARB: Record<TokenType, fc.Arbitrary<string>> = {
  email: fc
    .tuple(fc.stringMatching(/^[a-z][a-z0-9._-]{2,10}$/), fc.stringMatching(/^[a-z][a-z0-9-]{2,8}$/), fc.constantFrom('com', 'org', 'net', 'io'))
    .map(([local, domain, tld]) => `${local}@${domain}.${tld}`),
  digits: fc.stringMatching(/^[1-9][0-9]{7,13}$/),
  order: fc.stringMatching(/^#[1-9][0-9]{2,6}$/),
  mixed: fc.stringMatching(/^[A-Za-z0-9_-]{12,24}$/).filter(s => /[A-Za-z]/.test(s) && /\d/.test(s) && !isDateShaped(s)),
}

/** Characters glued onto a token in the URL (the `adjacent` context), by what can sit next to it and still be found. */
function glue(type: TokenType, token: string, sep: string): string {
  switch (type) {
    case 'email':
      return `x.${token}.y`
    case 'digits':
      return `x${token}y`
    case 'order':
      return `x${token}${sep === '.' ? 'a' : sep}x`
    case 'mixed':
      return `x${sep}${token}${sep}y`
  }
}

function encode(text: string, encoding: Encoding): string {
  switch (encoding) {
    case 'raw':
      return text
    case 'pct1':
      return percentEncodeAll(text)
    case 'pct2':
      return percentEncodeAll(percentEncodeAll(text))
    case 'b64url':
      return toBase64Url(text)
    case 'hex':
      return toHex(text)
  }
}

/** Flips the case of the letters the mask marks (an encoding whose letters carry no case: never base64url). */
const recase = (s: string, mask: boolean[]) => [...s].map((c, i) => (mask[i % mask.length] ? c.toUpperCase() : c.toLowerCase())).join('')

function buildTarget(placed: string, placement: Placement, hostCase: boolean[]): { url: string; hostList: string; pages: Record<string, () => Response> } {
  const host = recase(BASE_HOST, hostCase)
  const pages: Record<string, () => Response> = {}
  switch (placement) {
    case 'subdomain':
      return { url: `https://${placed}.${host}/page`, hostList: `${BASE_HOST}\n${placed.toLowerCase()}.${BASE_HOST}`, pages }
    case 'path':
      return { url: `https://${host}/items/${placed}/info`, hostList: BASE_HOST, pages }
    case 'queryValue':
      return { url: `https://${host}/lookup?ref=${placed}`, hostList: BASE_HOST, pages }
    case 'queryName':
      return { url: `https://${host}/lookup?${placed}=1`, hostList: BASE_HOST, pages }
    case 'fragment':
      return { url: `https://${host}/docs#${placed}`, hostList: BASE_HOST, pages }
    case 'redirect': {
      pages[`https://${BASE_HOST}/start`] = () => new Response(null, { status: 302, headers: { location: `https://${host}/hop?d=${placed}` } })
      return { url: `https://${host}/start`, hostList: BASE_HOST, pages }
    }
  }
}

/** What the URL carries for one case: the token (glued or not), encoded, made safe for its placement, case-shuffled. */
function placeToken(type: TokenType, token: string, encoding: Encoding, placement: Placement, context: Context, draw: Draw): string {
  const text = context === 'adjacent' ? glue(type, token, draw.sep) : token
  let enc = encoding
  // A hostname is lower-cased and DNS-shaped: base64url or a non-label raw/percent form goes as hex there.
  if (placement === 'subdomain' && (enc === 'b64url' || enc === 'pct1' || enc === 'pct2' || !isDnsLabel(encode(text, enc)))) enc = 'hex'
  let placed = encode(text, enc)
  // Raw `#`, `@` and friends in a path or query: the browser's own escaping (one percent round).
  if (enc === 'raw' && placement !== 'subdomain' && placement !== 'fragment') placed = encodeURIComponent(placed)
  // Glued characters on an encoded run: up to 3 base64url characters (offsets 0-3), 1 hex digit (offset 1).
  if (context === 'adjacent' && enc === 'b64url') placed = `${draw.b64Pre}${placed}${draw.b64Post}`
  if (context === 'adjacent' && enc === 'hex') placed = `${draw.hexPre}${placed}${draw.hexPost}`
  return enc === 'b64url' ? placed : recase(placed, draw.caseMask)
}

interface Draw {
  token: string
  prefix: string
  suffix: string
  escape: string
  sep: string
  b64Pre: string
  b64Post: string
  hexPre: string
  hexPost: string
  caseMask: boolean[]
  hostCase: boolean[]
}

const drawArb = (type: TokenType): fc.Arbitrary<Draw> =>
  fc.record({
    token: TOKEN_ARB[type],
    prefix: fc.stringMatching(/^[a-z ]{0,20}$/),
    suffix: fc.stringMatching(/^[a-z ]{0,20}$/),
    escape: fc.constantFrom('\n', '\t', '\r', '"', '\\'),
    sep: fc.constantFrom('-', '_', '.'),
    b64Pre: fc.stringMatching(/^[A-Za-z0-9]{0,3}$/),
    b64Post: fc.stringMatching(/^[A-Za-z0-9]{0,3}$/),
    hexPre: fc.stringMatching(/^[0-9a-f]?$/),
    hexPost: fc.stringMatching(/^[0-9a-f]?$/),
    caseMask: fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
    hostCase: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
  })

/** The private result the token is captured from, per context. */
function privateResult(token: string, context: Context, draw: Draw): { body: string; source: TaintSource } {
  switch (context) {
    case 'plain':
    case 'adjacent':
      return { body: `${draw.prefix} ${token} ${draw.suffix}`, source: { route: 'files', contentType: 'text/plain' } }
    case 'json-escaped':
      // An escape right before and after the token: raw-text tokenizing would glue `n`, `t`, `r` or `\` onto it.
      return { body: hubBody({ order: { note: `${draw.prefix}${draw.escape}${token}${draw.escape}${draw.suffix}` } }), source: { route: 'hub', tool: 'order_get' } }
  }
}

function fakeNet(pages: Record<string, () => Response>) {
  const dnsCalls: string[] = []
  const pageCalls: string[] = []
  const netFetch = (async (input: RequestInfo | URL) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (u.origin === 'https://cloudflare-dns.com') {
      dnsCalls.push(u.href)
      const type = u.searchParams.get('type')
      return Response.json({ Status: 0, Answer: [{ type: type === 'A' ? 1 : 28, data: type === 'A' ? '93.184.216.34' : '2606:2800:220:1::1' }] })
    }
    pageCalls.push(u.href)
    const page = pages[u.href]
    return page ? page() : new Response('ok', { status: 200 })
  }) as typeof fetch
  return { fetch: netFetch, dnsCalls, pageCalls }
}

describe('fetch leak check property (failure 1): every type x encoding x placement x context', () => {
  beforeEach(async () => {
    await db.prepare('DELETE FROM egress_taint').run()
  })

  for (const type of TYPES) {
    for (const context of CONTEXTS) {
      it(`${type} captured ${context === 'adjacent' ? 'plain, glued in the URL' : context}: refused with leak in every encoding and placement before DNS or page fetch`, async () => {
        for (const encoding of ENCODINGS) {
          for (const placement of PLACEMENTS) {
            await fc.assert(
              fc.asyncProperty(drawArb(type), async draw => {
                await db.prepare('DELETE FROM egress_taint').run()
                const store = taintStore(db, HASH_KEY, () => NOW)
                const { body, source } = privateResult(draw.token, context, draw)
                await store.capture(body, source)

                const placed = placeToken(type, draw.token, encoding, placement, context, draw)
                const { url, hostList, pages } = buildTarget(placed, placement, draw.hostCase)
                const net = fakeNet(pages)
                const records: FetchRecord[] = []
                const later: Promise<unknown>[] = []
                const res = await handleWebFetch(new Request(url), {
                  hostList: async () => hostList,
                  checkLeak: u => store.checkUrl(u),
                  fetch: net.fetch,
                  log: () => undefined,
                  record: async r => { records.push(r) },
                  noteRecordFailure: async () => undefined,
                  waitUntil: p => { later.push(p) },
                })
                await Promise.all(later)

                const what = `${type}/${context}/${encoding}/${placement} token=${JSON.stringify(draw.token)} url=${url}`
                expect(res.status, what).toBe(403)
                expect(await res.text(), what).toBe('WebFetch refused: leak')
                if (placement === 'redirect') {
                  // The clean first hop went out once; the redirect target is refused before its DNS or fetch.
                  expect(net.pageCalls, what).toEqual([`https://${BASE_HOST}/start`])
                  expect(net.dnsCalls, what).toHaveLength(2)
                  expect(records, what).toEqual([
                    { host: BASE_HOST, verdict: 'allowed', code: null },
                    { host: BASE_HOST, verdict: 'refused', code: 'leak' },
                  ])
                } else {
                  expect(net.dnsCalls, what).toEqual([])
                  expect(net.pageCalls, what).toEqual([])
                  expect(records, what).toEqual([{ host: new URL(url).hostname, verdict: 'refused', code: 'leak' }])
                }
              }),
              { numRuns: RUNS },
            )
          }
        }
      })
    }
  }
})

// ---- failure 2: a full store, captured chunk by chunk, and the ordinary URLs built from it ----

interface FixtureOrder {
  id: string
  name: string
  processedAt: string
  updatedAt: string
  lineItems: { nodes: { sku: string | null; title: string }[] }
  refunds: { note: string | null; createdAt: string }[]
}
interface FixtureProduct {
  id: string
  title: string
  status: string
  variants: { nodes: { id: string; sku: string | null; title: string; price: string }[] }
}
const fixture = FIXTURE_DATASET as { orders: FixtureOrder[]; products: FixtureProduct[] }
const numOf = (gid: string) => Number(gid.split('/').pop())
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** The fixture's products with real-length Shopify ids and a handle (catalogue data, decision L2). */
const PRODUCTS = fixture.products.map(p => {
  const n = numOf(p.id)
  return {
    id: `gid://shopify/Product/${8_100_000_000_000 + n}`,
    title: p.title,
    handle: `${slug(p.title)}-${2020 + (n % 7)}`,
    status: p.status.toLowerCase(),
    variants: p.variants.nodes.map(v => ({
      id: `gid://shopify/ProductVariant/${44_000_000_000_000 + numOf(v.id)}`,
      sku: v.sku,
      title: v.title,
      price: { amount: v.price, currencyCode: 'USD' },
    })),
  }
})
/** The fixture's orders with real-length ids and a synthetic customer (the fixture is scrubbed of customers). */
const ORDERS = fixture.orders.map(o => {
  const n = numOf(o.id)
  return {
    id: `gid://shopify/Order/${5_550_000_000_000 + n}`,
    name: o.name,
    processedAt: o.processedAt,
    updatedAt: o.updatedAt,
    customer: {
      id: `gid://shopify/Customer/${7_770_000_000_000 + n}`,
      displayName: `Buyer ${n}`,
      email: `buyer${n}.${n % 2 ? 'k' : 'm'}@mail${n % 13}.example.net`,
      phone: `+1555${String(n).padStart(7, '0')}`,
    },
    lineItems: o.lineItems.nodes.map(l => ({ sku: l.sku, title: l.title })),
    refunds: o.refunds.map(r => ({ note: r.note, createdAt: r.createdAt })),
  }
})
const chunks = <T,>(xs: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, i * size + size))

const GENERIC_URLS = [
  'https://docs.example.com/',
  'https://docs.example.com/blog/2026/11/26/autumn-ceramics-release',
  'https://docs.example.com/blog/2025/04/12/shipping-updates',
  'https://docs.example.com/products/moss-glaze-mug',
  'https://docs.example.com/products/ceramic-pour-over-set?variant=large&color=slate',
  'https://docs.example.com/collections/bestsellers?page=2&sort=price-asc',
  'https://docs.example.com/guides/getting-started#installation',
  'https://docs.example.com/guides/returns-policy?lang=en&region=eu#window-45-days',
  'https://docs.example.com/changelog/v2-4-0?year=2026',
  'https://docs.example.com/docs/api/v1/orders?limit=50&offset=100',
  'https://docs.example.com/help/contact-us?topic=delivery&ref=footer',
  'https://docs.example.com/news/2026-q4-sustainability-report',
  'https://docs.example.com/search?q=coffee+mug&min_price=20&max_price=80',
  'https://docs.example.com/assets/guide-2026.pdf',
  'https://docs.example.com/status#uptime-99',
]

/** Ordinary URLs that share fields with the store: its catalogue, its dates and its line items. */
function storeUrls(): string[] {
  const urls: string[] = [...GENERIC_URLS]
  for (const p of PRODUCTS) {
    const v = p.variants[0]!
    urls.push(`https://shop.example.com/products/${p.handle}?variant=${numOf(v.id)}`)
    urls.push(`https://shop.example.com/products/${numOf(p.id)}`)
    urls.push(`https://shop.example.com/search?q=${encodeURIComponent(p.title).replace(/%20/g, '+')}&sku=${encodeURIComponent(v.sku ?? '')}`)
    urls.push(`https://shop.example.com/cart/${numOf(v.id)}:1`)
  }
  for (const o of ORDERS) {
    urls.push(`https://docs.example.com/changes?since=${encodeURIComponent(o.processedAt)}&until=${o.updatedAt}`)
    urls.push(`https://docs.example.com/blog/${o.processedAt.slice(0, 10)}/${slug(o.lineItems[0]?.title ?? 'news')}`)
  }
  return urls
}

describe('ordinary URL corpus with a full store loaded (failure 2)', () => {
  it('stores every token of the store, passes every ordinary and catalogue URL, refuses its customer data', async () => {
    await db.prepare('DELETE FROM egress_taint').run()
    const store = taintStore(db, HASH_KEY, () => NOW)
    const results = [
      ...chunks(ORDERS, 10).map(c => ({ body: hubBody({ orders: c, nextCursor: 'eyJsYXN0X2lkIjo1NTUwMDAwMDAwMDEwfQ' }), tool: 'orders_search' })),
      // products_search returns no handle: the handle is only for building the storefront URLs below.
      ...chunks(PRODUCTS, 10).map(c => ({ body: hubBody({ items: c.map(({ handle: _handle, ...p }) => p), nextCursor: null }), tool: 'products_search' })),
    ]
    const expected = new Set<string>()
    for (const { body, tool } of results) {
      const tokens = resultTokens(body, { route: 'hub', tool })
      expect(tokens.length).toBeLessThan(TAINT_MAX_TOKENS_PER_RESULT)
      for (const t of tokens) expected.add(t)
      await store.capture(body, { route: 'hub', tool })
    }
    // Per order at least: the email, the order name, the order id, the customer id and the phone.
    expect(expected.size).toBeGreaterThanOrEqual(ORDERS.length * 5)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM egress_taint').first<number>('n')).toBe(expected.size)

    for (const url of storeUrls()) expect(await store.checkUrl(new URL(url)), `false positive on ${url}`).toBe(false)

    for (const o of ORDERS.filter((_, i) => i % 25 === 0)) {
      for (const url of [
        `https://docs.example.com/?e=${encodeURIComponent(o.customer.email)}`,
        `https://docs.example.com/?o=${encodeURIComponent(o.name)}`,
        `https://docs.example.com/o/${numOf(o.id)}`,
        `https://docs.example.com/c/${numOf(o.customer.id)}`,
      ]) expect(await store.checkUrl(new URL(url)), `missed ${url}`).toBe(true)
    }
  })
})
