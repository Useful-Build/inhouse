// The WebFetch egress (HTTPS catch-all, p3-design 8.8 and 6.2): a session's web reads, best effort. GET and HEAD only,
// no body, cookies or authorization forwarded, port 443 only. With the brand's `t:webfetch` empty (the default) any
// public host; with a list, only an exact host on it. Every host is resolved first through DNS over HTTPS to a pinned
// resolver, and any non-public answer refuses it; address literals are judged directly. Redirects: at most 3, each hop
// checked the same way. Response bytes capped at 10 MB.
//
// KNOWN LIMIT (decision 20, Wasim): the Workers `fetch` resolves the name again, so the connection isn't pinned to the
// address the check approved (check-then-connect). A pinned fetch is the tracked follow-up (`feat/chat-w3-pinned-fetch`).
//
// DNS over HTTPS JSON API (https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/,
// read 2026-11-20): `GET https://cloudflare-dns.com/dns-query?name=<n>&type=A|AAAA` with `accept: application/dns-json`;
// `Status` 0 is success; `Answer[]` entries carry a numeric `type` (1 A, 28 AAAA, 5 CNAME) and `data`.
import { WorkerEntrypoint } from 'cloudflare:workers'
import { parseHostlist } from '../../shared/contract/settings-table.ts'
import { addressVerdict } from './ip.ts'

export const DOH_URL = 'https://cloudflare-dns.com/dns-query'
export const WEBFETCH_MAX_BYTES = 10 * 1024 * 1024
export const WEBFETCH_MAX_REDIRECTS = 3
/** Request headers a fetch may carry upstream (nothing that identifies or authorises). */
const REQUEST_HEADERS = ['accept', 'accept-language', 'user-agent']
/** Response headers passed back. */
const RESPONSE_HEADERS = ['content-type', 'content-language', 'last-modified', 'etag']

export interface WebDeps {
  /** The brand's `t:webfetch` as stored (a JSON string value), or null when it was never set. */
  hostList(): Promise<string | null>
  /** The network: the DoH resolver and the page fetches go through it. */
  fetch: typeof fetch
  log(entry: Record<string, unknown>): void
}

export type WebRefusal = 'method' | 'scheme' | 'port' | 'not_listed' | 'address' | 'dns' | 'redirects' | 'too_large' | 'settings'

/** Whether a host's every A and AAAA answer is public (and it has at least one). */
export async function resolvesPublic(host: string, f: typeof fetch): Promise<boolean> {
  let any = false
  for (const type of ['A', 'AAAA']) {
    const res = await f(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' } })
    if (!res.ok) return false
    const body = (await res.json()) as { Status?: unknown; Answer?: { type?: unknown; data?: unknown }[] }
    if (body.Status !== 0) {
      // NXDOMAIN for one type with answers for the other is still a refusal: the name must resolve cleanly.
      return false
    }
    for (const a of body.Answer ?? []) {
      if (a.type !== 1 && a.type !== 28) continue
      if (typeof a.data !== 'string' || addressVerdict(a.data) !== 'public') return false
      any = true
    }
  }
  return any
}

/** The checks one URL must pass before it's fetched (a hop of a redirect included). */
export async function checkUrl(url: URL, list: string[], f: typeof fetch): Promise<WebRefusal | null> {
  if (url.protocol !== 'https:') return 'scheme'
  if (url.port !== '' && url.port !== '443') return 'port'
  if (url.username !== '' || url.password !== '') return 'scheme'
  const host = url.hostname.replace(/\.$/, '').toLowerCase()
  const literal = addressVerdict(host)
  if (literal === 'blocked') return 'address'
  if (list.length > 0 && !list.includes(host)) return 'not_listed'
  if (literal === 'public') return null
  return (await resolvesPublic(host, f)) ? null : 'dns'
}

const refuse = (why: WebRefusal, d: WebDeps) => {
  d.log({ event: 'webfetch_refused', why })
  return new Response(`WebFetch refused: ${why}`, { status: why === 'method' ? 405 : 403, headers: { 'content-type': 'text/plain' } })
}

/** The 10 MB cap over a body: past it the stream errors (the caller sees a cut body, never more bytes). */
function capped(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let seen = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      seen += chunk.byteLength
      if (seen > WEBFETCH_MAX_BYTES) c.error(new Error('WebFetch response over 10 MB'))
      else c.enqueue(chunk)
    },
  }))
}

export async function handleWebFetch(request: Request, d: WebDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return refuse('method', d)
  const stored = await d.hostList()
  const list = stored === null ? [] : parseHostlist(stored)
  if (list === null) return refuse('settings', d)

  const headers = new Headers()
  for (const h of REQUEST_HEADERS) {
    const v = request.headers.get(h)
    if (v !== null) headers.set(h, v)
  }
  let url = new URL(request.url)
  for (let hop = 0; ; hop++) {
    const why = await checkUrl(url, list, d.fetch)
    if (why) return refuse(why, d)
    const res = await d.fetch(url.toString(), { method: request.method, headers, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      await res.body?.cancel()
      if (hop >= WEBFETCH_MAX_REDIRECTS) return refuse('redirects', d)
      try {
        url = new URL(res.headers.get('location')!, url)
      } catch {
        return refuse('scheme', d)
      }
      continue
    }
    const declared = res.headers.get('content-length')
    if (declared !== null && Number(declared) > WEBFETCH_MAX_BYTES) {
      await res.body?.cancel()
      return refuse('too_large', d)
    }
    const out = new Headers()
    for (const h of RESPONSE_HEADERS) {
      const v = res.headers.get(h)
      if (v !== null) out.set(h, v)
    }
    return new Response(res.body ? capped(res.body) : null, { status: res.status, headers: out })
  }
}

/** The brand's `t:webfetch`, as stored (its JSON value is the newline-separated text), or null when never set. */
async function storedHostList(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE owner = 'brand' AND key = 't:webfetch'").first<{ value_json: string }>()
  if (!row) return null
  const v = JSON.parse(row.value_json) as unknown
  return typeof v === 'string' ? v : null
}

export class WebEgress extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return handleWebFetch(request, { hostList: () => storedHostList(this.env.DB), fetch: (i, init) => fetch(i, init), log: e => console.log(e) })
  }
}
