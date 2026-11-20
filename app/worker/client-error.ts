// POST /api/client-error: hardening's client error reports, logged to Workers Logs. Used by both Workers (the demo's
// worker/index.ts and the product's server/index.ts), each passing its own parsed security headers.
import { respond } from '../shared/security-headers.ts'
import { scrubReport } from './scrub.ts'

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

export async function clientError(request: Request, security: readonly [string, string][]): Promise<Response> {
  if (request.method !== 'POST') return respond(security, 405, { headers: { Allow: 'POST' } })
  if (crossSite(request)) return respond(security, 403)
  if (!allow(request.headers.get('CF-Connecting-IP') ?? 'unknown')) return respond(security, 429, { headers: { 'Retry-After': '60' } })
  const text = await readCapped(request, MAX_BODY)
  if (text === null) return respond(security, 413)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return respond(security, 400) }
  if (typeof parsed !== 'object' || parsed === null) return respond(security, 400)
  const report = scrubReport(parsed)
  // One structured line per report, for Workers Logs (its fields are indexed, so filter on release or kind).
  console.error({ event: 'client_error', ...report, country: request.cf?.country ?? null })
  return respond(security, 204)
}
