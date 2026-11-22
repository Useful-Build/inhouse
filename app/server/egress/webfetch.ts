// The WebFetch egress (HTTPS catch-all, p3-design 8.8 and 6.2): a session's web reads, best effort. GET and HEAD only,
// no body, cookies or authorization forwarded, port 443 only. Only an exact host on the brand's `t:webfetch` list; with
// the list empty or never set (the default), no host at all (P8a S: a brand lists the hosts it may read; before P8a an
// empty list meant any public host). Every host is resolved first through DNS over HTTPS to a pinned
// resolver, and any non-public answer refuses it; address literals are judged directly. Redirects: at most 3, each hop
// checked the same way. Response bytes capped at 10 MB.
//
// The egress record (P8a): every request a container sends here, WebFetch's or Bash's alike (one `*` HTTPS intercept,
// server/do/runner/runner.ts), is recorded by host and verdict in `egress_fetches` before it goes out, each redirect hop
// its own row. Never the path, query, headers or body. A request whose record can't be written doesn't go out
// (`record`). The record names the runner and its container generation, not the run: one container serves several.
//
// KNOWN LIMIT (decision 20, Wasim): the Workers `fetch` resolves the name again, so the connection isn't pinned to the
// address the check approved (check-then-connect). A pinned fetch is the tracked follow-up (`feat/chat-w3-pinned-fetch`).
//
// DNS over HTTPS JSON API (https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/,
// read 2026-11-20): `GET https://cloudflare-dns.com/dns-query?name=<n>&type=A|AAAA` with `accept: application/dns-json`;
// `Status` 0 is success; `Answer[]` entries carry a numeric `type` (1 A, 28 AAAA, 5 CNAME) and `data`.
import { WorkerEntrypoint } from 'cloudflare:workers'
import { parseHostlist } from '../../shared/contract/settings-table.ts'
import type { EgressProps } from './index.ts'
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
  /** Appends one egress record (P8a); throws when it can't be written. */
  record(r: FetchRecord): Promise<void>
}

export type WebRefusal = 'method' | 'scheme' | 'port' | 'not_listed' | 'address' | 'dns' | 'redirects' | 'too_large' | 'settings' | 'record'

/** One outbound request as the egress record keeps it: the host only, and the verdict with its refusal code. */
export type FetchRecord = { host: string; verdict: 'allowed'; code: null } | { host: string; verdict: 'refused'; code: WebRefusal }

/** A URL's host as the checks see it: lowercase, one trailing dot dropped. Nothing else of the URL. */
const hostOf = (url: URL) => url.hostname.replace(/\.$/, '').toLowerCase()

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
  // An empty list lists nothing: every host is refused (P8a S).
  if (!list.includes(host)) return 'not_listed'
  if (literal === 'public') return null
  return (await resolvesPublic(host, f)) ? null : 'dns'
}

const refusal = (why: WebRefusal) =>
  new Response(`WebFetch refused: ${why}`, { status: why === 'method' ? 405 : 403, headers: { 'content-type': 'text/plain' } })

/**
 * A refusal, recorded under `host` (null: nothing new would have gone out, so no row). A refusal whose record fails is
 * still a refusal (logged loud): nothing went out.
 */
async function refuse(why: WebRefusal, d: WebDeps, host: string | null): Promise<Response> {
  d.log({ event: 'webfetch_refused', why })
  if (host !== null) {
    try {
      await d.record({ host, verdict: 'refused', code: why })
    } catch (err) {
      d.log({ event: 'egress_record_failed', verdict: 'refused', error: err instanceof Error ? err.name : 'unknown' })
    }
  }
  return refusal(why)
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
  let url = new URL(request.url)
  if (request.method !== 'GET' && request.method !== 'HEAD') return refuse('method', d, hostOf(url))
  const stored = await d.hostList()
  const list = stored === null ? [] : parseHostlist(stored)
  if (list === null) return refuse('settings', d, hostOf(url))

  const headers = new Headers()
  for (const h of REQUEST_HEADERS) {
    const v = request.headers.get(h)
    if (v !== null) headers.set(h, v)
  }
  for (let hop = 0; ; hop++) {
    const why = await checkUrl(url, list, d.fetch)
    if (why) return refuse(why, d, hostOf(url))
    // Recorded before it goes out: an unrecorded request never does.
    try {
      await d.record({ host: hostOf(url), verdict: 'allowed', code: null })
    } catch (err) {
      d.log({ event: 'egress_record_failed', verdict: 'allowed', error: err instanceof Error ? err.name : 'unknown' })
      d.log({ event: 'webfetch_refused', why: 'record' })
      return refusal('record')
    }
    const res = await d.fetch(url.toString(), { method: request.method, headers, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      await res.body?.cancel()
      let next: URL
      try {
        next = new URL(res.headers.get('location')!, url)
      } catch {
        return refuse('scheme', d, null)
      }
      if (hop >= WEBFETCH_MAX_REDIRECTS) return refuse('redirects', d, hostOf(next))
      url = next
      continue
    }
    const declared = res.headers.get('content-length')
    if (declared !== null && Number(declared) > WEBFETCH_MAX_BYTES) {
      await res.body?.cancel()
      // Already recorded as allowed: the request went out; its answer is cut here.
      return refuse('too_large', d, null)
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

/** The container a request came from: the intercept's props (never a token, chat or member). */
export type EgressSource = EgressProps

/** Appends one `egress_fetches` row (0600). Throws when it can't be written. */
export async function recordFetch(db: D1Database, source: EgressSource, r: FetchRecord, atMs: number): Promise<void> {
  await db.prepare('INSERT INTO egress_fetches (at_ms, host, verdict, code, runner, container_gen) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(atMs, r.host, r.verdict, r.code, source.runner, source.containerGen).run()
}

export class WebEgress extends WorkerEntrypoint<Env, EgressSource> {
  async fetch(request: Request): Promise<Response> {
    const source = this.ctx.props
    const db = this.env.DB
    return handleWebFetch(request, {
      hostList: () => storedHostList(db), fetch: (i, init) => fetch(i, init), log: e => console.log(e),
      record: r => recordFetch(db, source, r, Date.now()),
    })
  }
}
