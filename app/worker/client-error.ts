// POST /api/client-error: hardening's client error reports, logged to Workers Logs. Used by both Workers (the demo's
// worker/index.ts and the product's server/index.ts), each passing its own parsed security headers.
import { respond } from '../shared/security-headers.ts'
import { scrubReport, stripUrl } from './scrub.ts'

const MAX_BODY = 8 * 1024

// ---------- rate limit: a token bucket per client IP, per isolate (no bindings) ----------
const BUCKET_SIZE = 10
const REFILL_MS = 6_000 // one report back every 6 s, so 10 per minute sustained
const MAX_TRACKED = 5_000
const buckets = new Map<string, { tokens: number; at: number }>()

function allow(ip: string, now = Date.now()): boolean {
  let b = buckets.get(ip)
  if (!b) {
    // Forget the oldest entry so a flood of addresses can't grow the map without bound.
    if (buckets.size >= MAX_TRACKED) buckets.delete(buckets.keys().next().value as string)
    b = { tokens: BUCKET_SIZE, at: now }
    buckets.set(ip, b)
  }
  b.tokens = Math.min(BUCKET_SIZE, b.tokens + (now - b.at) / REFILL_MS)
  b.at = now
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

/** The body as text, or null once it passes `limit` bytes. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? 0)
  if (declared > limit) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) { await reader.cancel(); return null }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.byteLength }
  return new TextDecoder().decode(all)
}

/**
 * A post from another site: `Sec-Fetch-Site` other than same-origin, or an `Origin` that isn't ours. Clients that send
 * neither (not a browser) pass, and stay under the per-IP limit.
 */
function crossSite(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site')
  if (site !== null && site !== 'same-origin') return true
  const origin = request.headers.get('Origin')
  return origin !== null && origin !== new URL(request.url).origin
}

// ---------- what reaches Workers Logs: an allowlist ----------
// A report's message and stack are free text from the browser, and the scrubber's patterns (URLs, emails, tokens) don't
// catch what was on screen: a customer's name, an order note, a file name or a chat line in an error's message
// (JSON.parse quotes the text it choked on). So the log keeps only what an operator needs to find the bug (P8a P-auth):
// the kind, the release, the page's path, the error's name from the stack's first line, and the stack frames that are
// code locations (V8's `at fn (url:line:col)` and `at url:line:col`, Firefox and Safari's `fn@url:line:col`), each URL
// without its query, and only on the page's own http(s) origin: a message line shaped like a frame (`at x (note:Jane:1:2)`)
// or a script from elsewhere doesn't survive. Frames are read from the raw stack (the scrubber would cut a URL's
// `:line:col` with its query).
// The client's own report (src/report-error.ts) is unchanged; it never leaves the request.
const NAME = /^([A-Z][A-Za-z0-9_]{0,63})(?::|$)/
const V8_FRAME = /^\s*at (?:((?:new |async )?[\w$.<>[\]/-]{1,200}) \(([^\s()]+):(\d+):(\d+)\)|([^\s()]+):(\d+):(\d+))$/
const OTHER_FRAME = /^([\w$.<>[\]/-]{0,200})@([^\s@]+):(\d+):(\d+)$/
const MAX_FRAMES = 20
const MAX_STACK = 8000

/** `url:line:col` with the URL's query and hash stripped; null when the URL isn't http(s) on `origin`. */
function at(origin: string, url: string, line: string, col: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== origin) return null
  return `${stripUrl(url)}:${line}:${col}`
}

function frameOf(origin: string, text: string): string | null {
  const v8 = V8_FRAME.exec(text)
  if (v8) {
    const where = v8[1] !== undefined ? at(origin, v8[2]!, v8[3]!, v8[4]!) : at(origin, v8[5]!, v8[6]!, v8[7]!)
    return where === null ? null : v8[1] !== undefined ? `at ${v8[1]} (${where})` : `at ${where}`
  }
  const other = OTHER_FRAME.exec(text)
  const where = other ? at(origin, other[2]!, other[3]!, other[4]!) : null
  return other && where !== null ? `${other[1]}@${where}` : null
}

/** The log line's fields: no message, and of the stack only its error name and its code locations. */
export function loggedReport(input: unknown, origin: string) {
  const report = scrubReport(input)
  const stack = (input as { stack?: unknown }).stack
  const lines = (typeof stack === 'string' ? stack.slice(0, MAX_STACK) : '').split('\n')
  const frames = lines.map(l => frameOf(origin, l)).filter((f): f is string => f !== null).slice(0, MAX_FRAMES)
  return {
    kind: report.kind,
    release: report.release,
    url: report.url,
    name: NAME.exec(lines[0] ?? '')?.[1] ?? 'unknown',
    frames,
    ...(report.demo ? { demo: true as const } : {}),
  }
}

export async function clientError(request: Request, security: readonly [string, string][]): Promise<Response> {
  if (request.method !== 'POST') return respond(security, 405, { headers: { Allow: 'POST' } })
  if (crossSite(request)) return respond(security, 403)
  if (!allow(request.headers.get('CF-Connecting-IP') ?? 'unknown')) return respond(security, 429, { headers: { 'Retry-After': '60' } })
  const text = await readCapped(request, MAX_BODY)
  if (text === null) return respond(security, 413)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return respond(security, 400) }
  if (typeof parsed !== 'object' || parsed === null) return respond(security, 400)
  const report = loggedReport(parsed, new URL(request.url).origin)
  // One structured line per report, for Workers Logs (its fields are indexed, so filter on release, kind or name).
  console.error({ event: 'client_error', ...report, country: request.cf?.country ?? null })
  return respond(security, 204)
}
