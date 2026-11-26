// The WebFetch egress (HTTPS catch-all, p3-design 8.8 and 6.2): a session's web reads, best effort. GET and HEAD only,
// no body, cookies or authorization forwarded, port 443 only. Only an exact host on the brand's `t:webfetch` list; with
// the list empty or never set (the default), no host at all (P8a S: a brand lists the hosts it may read; before P8a an
// empty list meant any public host). Every host is resolved first through DNS over HTTPS to a pinned
// resolver, and any non-public answer refuses it; address literals are judged directly. Redirects: at most 3, each hop
// checked the same way. Response bytes capped at 10 MB.
//
// The off switch (M1-F, N7): an Admin turns reading web pages off with the brand's `t:webfetch_on`. It's read from D1 at
// the top of every hop, before the static checks, the leak check, DNS or any page request, so off means no web request
// at all, also for a session that was already running and for the next hop of a redirect. A failed read refuses.
//
// The egress record (P8a): the container's HTTPS intercept (server/do/runner/runner.ts) records each hop by hostname
// and verdict in `egress_fetches`, for WebFetch and Bash alike. Allowed hops are recorded before sending, and refused
// hops in the background up to the per-brand rate limit. Never the path, query, headers or body. A request whose record
// can't be written doesn't go out (`record`). The record names the runner and its container generation.
//
// KNOWN LIMIT (decision 20, Wasim): the Workers `fetch` resolves the name again, so the connection isn't pinned to the
// address the check approved (check-then-connect). A pinned fetch is the tracked follow-up (`feat/chat-w3-pinned-fetch`).
//
// DNS over HTTPS JSON API (https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/,
// read 2026-11-20): `GET https://cloudflare-dns.com/dns-query?name=<n>&type=A|AAAA` with `accept: application/dns-json`;
// `Status` 0 is success; `Answer[]` entries carry a numeric `type` (1 A, 28 AAAA, 5 CNAME) and `data`.
import { WorkerEntrypoint } from 'cloudflare:workers'
import { parseHostlist, webFetchOn } from '../../shared/contract/settings-table.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { safeError } from '../safe-error.ts'
import type { EgressProps } from './index.ts'
import { addressVerdict } from './ip.ts'
import { taintStore } from './taint.ts'

export const DOH_URL = 'https://cloudflare-dns.com/dns-query'
export const WEBFETCH_MAX_BYTES = 10 * 1024 * 1024
export const WEBFETCH_MAX_REDIRECTS = 3
/** Bound the D1 log volume from refused requests across the brand's runners. */
export const REFUSAL_RECORDS_PER_MINUTE = 60
const REFUSAL_WINDOW_MS = 60_000
/**
 * The request headers every fetch carries upstream, fixed by Inhouse (decision L1, 2026-11-26). The agent can't set
 * any header, so none can carry data the leak check (which reads the URL only) would miss.
 */
export const FETCH_HEADERS: Readonly<Record<string, string>> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (compatible; InhouseFetch/1.0)',
}
/** Response headers passed back. */
const RESPONSE_HEADERS = ['content-type', 'content-language', 'last-modified', 'etag']

export interface WebDeps {
  /** Whether reading web pages is on now (the brand's `t:webfetch_on`, M1-F). Read before every hop; throws on a store failure. */
  fetchOn(): Promise<boolean>
  /** The brand's `t:webfetch` as stored (a JSON string value), or null when it was never set. */
  hostList(): Promise<string | null>
  /** Leak check (M1-G, N8): returns true when `url` carries a stored private-data token. Throws on store failure (fail closed). */
  checkLeak(url: URL): Promise<boolean>
  /** The network: the DoH resolver and the page fetches go through it. */
  fetch: typeof fetch
  log(entry: Record<string, unknown>): void
  /** Appends an egress record. Refused entries are capped. Throws on a storage failure. */
  record(r: FetchRecord): Promise<void>
  /** Stores a health marker independently of D1. */
  noteRecordFailure(): Promise<void>
  /** Keeps work going after the answer (the Worker's `ctx.waitUntil`): a refusal's record, which the answer never waits on. */
  waitUntil(p: Promise<unknown>): void
}

export type WebRefusal = 'method' | 'scheme' | 'port' | 'not_listed' | 'address' | 'dns' | 'redirects' | 'too_large' | 'settings' | 'record' | 'leak' | 'off'

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

/** Static URL checks that run before the leak check and DNS: scheme, port, literal address and host list. */
export function checkUrlStatic(url: URL, list: string[]): WebRefusal | null {
  if (url.protocol !== 'https:') return 'scheme'
  if (url.port !== '' && url.port !== '443') return 'port'
  if (url.username !== '' || url.password !== '') return 'scheme'
  const host = url.hostname.replace(/\.$/, '').toLowerCase()
  const literal = addressVerdict(host)
  if (literal === 'blocked') return 'address'
  // An empty list lists nothing: every host is refused (P8a S).
  if (!list.includes(host)) return 'not_listed'
  return null
}

/** DNS check for a host that already passed static checks and the leak check. */
export async function checkUrlDns(url: URL, f: typeof fetch): Promise<WebRefusal | null> {
  const host = url.hostname.replace(/\.$/, '').toLowerCase()
  if (addressVerdict(host) === 'public') return null
  return (await resolvesPublic(host, f)) ? null : 'dns'
}

/** The checks one URL must pass before it's fetched (a hop of a redirect included). */
export async function checkUrl(url: URL, list: string[], f: typeof fetch): Promise<WebRefusal | null> {
  return checkUrlStatic(url, list) ?? (await checkUrlDns(url, f))
}

const refusal = (why: WebRefusal) =>
  new Response(`WebFetch refused: ${why}`, { status: why === 'method' ? 405 : 403, headers: { 'content-type': 'text/plain' } })

async function reportRecordFailure(d: WebDeps, verdict: FetchRecord['verdict'], error: string): Promise<void> {
  d.log({ event: 'egress_record_failed', verdict, error })
  try {
    await d.noteRecordFailure()
  } catch (err) {
    d.log({ event: 'egress_record_health_failed', error: safeError(err) })
  }
}

/** A refusal never waits for its capped background record. A null host means no new outbound request. */
function refuse(why: WebRefusal, d: WebDeps, host: string | null): Response {
  d.log({ event: 'webfetch_refused', why })
  if (host !== null) {
    d.waitUntil(d.record({ host, verdict: 'refused', code: why })
      .catch(err => reportRecordFailure(d, 'refused', safeError(err))))
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

  const headers = new Headers(FETCH_HEADERS)
  for (let hop = 0; ; hop++) {
    // The off switch (M1-F, N7), read now for every hop: before the static checks, the leak check, DNS or the fetch.
    let on: boolean
    try {
      on = await d.fetchOn()
    } catch (err) {
      d.log({ event: 'webfetch_switch_read_failed', error: safeError(err) })
      return refuse('off', d, hostOf(url))
    }
    if (!on) return refuse('off', d, hostOf(url))
    const staticWhy = checkUrlStatic(url, list)
    if (staticWhy) return refuse(staticWhy, d, hostOf(url))
    let leaked: boolean
    try {
      leaked = await d.checkLeak(url)
    } catch (err) {
      d.log({ event: 'webfetch_leak_check_failed', error: safeError(err) })
      return refuse('leak', d, hostOf(url))
    }
    if (leaked) return refuse('leak', d, hostOf(url))
    const dnsWhy = await checkUrlDns(url, d.fetch)
    if (dnsWhy) return refuse(dnsWhy, d, hostOf(url))
    // Recorded before it goes out: an unrecorded request never does.
    try {
      await d.record({ host: hostOf(url), verdict: 'allowed', code: null })
    } catch (err) {
      d.waitUntil(reportRecordFailure(d, 'allowed', safeError(err)))
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

/** The brand's `t:webfetch_on` now (M1-F): on unless an Admin set it to false (`webFetchOn`). */
export async function storedFetchOn(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE owner = 'brand' AND key = 't:webfetch_on'").first<{ value_json: string }>()
  return webFetchOn(row ? (JSON.parse(row.value_json) as unknown) : undefined)
}

/** The container a request came from: the intercept's props (never a token, chat or member). */
export type EgressSource = EgressProps

/** Refused rows are capped with an atomic insert, so concurrent requests share the same budget. */
export async function recordFetch(db: D1Database, source: EgressSource, r: FetchRecord, atMs: number): Promise<void> {
  const insert = 'INSERT INTO egress_fetches (at_ms, host, verdict, code, runner, container_gen)'
  const values = [atMs, r.host, r.verdict, r.code, source.runner, source.containerGen]
  if (r.verdict === 'allowed') {
    await db.prepare(`${insert} VALUES (?, ?, ?, ?, ?, ?)`).bind(...values).run()
    return
  }
  await db.prepare(`${insert} SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
    SELECT 1 FROM egress_fetches WHERE at_ms > ? AND verdict = 'refused' LIMIT 1 OFFSET ?
  )`).bind(...values, atMs - REFUSAL_WINDOW_MS, REFUSAL_RECORDS_PER_MINUTE - 1).run()
}

/** The real deps from the Worker's env, as WebEgress runs them (the tests take these and replace only the network). */
export function webEgressDeps(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>, source: EgressSource): WebDeps {
  const db = env.DB
  const taint = taintStore(db, env.AUDIT_HASH_KEY, () => Date.now())
  return {
    fetchOn: () => storedFetchOn(db),
    hostList: () => storedHostList(db),
    checkLeak: url => taint.checkUrl(url),
    fetch: (i, init) => fetch(i, init),
    log: e => console.log(e),
    record: r => recordFetch(db, source, r, Date.now()),
    noteRecordFailure: () => brandAgent(env).noteEgressRecordFailure(),
    waitUntil: p => ctx.waitUntil(p),
  }
}

export class WebEgress extends WorkerEntrypoint<Env, EgressSource> {
  async fetch(request: Request): Promise<Response> {
    return handleWebFetch(request, webEgressDeps(this.env, this.ctx, this.ctx.props))
  }
}
