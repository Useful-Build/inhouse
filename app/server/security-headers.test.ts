// shared/security-headers.ts's withSecurityHeaders in the Workers runtime: a WebSocket upgrade's 101 keeps its socket
// and status through the rebuild and gets the security headers (W1's upgrade helper's answer goes through it).
import { expect, test } from 'vitest'
import { withSecurityHeaders } from '../shared/security-headers.ts'
import { SECURITY_HEADERS } from './http.ts'

test('a 101 with a WebSocketPair end keeps its socket and gets the security headers', () => {
  const [client, server] = Object.values(new WebSocketPair())
  server.accept()
  const res = withSecurityHeaders(SECURITY_HEADERS, new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'probe' } }))
  expect(res.status).toBe(101)
  expect(res.webSocket).toBe(client)
  expect(res.headers.get('Sec-WebSocket-Protocol')).toBe('probe')
  expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(res.headers.get('Cache-Control')).toBe('no-store')
  server.close()
})

test('any other response has no socket and keeps its status', () => {
  const res = withSecurityHeaders(SECURITY_HEADERS, new Response('x', { status: 418 }))
  expect(res.status).toBe(418)
  expect(res.webSocket).toBeNull()
})
