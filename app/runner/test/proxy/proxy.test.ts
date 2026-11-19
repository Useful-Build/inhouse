// The loopback proxy. Ways it could fail, written first:
// - it forwards for an unknown uid, a uid with no live run, root, or when the uid lookup itself fails;
// - it forwards without a token, or passes on a token (or key) the caller made up;
// - it forwards a route outside the four, or a path that climbs out of its route;
// - the token ends up in a log line.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fc, it } from '@fast-check/vitest'
import { afterAll, beforeAll, beforeEach, describe, expect } from 'vitest'
import { RUN_TOKEN_HEADER, createProxy } from '../../src/proxy/server.ts'

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
let seen: Seen[] = []
let logs: Record<string, unknown>[] = []
let callerUid: number | null | 'throw' = null
let tokens = new Map<number, string>()
let upstream: http.Server
let proxy: http.Server
let proxyUrl = ''

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: ok\n\n')
    })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  const up = upstream.address() as AddressInfo
  proxy = createProxy({
    upstream: new URL(`http://127.0.0.1:${up.port}/egress`),
    lookupUid: () => {
      if (callerUid === 'throw') throw new Error('no /proc here')
      return callerUid
    },
    tokenForUid: (uid) => tokens.get(uid) ?? null,
    log: (e) => logs.push(e),
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise((r) => proxy.close(r))
  await new Promise((r) => upstream.close(r))
})
beforeEach(() => {
  seen = []
  logs = []
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

  it.each(['/model', '/other/x', '/', 'http://elsewhere/model/x', '/MODEL/x'])('%s: 404, nothing forwarded', async (path) => {
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

  it.each(['/model/../store/x', '/files/%2e%2e/x', '/mcp/a\\b', '/store/./x'])('%s: 400, nothing forwarded', async (path) => {
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
})
