// Property tests for the fetch leak check (M1-G, N8) on the real taint store and real handleWebFetch.
// Ways it can fail, written down before the implementation:
//  1. a token from a random private result (email, 8+ digit run, #order with 3+ digits, 12+ mixed alphanumeric),
//     placed raw, percent-encoded (1 or 2 rounds), base64url or hex, in a subdomain, path, query name/value,
//     fragment, or behind a redirect, is not refused with `leak`, or reaches DNS or the page upstream;
//  2. ordinary public URLs (dates, years, blog paths, product pages, pagination, docs fragments) are refused
//     when a full recorded Shopify store has been captured into the taint store.
import { fc, it as prop } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { dataset as FIXTURE_DATASET } from '../../test/upstreams/shopify/recordings/fixture/dataset.ts'
import { taintStore } from './taint.ts'
import { handleWebFetch, type FetchRecord } from './webfetch.ts'

const db = env.DB
const HASH_KEY = 'taint-property-test-hash-key-0123456789'
const NOW = 1_800_000_000_000

const toBase64Url = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const toHex = (s: string): string =>
  [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('')

const percentEncodeAll = (s: string): string =>
  [...new TextEncoder().encode(s)].map(b => `%${b.toString(16).padStart(2, '0').toUpperCase()}`).join('')

const emailArb = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9._-]{2,10}$/),
    fc.stringMatching(/^[a-z][a-z0-9-]{2,8}$/),
    fc.constantFrom('com', 'org', 'net', 'io'),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`)

const longDigitsArb = fc.stringMatching(/^[1-9][0-9]{7,13}$/)

const orderNameArb = fc.stringMatching(/^#[1-9][0-9]{2,6}$/)

const mixedIdArb = fc
  .stringMatching(/^[A-Za-z0-9_-]{12,24}$/)
  .filter(s => /[A-Za-z]/.test(s) && /\d/.test(s))

const tokenArb = fc.oneof(emailArb, longDigitsArb, orderNameArb, mixedIdArb)

type Encoding = 'raw' | 'pct1' | 'pct2' | 'b64url' | 'hex'
type Placement = 'subdomain' | 'path' | 'queryValue' | 'queryName' | 'fragment' | 'redirect'

function encodeToken(token: string, encoding: Encoding): string {
  switch (encoding) {
    case 'raw':
      return token
    case 'pct1':
      return percentEncodeAll(token)
    case 'pct2':
      return percentEncodeAll(percentEncodeAll(token))
    case 'b64url':
      return toBase64Url(token)
    case 'hex':
      return toHex(token)
  }
}

/** Valid DNS label check: subdomain placement can only carry DNS-safe encodings (raw mixed/digits or hex). */
const isDnsLabel = (s: string) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(s)

function buildTarget(encoded: string, placement: Placement): { url: string; hostList: string; pages: Record<string, () => Response> } {
  const baseHost = 'docs.example.com'
  const pages: Record<string, () => Response> = {}
  switch (placement) {
    case 'subdomain': {
      const host = `${encoded.toLowerCase()}.${baseHost}`
      return { url: `https://${host}/page`, hostList: `${baseHost}\n${host}`, pages }
    }
    case 'path':
      return { url: `https://${baseHost}/items/${encoded}/info`, hostList: baseHost, pages }
    case 'queryValue':
      return { url: `https://${baseHost}/lookup?ref=${encoded}`, hostList: baseHost, pages }
    case 'queryName':
      return { url: `https://${baseHost}/lookup?${encoded}=1`, hostList: baseHost, pages }
    case 'fragment':
      return { url: `https://${baseHost}/docs#${encoded}`, hostList: baseHost, pages }
    case 'redirect': {
      const start = `https://${baseHost}/start`
      const hop = `https://${baseHost}/hop?d=${encoded}`
      pages[start] = () => new Response(null, { status: 302, headers: { location: hop } })
      return { url: start, hostList: baseHost, pages }
    }
  }
}

describe('fetch leak check property (failure 1)', () => {
  beforeEach(async () => {
    await db.prepare('DELETE FROM egress_taint').run()
  })

  prop.prop(
    [
      tokenArb,
      fc.constantFrom<Encoding>('raw', 'pct1', 'pct2', 'b64url', 'hex'),
      fc.constantFrom<Placement>('subdomain', 'path', 'queryValue', 'queryName', 'fragment', 'redirect'),
      fc.stringMatching(/^[a-z ]{0,20}$/),
      fc.stringMatching(/^[a-z ]{0,20}$/),
    ],
    { numRuns: 60 },
  )(
    'any captured token in any encoding and placement is refused with leak before DNS or page fetch',
    async (token, encoding, placement, prefix, suffix) => {
      // DNS lowercases hostnames, so case-sensitive base64url or non-DNS chars cannot survive a subdomain label;
      // fall back to hex for subdomain when the chosen encoding isn't a valid DNS label.
      let enc = encoding
      if (placement === 'subdomain') {
        const candidate = encodeToken(token, enc)
        if (enc === 'b64url' || !isDnsLabel(candidate)) enc = 'hex'
      }
      // Raw '#' in path or query starts a fragment rather than staying in path/query, which URL parsing splits;
      // raw '#' in fragment works directly, and percent/b64url/hex work everywhere.
      const encoded = encodeToken(token, enc)
      const safeEncoded =
        enc === 'raw' && (placement === 'path' || placement === 'queryValue' || placement === 'queryName')
          ? encodeURIComponent(token)
          : encoded

      const store = taintStore(db, HASH_KEY, () => NOW)
      const privatePayload = JSON.stringify({ note: `${prefix} ${token} ${suffix}`, ok: true })
      await store.capture(privatePayload)

      const { url, hostList, pages } = buildTarget(safeEncoded, placement)
      const dnsCalls: string[] = []
      const pageCalls: string[] = []
      const records: FetchRecord[] = []
      const later: Promise<unknown>[] = []

      const fakeFetch = (async (input: RequestInfo | URL) => {
        const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        if (u.origin === 'https://cloudflare-dns.com') {
          dnsCalls.push(u.href)
          const type = u.searchParams.get('type')
          return Response.json({
            Status: 0,
            Answer: [{ type: type === 'A' ? 1 : 28, data: type === 'A' ? '93.184.216.34' : '2606:2800:220:1::1' }],
          })
        }
        pageCalls.push(u.href)
        const page = pages[u.href]
        return page ? page() : new Response('ok', { status: 200 })
      }) as typeof fetch

      const res = await handleWebFetch(new Request(url), {
        hostList: async () => hostList,
        checkLeak: u => store.checkUrl(u),
        fetch: fakeFetch,
        log: () => undefined,
        record: async r => { records.push(r) },
        noteRecordFailure: async () => undefined,
        waitUntil: p => { later.push(p) },
      })
      await Promise.all(later)

      expect(res.status, `${placement}/${enc} token=${token} url=${url}`).toBe(403)
      expect(await res.text()).toBe('WebFetch refused: leak')

      if (placement === 'redirect') {
        // First hop (/start) is clean so it was fetched once; the redirect target (/hop?d=...) must be refused before DNS or fetch.
        expect(pageCalls).toEqual(['https://docs.example.com/start'])
        expect(dnsCalls).toHaveLength(2) // A + AAAA for hop 0 only, zero for hop 1
        expect(records).toEqual([
          { host: 'docs.example.com', verdict: 'allowed', code: null },
          { host: 'docs.example.com', verdict: 'refused', code: 'leak' },
        ])
      } else {
        // Refused before any DNS lookup or page request.
        expect(dnsCalls).toEqual([])
        expect(pageCalls).toEqual([])
        expect(records).toEqual([{ host: new URL(url).hostname, verdict: 'refused', code: 'leak' }])
      }
    },
  )
})

const ORDINARY_URLS = [
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

describe('ordinary URL corpus with full store loaded (failure 2)', () => {
  it('passes every ordinary URL after capturing the full recorded Shopify store dataset', async () => {
    await db.prepare('DELETE FROM egress_taint').run()
    const store = taintStore(db, HASH_KEY, () => NOW)
    const captured = await store.capture(JSON.stringify(FIXTURE_DATASET))
    expect(captured).toBeGreaterThan(0)

    for (const url of ORDINARY_URLS) {
      const leaked = await store.checkUrl(new URL(url))
      expect(leaked, `false positive on ${url}`).toBe(false)
    }
  })
})
