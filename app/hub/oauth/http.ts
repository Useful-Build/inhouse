// Upstream requests for the OAuth and MCP paths (P5 W1, brief sections 4 and 5). H0's patterns: `redirect: 'manual'`,
// a deadline whose timer is cleared when the call settles (never AbortSignal.timeout), a byte cap on every body, and
// every URL's host checked against the connector's allowed hosts (exact, https only) before the request leaves.
// Nothing here throws on an upstream answer; nothing from a body or header reaches a result except what callers parse.
import type { Upstream } from '../signin/providers/shopify'

export type { Upstream }

/** Token endpoint: 10 s, 64 KiB. MCP calls: 20 s, 4 MiB. Discovery and registration share the token bounds. */
export const TOKEN_TIMEOUT_MS = 10_000
export const TOKEN_MAX_BYTES = 64 * 1024
export const MCP_TIMEOUT_MS = 20_000
export const MCP_MAX_BYTES = 4 * 1024 * 1024

/** An https URL whose host is exactly one of `allowed`, with no credentials in it. Null otherwise. */
export function allowedUrl(raw: string, allowed: readonly string[]): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
  return allowed.includes(url.host) ? url : null
}

export type Sent =
  /** The URL failed the host check: nothing was sent. */
  | { kind: 'blocked' }
  /** The request threw before any answer (DNS, connect): it most likely never reached the upstream. */
  | { kind: 'network' }
  /** Our deadline fired, or the body stream broke: the request went out and the answer was lost. */
  | { kind: 'lost' }
  | { kind: 'response'; status: number; headers: Headers; text: string | null; tooLarge: boolean }

/** Sends one request under a deadline and reads the body with a cap. `text` is null when it isn't valid UTF-8. */
export async function send(
  upstream: Upstream,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  bounds: { allowedHosts: readonly string[]; timeoutMs: number; maxBytes: number },
): Promise<Sent> {
  const checked = allowedUrl(url, bounds.allowedHosts)
  if (!checked) return { kind: 'blocked' }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('upstream deadline', 'TimeoutError'))
  }, bounds.timeoutMs)
  try {
    let res: Response
    try {
      res = await upstream(
        new Request(checked.toString(), { method: init.method, headers: init.headers, body: init.body, redirect: 'manual', signal: controller.signal }),
      )
    } catch {
      return timedOut ? { kind: 'lost' } : { kind: 'network' }
    }
    const read = await readCapped(res, bounds.maxBytes)
    if (read.kind === 'failed') return { kind: 'lost' }
    return { kind: 'response', status: res.status, headers: res.headers, text: read.kind === 'ok' ? read.text : null, tooLarge: read.kind === 'too_large' }
  } finally {
    clearTimeout(timer)
  }
}

type Capped = { kind: 'ok'; text: string } | { kind: 'too_large' } | { kind: 'bad_utf8' } | { kind: 'failed' }

async function readCapped(res: Response, limit: number): Promise<Capped> {
  if (!res.body) return { kind: 'ok', text: '' }
  const declared = Number(res.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > limit) {
    await res.body.cancel().catch(() => {})
    return { kind: 'too_large' }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return { kind: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    return { kind: 'failed' }
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  try {
    return { kind: 'ok', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all) }
  } catch {
    return { kind: 'bad_utf8' }
  }
}

/** A JSON object, or null for anything else (never throws). */
export function jsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** `Retry-After` in seconds as milliseconds; absent or odd values give `fallbackMs`. */
export function retryAfterMs(headers: Headers, fallbackMs = 1000): number {
  const raw = headers.get('Retry-After')
  const s = raw === null ? NaN : Number(raw)
  return Number.isFinite(s) && s >= 0 && s <= 86_400 ? Math.ceil(s * 1000) : fallbackMs
}

/** Equal strings, compared without an early exit on the first difference. Both stay in the caller's locals. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
