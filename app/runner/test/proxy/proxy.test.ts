// The loopback proxy. Ways it could fail, written first:
// - it forwards for an unknown uid, a uid with no live run, root, or when the uid lookup itself fails;
// - it forwards without a token, or passes on a token (or key) the caller made up;
// - it forwards a route outside the six, or a path that climbs out of its route;
// - (P4 H1) `/hub/` asks for any token but the run's `mcp` one, or a hub path climbs out of `/hub/`;
// - (Stage 1, N6) `/actions/` asks for any token but the run's `mcp` one, doesn't tell the root it's `/actions/` (so a run
//   without actions can't be shut out of it), stays open once `mcp` has closed, or retries a
//   `tools/call` (a second send could propose the same write twice);
// - the token ends up in a log line;
// - a header outside the allowlist is forwarded;
// - the uid is looked up per request (or blocking) instead of once per connection;
// - the caller goes away and the upstream request carries on; the upstream cuts the body and the caller takes the
//   part for a whole one; an upstream that never answers holds the caller forever; a body of any size is forwarded.
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { fc, it } from '@fast-check/vitest'
import { afterAll, beforeAll, beforeEach, describe, expect, vi } from 'vitest'
import { MCP_HANDSHAKE_MAX_BODY_BYTES, MCP_HANDSHAKE_MAX_RESPONSE_BYTES, PROXY_MAX_CONNECTIONS, PROXY_MAX_CONNECTIONS_PER_UID, RUN_TOKEN_HEADER, createProxy, targetFor, type ProxyDeps } from '../../src/proxy/server.ts'
import { waitFor } from '../run/support/root-client.ts'

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
let seen: Seen[] = []
let logs: Record<string, unknown>[] = []
let callerUid: number | null | 'throw' = null
let tokens = new Map<number, string>()
let upstreamClosed: string[] = []
let lookups = 0
let upstream: http.Server
let upstreamUrl: URL
let proxy: http.Server
let proxyUrl = ''

async function makeProxy(opts: Partial<ProxyDeps> = {}): Promise<{ server: http.Server; url: string }> {
  const server = createProxy({
    upstream: upstreamUrl,
    lookupUid: async () => {
      lookups++
      if (callerUid === 'throw') throw new Error('no /proc here')
      return callerUid
    },
    tokenForUid: (uid) => tokens.get(uid) ?? null,
    log: (e) => logs.push(e),
    ...opts,
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    // /hold never answers; /cut sends half a body and drops the connection; anything else echoes what it saw.
    if (req.url!.endsWith('/hold')) {
      req.resume()
      req.on('close', () => upstreamClosed.push(req.url!))
      return
    }
    if (req.url!.endsWith('/cut')) {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
      res.write('half', () => res.socket!.destroy())
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'text/event-stream', [RUN_TOKEN_HEADER]: 'tok_from_upstream_xxxxxx' }).end('data: ok\n\n')
    })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamUrl = new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/egress`)
  ;({ server: proxy, url: proxyUrl } = await makeProxy())
})
afterAll(async () => {
  proxy.closeAllConnections()
  upstream.closeAllConnections()
  await new Promise((r) => proxy.close(r))
  await new Promise((r) => upstream.close(r))
})
beforeEach(() => {
  seen = []
  logs = []
  upstreamClosed = []
  lookups = 0
  tokens = new Map([[1001, 'tok_live_run_1001_aaaaaaaa'], [0, 'tok_root_must_never_be_used']])
  callerUid = 1001
})

// A fresh connection per request, so the per-connection uid cache never carries over between cases.
const call = (path: string, init: RequestInit = {}) => fetch(`${proxyUrl}${path}`, { ...init, headers: { connection: 'close', ...init.headers } })

describe('who may call', () => {
  it.each([
    ['an unknown caller', null],
    ['root', 0],
    ['a uid with no live run', 1002],
    ['a failed lookup', 'throw' as const],
  ])('%s gets 403, logged, and nothing is forwarded', async (_, uid) => {
    callerUid = uid
    const res = await call('/model/v1/messages', { method: 'POST', body: '{}' })
    expect(res.status).toBe(403)
    expect(seen).toHaveLength(0)
    expect(logs.length).toBeGreaterThan(0)
  })

  it.prop([fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }), fc.dictionary(fc.integer({ min: 0, max: 5 }).map(String), fc.stringMatching(/^tok_[a-z0-9]{20}$/))], {
    numRuns: 40,
  })('forwards if and only if the caller is a non-root uid with a live run, always with that run token', async (uid, table) => {
    seen = []
    callerUid = uid
    tokens = new Map(Object.entries(table).map(([k, v]) => [Number(k), v]))
    const res = await call('/store/append', { method: 'POST', body: 'x' })
    const expected = uid !== null && uid !== 0 ? tokens.get(uid) : undefined
    if (expected === undefined) {
      expect(res.status).toBe(403)
      expect(seen).toHaveLength(0)
    } else {
      expect(res.status).toBe(200)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.headers[RUN_TOKEN_HEADER]).toBe(expected)
    }
    expect(JSON.stringify(logs)).not.toMatch(/tok_/)
  })
})

describe('what is forwarded', () => {
  it('the path under the upstream base, the body, and the response stream; never the caller credentials', async () => {
    const res = await call('/model/v1/messages?beta=true', {
      method: 'POST',
      headers: { 'x-api-key': 'placeholder', authorization: 'Bearer made-up', [RUN_TOKEN_HEADER]: 'tok_forged_by_caller_xxxx', 'anthropic-version': '2023-06-01' },
      body: '{"model":"x"}',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('data: ok\n\n')
    expect(seen).toHaveLength(1)
    const s = seen[0]!
    expect(s).toMatchObject({ method: 'POST', url: '/egress/model/v1/messages?beta=true', body: '{"model":"x"}' })
    expect(s.headers[RUN_TOKEN_HEADER]).toBe('tok_live_run_1001_aaaaaaaa')
    expect(s.headers['x-api-key']).toBeUndefined()
    expect(s.headers.authorization).toBeUndefined()
    expect(s.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('(P4 H1) /hub/ is forwarded as it came, with the token the root gives for the mcp route', async () => {
    const asked: string[] = []
    const p = await makeProxy({ tokenForUid: (uid, route) => (asked.push(route), uid === 1001 && route === 'mcp' ? 'tok_mcp_route_1001_aaaaaaaa' : null) })
    try {
      const res = await fetch(`${p.url}/hub/`, { method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
      expect(res.status).toBe(200)
      expect(asked).toEqual(['mcp'])
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/egress/hub/', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
      expect(seen[0]!.headers[RUN_TOKEN_HEADER]).toBe('tok_mcp_route_1001_aaaaaaaa')
    } finally {
      p.server.closeAllConnections()
      await new Promise((r) => p.server.close(r))
    }
  })

  it('(N6) /actions/ is forwarded as it came, with the token the root gives for the mcp route, and closes with it', async () => {
    const asked: string[] = []
    let mcpOpen = true
    const came: string[] = []
    const p = await makeProxy({ tokenForUid: (uid, route, on) => (asked.push(route), came.push(on), uid === 1001 && route === 'mcp' && mcpOpen ? 'tok_mcp_route_1001_aaaaaaaa' : null) })
    try {
      const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
      const res = await fetch(`${p.url}/actions/`, { method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' }, body })
      expect(res.status).toBe(200)
      expect(asked).toEqual(['mcp'])
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/egress/actions/', body })
      expect(seen[0]!.headers[RUN_TOKEN_HEADER]).toBe('tok_mcp_route_1001_aaaaaaaa')
      // The run's mcp token closed: /actions/ closes with it (and /hub/ too), and nothing more is forwarded.
      mcpOpen = false
      for (const path of ['/actions/', '/hub/', '/mcp/']) {
        const closed = await fetch(`${p.url}${path}`, { method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' }, body })
        expect(closed.status).toBe(403)
      }
      expect(seen).toHaveLength(1)
      expect(asked).toEqual(['mcp', 'mcp', 'mcp', 'mcp'])
      // The proxy names the route each call came on, so the root can keep /actions/ shut for a run without actions.
      expect(came).toEqual(['actions', 'actions', 'hub', 'mcp'])
      // And says so in its log: /actions/ may be shut for a live run too.
      expect(logs.filter((l) => l.type === 'proxy_refused').map((l) => [l.route, l.reason])).toEqual([
        ['actions', "no live run with the actions server for this user (its start didn't ask for it, or its stream has ended)"],
        ['hub', 'no live run for this user (or its stream has ended)'],
        ['mcp', 'no live run for this user (or its stream has ended)'],
      ])
    } finally {
      p.server.closeAllConnections()
      await new Promise((r) => p.server.close(r))
    }
  })

  it.each(['/model', '/other/x', '/', 'http://elsewhere/model/x', '/MODEL/x', '/hub', '/hubx/', '/actions', '/actionsx/'])('%s: 404, nothing forwarded', async (path) => {
    const res = await new Promise<number>((resolve, reject) => {
      const u = new URL(proxyUrl)
      http.request({ host: u.hostname, port: u.port, path, method: 'GET', headers: { connection: 'close' } }, (r) => {
        r.resume()
        resolve(r.statusCode!)
      }).on('error', reject).end()
    })
    expect(res).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it.each(['/actions/../model/', '/actions/%2e%2e/files/x', '/hub/../model/', '/hub/%2e%2e/model/', '/model/../store/x', '/files/%2e%2e/x', '/mcp/a\\b', '/store/./x', '/model/..#x', '/model/.%2e#x', '/model/%23/../x', '/model/x#frag', '/model/..%23x', '/model/x?q=#..', '/model/..?x', '/files/a%2fb/%2E%2E?q=1'])('%s: 400, nothing forwarded', async (path) => {
    const res = await new Promise<number>((resolve, reject) => {
      const u = new URL(proxyUrl)
      http.request({ host: u.hostname, port: u.port, path, method: 'GET', headers: { connection: 'close' } }, (r) => {
        r.resume()
        resolve(r.statusCode!)
      }).on('error', reject).end()
    })
    expect(res).toBe(400)
    expect(seen).toHaveLength(0)
  })

  it('the query may carry an encoded # or dots: forwarded as sent', async () => {
    const res = await call('/model/v1/messages?q=%23x&r=%2e%2e&s=%5c', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(seen.map((s) => s.url)).toEqual(['/egress/model/v1/messages?q=%23x&r=%2e%2e&s=%5c'])
  })

  it('opens a non-keep-alive upstream connection per request', async () => {
    let upstreamSockets = 0
    const closingUpstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: '' })
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      })
    })
    // Destroy any socket kept alive right after its response finishes: a proxy pooling keep-alive sockets via
    // http.globalAgent hits ECONNRESET -> 502 when it reuses one.
    closingUpstream.on('connection', (socket) => {
      upstreamSockets++
      socket.setTimeout(10, () => socket.destroy())
    })
    await new Promise<void>((r) => closingUpstream.listen(0, '127.0.0.1', r))
    const p = await makeProxy({ upstream: new URL(`http://127.0.0.1:${(closingUpstream.address() as AddressInfo).port}/egress`) })
    try {
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`${p.url}/mcp/`, { method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' }, body: '{}' })
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('{"ok":true}')
        await new Promise((r) => setTimeout(r, 15))
      }
      expect(seen.map((s) => s.headers.connection)).toEqual(['close', 'close', 'close', 'close'])
      expect(upstreamSockets).toBe(4)
      expect(logs.filter((l) => l.type === 'proxy_upstream_error')).toEqual([])
    } finally {
      p.server.closeAllConnections()
      closingUpstream.closeAllConnections()
      await new Promise((r) => p.server.close(r))
      await new Promise((r) => closingUpstream.close(r))
    }
  })
})

describe('targetFor (the last check on where a path goes)', () => {
  const base = new URL('http://egress.internal/egress')
  it('keeps a path under the base and its route', () => {
    expect(targetFor(base, '/model/v1/messages?beta=true', 'model')?.href).toBe('http://egress.internal/egress/model/v1/messages?beta=true')
  })
  it.each(['/model/..#x', '/model/../x', '/model/./../store/x', '/model/x#y', '/model/%2e%2e/x/../../x'])('%s: refused', (path) => {
    expect(targetFor(base, path, 'model')).toBeNull()
  })
  it.prop([fc.webPath(), fc.constantFrom('model', 'mcp', 'store', 'files', 'hub', 'actions')])('anything it lets through sits under the base and the route', (path, route) => {
    const t = targetFor(base, `/${route}/${path.replace(/^\//, '')}`, route)
    if (t !== null) {
      expect(t.origin).toBe(base.origin)
      expect(t.pathname.startsWith(`/egress/${route}/`)).toBe(true)
      expect(t.hash).toBe('')
    }
  })
})

describe('connections', () => {
  // A keep-alive connection that has answered one request (so its uid is looked up and counted), or the error that
  // ended it.
  const connectAndAsk = async (url: string) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const u = new URL(url)
    const status = await new Promise<number | string>((resolve) => {
      http
        .request({ host: u.hostname, port: u.port, path: '/model/v1/x', method: 'GET', agent }, (r) => {
          r.resume()
          r.on('end', () => resolve(r.statusCode!))
        })
        .on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message))
        .end()
    })
    return { status, close: () => agent.destroy() }
  }

  it('the defaults: 1024 in all, 256 per session user', async () => {
    expect(proxy.maxConnections).toBe(PROXY_MAX_CONNECTIONS)
    expect(PROXY_MAX_CONNECTIONS).toBe(1024)
    expect(PROXY_MAX_CONNECTIONS_PER_UID).toBe(256)
  })

  // Counts the proxy's own sockets as they close (the proxy's listeners on the same `close` have run by then).
  const closes = (server: http.Server) => {
    const seenClose = { n: 0 }
    server.on('connection', (socket) => socket.once('close', () => seenClose.n++))
    return seenClose
  }

  it('past the overall cap, a new connection is dropped; once one closes, a new one is served', async () => {
    const small = await makeProxy({ maxConnections: 2 })
    const closed = closes(small.server)
    const open: { status: number | string; close: () => void }[] = []
    try {
      for (let i = 0; i < 2; i++) open.push(await connectAndAsk(small.url))
      expect(open.map((c) => c.status)).toEqual([200, 200])
      const refused = await connectAndAsk(small.url)
      refused.close()
      expect(refused.status).not.toBe(200)
      expect(seen).toHaveLength(2)
      open.shift()!.close()
      await waitFor(() => closed.n === 1, 'the proxy saw the close')
      const again = await connectAndAsk(small.url)
      open.push(again)
      expect(again.status).toBe(200)
    } finally {
      for (const c of open) c.close()
      small.server.closeAllConnections()
      await new Promise((r) => small.server.close(r))
    }
  })

  it('one session user past its own cap is refused (logged); another user still gets in; a closed one frees a slot', async () => {
    const small = await makeProxy({ maxConnectionsPerUid: 2 })
    const closed = closes(small.server)
    const open: { status: number | string; close: () => void }[] = []
    try {
      for (let i = 0; i < 2; i++) open.push(await connectAndAsk(small.url))
      expect(open.map((c) => c.status)).toEqual([200, 200])
      const third = await connectAndAsk(small.url)
      third.close()
      expect(third.status).not.toBe(200)
      expect(logs).toContainEqual({ type: 'proxy_refused', uid: 1001, reason: 'too many connections for this user' })
      expect(seen).toHaveLength(2)
      await waitFor(() => closed.n === 1, 'the refused socket closed')
      // Another session user is counted on its own.
      tokens.set(1002, 'tok_live_run_1002_bbbbbbbb')
      callerUid = 1002
      const other = await connectAndAsk(small.url)
      open.push(other)
      expect(other.status).toBe(200)
      // One of 1001's connections closes: once the proxy sees it, 1001 gets a slot back.
      callerUid = 1001
      open.shift()!.close()
      await waitFor(() => closed.n === 2, 'the proxy saw the close')
      const again = await connectAndAsk(small.url)
      open.push(again)
      expect(again.status).toBe(200)
    } finally {
      for (const c of open) c.close()
      small.server.closeAllConnections()
      await new Promise((r) => small.server.close(r))
    }
  })
})

describe('headers', () => {
  it('forwards only the allowlist (and the token the proxy adds); drops the token header on the way back', async () => {
    const res = await call('/mcp/x', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 's-1',
        'mcp-protocol-version': '2025-11-25',
        'last-event-id': 'e-9',
        'anthropic-beta': 'b1',
        'x-custom': 'nope',
        cookie: 'a=b',
        'x-forwarded-for': '1.2.3.4',
        'accept-encoding': 'gzip',
      },
      body: '{}',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get(RUN_TOKEN_HEADER)).toBeNull()
    const h = seen[0]!.headers
    expect(h).toMatchObject({ 'mcp-session-id': 's-1', 'mcp-protocol-version': '2025-11-25', 'last-event-id': 'e-9', 'anthropic-beta': 'b1' })
    for (const dropped of ['x-custom', 'cookie', 'x-forwarded-for', 'accept-encoding']) expect(h[dropped], dropped).toBeUndefined()
    expect(h[RUN_TOKEN_HEADER]).toBe('tok_live_run_1001_aaaaaaaa')
  })

  it("forwards a saved file's hash header (the egress checks the body against it)", async () => {
    const res = await call('/files/outputs/a.pdf', { method: 'PUT', headers: { 'content-type': 'application/pdf', 'x-inhouse-sha256': 'ab'.repeat(32) }, body: '%PDF-' })
    expect(res.status).toBe(200)
    expect(seen[0]!.headers['x-inhouse-sha256']).toBe('ab'.repeat(32))
  })
})

describe('the uid lookup', () => {
  it('runs once per connection, when it opens, not per request', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const get = () =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(proxyUrl)
        http.request({ host: u.hostname, port: u.port, path: '/model/v1/x', method: 'GET', agent }, (r) => {
          r.resume()
          r.on('end', () => resolve(r.statusCode!))
        }).on('error', reject).end()
      })
    expect(await get()).toBe(200)
    expect(await get()).toBe(200)
    agent.destroy()
    expect(lookups).toBe(1)
  })
})

describe('streams that break', () => {
  it('the caller goes away: the upstream request is dropped', async () => {
    const ac = new AbortController()
    const reached = new Promise<void>((r) => upstream.once('request', () => r()))
    const pending = call('/model/hold', { method: 'POST', body: 'x', signal: ac.signal })
    await reached
    ac.abort()
    await expect(pending).rejects.toThrow()
    await waitFor(() => upstreamClosed.length === 1, 'upstream request closed')
  })

  it('the upstream cuts the body: the caller is cut too, and it is logged', async () => {
    const res = await call('/model/cut')
    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toThrow()
    await waitFor(() => logs.some((l) => l.type === 'proxy_upstream_error'))
  })

  it('an upstream that never answers times out with 504', async () => {
    const short = await makeProxy({ upstreamTimeoutMs: 50 })
    try {
      const res = await fetch(`${short.url}/model/hold`, { method: 'POST', body: 'x', headers: { connection: 'close' } })
      expect(res.status).toBe(504)
      expect(logs).toContainEqual(expect.objectContaining({ type: 'proxy_upstream_error', error: 'upstream timeout' }))
    } finally {
      short.server.closeAllConnections()
      await new Promise((r) => short.server.close(r))
    }
  })

  it.each([
    ['with a content-length', 'fixed'],
    ['chunked', 'chunked'],
  ])('a body over the cap gets 413 (%s), nothing forwarded whole', async (_, framing) => {
    const small = await makeProxy({ maxBodyBytes: 1024 })
    try {
      const body = 'x'.repeat(4096)
      const status = await new Promise<number>((resolve, reject) => {
        const u = new URL(small.url)
        const headers: Record<string, string> = { connection: 'close' }
        if (framing === 'fixed') headers['content-length'] = String(body.length)
        const req = http.request({ host: u.hostname, port: u.port, path: '/files/x', method: 'POST', headers }, (r) => {
          r.resume()
          resolve(r.statusCode!)
        })
        req.on('error', reject)
        if (framing === 'chunked') {
          req.write(body.slice(0, 2048))
          req.end(body.slice(2048))
        } else req.end(body)
      })
      expect(status).toBe(413)
      expect(seen).toHaveLength(0)
    } finally {
      small.server.closeAllConnections()
      await new Promise((r) => small.server.close(r))
    }
  })
})

describe('MCP startup handshake retries', () => {
  const rpc = (method: string, id?: number) => JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method })

  async function withFlakyUpstream(
    onRequest: (attempt: number, req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
    proxyOpts: Partial<ProxyDeps> = {},
  ) {
    let attempts = 0
    const flaky = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        attempts++
        onRequest(attempts, req, res, Buffer.concat(chunks))
      })
    })
    await new Promise<void>((r) => flaky.listen(0, '127.0.0.1', r))
    const p = await makeProxy({
      upstream: new URL(`http://127.0.0.1:${(flaky.address() as AddressInfo).port}/egress`),
      mcpRetryDelaysMs: [5, 5],
      ...proxyOpts,
    })
    const close = async () => {
      p.server.closeAllConnections()
      flaky.closeAllConnections()
      await new Promise((r) => p.server.close(r))
      await new Promise((r) => flaky.close(r))
    }
    return { server: p.server, url: p.url, attempts: () => attempts, close }
  }

  it.each([
    ['/mcp/', 'initialize', 'reset'],
    ['/mcp/', 'tools/list', '502'],
    ['/hub/', 'tools/list', '503'],
    ...['initialize', 'notifications/initialized', 'tools/list', 'ping'].map(method => ['/mcp/', method, '500'] as const),
    ['/mcp/', 'notifications/initialized', '503'],
    ['/hub/', 'tools/list', 'cut'],
    ['/hub/', 'ping', '504'],
    ['/actions/', 'initialize', '503'],
    ['/actions/', 'tools/list', 'reset'],
  ] as const)('retries %s %s after transient %s and recovers', async (routePath, method, mode) => {
    const u = await withFlakyUpstream((n, _req, res) => {
      if (n === 1) {
        if (mode === 'reset') return void res.socket!.destroy()
        if (mode === 'cut') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' })
          res.write('{"jsonrpc":', () => res.socket!.destroy())
          return
        }
        res.writeHead(Number(mode), { 'content-type': 'application/json' }).end('{"error":"transient"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', [RUN_TOKEN_HEADER]: 'tok_must_not_leak_xxxxxxx' }).end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
    })
    try {
      const res = await fetch(`${u.url}${routePath}`, {
        method: 'POST',
        headers: { connection: 'close', 'content-type': 'application/json' },
        body: rpc(method, method === 'notifications/initialized' ? undefined : 1),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get(RUN_TOKEN_HEADER)).toBeNull()
      expect(await res.text()).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
      expect(u.attempts()).toBe(2)
      expect(logs.some((l) => l.type === 'proxy_upstream_error')).toBe(true)
      expect(JSON.stringify(logs)).not.toMatch(/tok_/)
    } finally {
      await u.close()
    }
  })

  it.each([
    ['/mcp/', 'reset'],
    ['/mcp/', '500'],
    ['/mcp/', '503'],
    ['/actions/', 'reset'],
    ['/actions/', '502'],
    ['/actions/', '503'],
    ['/actions/', '504'],
  ] as const)('never retries tools/call on %s after transient %s', async (routePath, mode) => {
    const u = await withFlakyUpstream((_n, _req, res) => {
      if (mode === 'reset') return void res.socket!.destroy()
      res.writeHead(Number(mode), { 'content-type': 'application/json' }).end('{"error":"busy"}')
    })
    try {
      const res = await fetch(`${u.url}${routePath}`, {
        method: 'POST',
        headers: { connection: 'close', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_save', arguments: {} } }),
      })
      expect(res.status).toBe(mode === 'reset' ? 502 : Number(mode))
      expect(u.attempts()).toBe(1)
    } finally {
      await u.close()
    }
  })

  it('rechecks tokenForUid before retrying so a closed run is refused with 403 instead of retried', async () => {
    let allowToken = true
    const u = await withFlakyUpstream(
      (_n, _req, res) => {
        allowToken = false
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"transient"}')
      },
      { tokenForUid: (uid) => (allowToken && uid === 1001 ? 'tok_live_run_1001_aaaaaaaa' : null) },
    )
    try {
      const res = await fetch(`${u.url}/mcp/`, {
        method: 'POST',
        headers: { connection: 'close', 'content-type': 'application/json' },
        body: rpc('tools/list', 1),
      })
      expect(res.status).toBe(403)
      expect(u.attempts()).toBe(1)
    } finally {
      await u.close()
    }
  })

  function post(url: string, body: string, signal?: AbortSignal) {
    return fetch(`${url}/mcp/`, {
      method: 'POST',
      headers: { connection: 'close', 'content-type': 'application/json' },
      body,
      signal,
    })
  }

  it('closes the stalled 503 socket and replays the exact body bytes and headers', async () => {
    const closed = Promise.withResolvers<void>()
    const requests: { body: Buffer; headers: string[] }[] = []
    const body = '{ "jsonrpc": "2.0", "id": "café", "method": "tools/list" }'
    const u = await withFlakyUpstream((n, req, res, bytes) => {
      requests.push({ body: bytes, headers: req.rawHeaders })
      if (n === 1) {
        req.socket.once('close', () => closed.resolve())
        res.writeHead(503).flushHeaders()
      } else {
        res.end('ok')
      }
    })
    try {
      const res = await post(u.url, body)
      expect(await res.text()).toBe('ok')
      await closed.promise
      expect(requests).toHaveLength(2)
      expect(requests[0]?.body).toEqual(Buffer.from(body))
      expect(requests[1]).toEqual(requests[0])
    } finally {
      await u.close()
    }
  })

  it('returns the upstream failure when the run token changes during backoff', async () => {
    const closed = Promise.withResolvers<void>()
    const u = await withFlakyUpstream((_n, req, res) => {
      req.socket.once('close', () => closed.resolve())
      res.writeHead(503).flushHeaders()
    }, { mcpRetryDelaysMs: [150] })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = post(u.url, rpc('tools/list', 1))
      await closed.promise
      tokens.set(1001, 'tok_replacement_run_bbbbbbbb')
      await vi.advanceTimersByTimeAsync(150)
      const res = await pending
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'upstream failed' })
      expect(u.attempts()).toBe(1)
    } finally {
      vi.useRealTimers()
      await u.close()
    }
  })

  it('clears the retry timer when the caller disconnects during backoff', async () => {
    const upstreamClosed = Promise.withResolvers<void>()
    const u = await withFlakyUpstream((_n, req, res) => {
      req.socket.once('close', () => upstreamClosed.resolve())
      res.writeHead(503).flushHeaders()
    }, { mcpRetryDelaysMs: [100] })
    const callerClosed = Promise.withResolvers<void>()
    u.server.once('request', (_req, res) => res.once('close', () => callerClosed.resolve()))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const caller = http.request(`${u.url}/mcp/`, { method: 'POST', agent: false })
      const error = once(caller, 'error')
      caller.end(rpc('initialize', 1))
      await upstreamClosed.promise
      expect(vi.getTimerCount()).toBe(1)
      caller.destroy()
      await Promise.all([error, callerClosed.promise])
      expect(vi.getTimerCount()).toBe(0)
      expect(u.attempts()).toBe(1)
    } finally {
      vi.useRealTimers()
      await u.close()
    }
  })

  it('streams a chunked handshake over the buffer cap with its entire prefix and never retries it', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { pad: 'x'.repeat(MCP_HANDSHAKE_MAX_BODY_BYTES) } })
    const requests: Buffer[] = []
    const u = await withFlakyUpstream((_n, req, res, bytes) => {
      expect(req.headers['transfer-encoding']).toBe('chunked')
      requests.push(bytes)
      res.writeHead(503).end('busy')
    })
    try {
      const caller = http.request(`${u.url}/mcp/`, { method: 'POST', agent: false })
      const response = once(caller, 'response')
      caller.write(body.slice(0, 1024))
      caller.write(body.slice(1024, -2))
      caller.end(body.slice(-2))
      const [res] = await response
      res.resume()
      await once(res, 'end')
      expect(res.statusCode).toBe(503)
      expect(requests).toEqual([Buffer.from(body)])
    } finally {
      await u.close()
    }
  })

  it('rejects a chunked handshake over maxBodyBytes with 413', async () => {
    const small = await makeProxy({ maxBodyBytes: 64 })
    try {
      const caller = http.request(`${small.url}/mcp/`, { method: 'POST', agent: false })
      const response = once(caller, 'response')
      caller.write(rpc('initialize', 1))
      caller.end(' '.repeat(64))
      const [res] = await response
      res.resume()
      await once(res, 'end')
      expect(res.statusCode).toBe(413)
      expect(seen).toHaveLength(0)
    } finally {
      small.server.closeAllConnections()
      await new Promise((r) => small.server.close(r))
    }
  })

  it('never retries a JSON-RPC batch, even when every method is read-only', async () => {
    const u = await withFlakyUpstream((_n, _req, res) => res.writeHead(500).end('busy'))
    try {
      const res = await post(u.url, `[${rpc('initialize', 1)},${rpc('ping', 2)}]`)
      expect(res.status).toBe(500)
      expect(await res.text()).toBe('busy')
      expect(u.attempts()).toBe(1)
    } finally {
      await u.close()
    }
  })

  it('destroys the caller connection if a response over the buffer cap is cut mid-body', async () => {
    const socket = Promise.withResolvers<NonNullable<http.ServerResponse['socket']>>()
    const bytes = MCP_HANDSHAKE_MAX_RESPONSE_BYTES + 1
    const u = await withFlakyUpstream((_n, _req, res) => {
      socket.resolve(res.socket!)
      res.writeHead(200, { 'content-length': String(bytes + 100) })
      res.write(Buffer.alloc(bytes))
    })
    try {
      const res = await post(u.url, rpc('tools/list', 1))
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      let received = 0
      while (received < bytes) {
        const chunk = await reader.read()
        expect(chunk.done).toBe(false)
        received += chunk.value!.length
      }
      ;(await socket.promise).destroy()
      await expect(reader.read()).rejects.toThrow()
      expect(u.attempts()).toBe(1)
    } finally {
      await u.close()
    }
  })

  it('still enforces maxBodyBytes (413) on /mcp/ and /hub/', async () => {
    const small = await makeProxy({ maxBodyBytes: 64 })
    try {
      const res = await fetch(`${small.url}/mcp/`, {
        method: 'POST',
        headers: { connection: 'close', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { pad: 'x'.repeat(128) } }),
      })
      expect(res.status).toBe(413)
      expect(seen).toHaveLength(0)
    } finally {
      small.server.closeAllConnections()
      await new Promise((r) => small.server.close(r))
    }
  })
})
