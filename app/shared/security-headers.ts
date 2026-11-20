// The site's security headers on Worker responses. `_headers` applies only to static assets, never to what a Worker
// returns, so each Worker (the demo's worker/, the product's server/) imports `../public/_headers?raw` itself, parses
// its `/*` block once with `parseHeaders` and sends every response through `withSecurityHeaders`.

/** The `/*` block of a `_headers` file, as [name, value] pairs. Throws when it has none, so a renamed block fails loud. */
export function parseHeaders(file: string): [string, string][] {
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

/** `headers` with the security headers set on it and `Cache-Control: no-store` (a Worker's answer is never cached). */
export function securityHeaders(security: readonly [string, string][], init?: HeadersInit): Headers {
  const headers = new Headers(init)
  for (const [name, value] of security) headers.set(name, value)
  headers.set('Cache-Control', 'no-store')
  return headers
}

/** A Worker response with the security headers. */
export function respond(security: readonly [string, string][], status: number, init: { headers?: HeadersInit; body?: BodyInit | null } = {}): Response {
  return new Response(init.body ?? null, { status, headers: securityHeaders(security, init.headers) })
}

/**
 * The same response with the security headers added: for an asset or a handler's own Response. A WebSocket upgrade (a
 * 101 with `webSocket`, Workers only; the DOM's Response has no such field, hence the widened type) keeps its socket and
 * status: without it the rebuilt 101 has no socket and the runtime refuses it. The demo Worker never upgrades.
 */
export function withSecurityHeaders(security: readonly [string, string][], response: Response): Response {
  const { webSocket } = response as Response & { webSocket?: unknown }
  const init = { status: response.status, statusText: response.statusText, headers: securityHeaders(security, response.headers), ...(webSocket ? { webSocket } : {}) }
  return new Response(response.body, init as ResponseInit)
}
