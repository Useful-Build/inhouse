// Static assets are served before the Worker runs, except /api/* (`assets.run_worker_first`), so anything that
// reaches it is an API call or has no route.
import headersFile from '../public/_headers?raw'
import { scrubReport } from './scrub.ts'

const MAX_BODY = 8 * 1024

/** The `/*` block of public/_headers. `_headers` doesn't apply to Worker responses, so the Worker sets the same ones. */
function parseHeaders(file: string): [string, string][] {
  const out: [string, string][] = []
  let inAll = false
  for (const line of file.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) { inAll = line.trim() === '/*'; continue }
    if (!inAll) continue
    const i = line.indexOf(':')
    if (i > 0) out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()])
  }
  if (out.length === 0) throw new Error('public/_headers has no "/*" headers to copy onto Worker responses.')
  return out
}
const SECURITY_HEADERS = parseHeaders(headersFile)

/** A Worker response with the site's security headers. */
function respond(status: number, init: { headers?: Record<string, string> } = {}): Response {
  const headers = new Headers(init.headers)
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value)
  headers.set('Cache-Control', 'no-store')
  return new Response(null, { status, headers })
}

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

async function clientError(request: Request): Promise<Response> {
  if (request.method !== 'POST') return respond(405, { headers: { Allow: 'POST' } })
  if (!allow(request.headers.get('CF-Connecting-IP') ?? 'unknown')) return respond(429, { headers: { 'Retry-After': '60' } })
  const text = await readCapped(request, MAX_BODY)
  if (text === null) return respond(413)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return respond(400) }
  if (typeof parsed !== 'object' || parsed === null) return respond(400)
  const report = scrubReport(parsed)
  // One structured line per report, for Workers Logs (its fields are indexed, so filter on release or kind).
  console.error({ event: 'client_error', ...report, country: request.cf?.country ?? null })
  return respond(204)
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/client-error') return clientError(request)
    return respond(404)
  },
} satisfies ExportedHandler<Env>
