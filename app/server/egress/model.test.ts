// The model route (p3-design 8.1-8.3) against W1's fake BrandAgentRpc and a recording upstream. Expected requests,
// headers and amounts are literals. Ways it can fail, written down first:
//  1. the gateway request carries an `x-api-key`, the run token or a caller's credentials, or misses a cf-aig header;
//  2. a noisy upstream's extra headers, internal error detail or a redirect reach the caller;
//  3. the count is asked about the whole body (not the projection), a small body is counted, a 4xx count blocks the
//     call, or a 5xx count lets it through;
//  4. a call starts upstream before its grant is confirmed, or a cancelled waiter confirms;
//  5. a call is closed twice, never, or not at its worst case when cut (abort, cancel, renew `gone`);
//  6. more upstream requests than granted slots; a refusal answered 429 (the CLI retries those);
//  7. a model switched off mid-turn, or one outside the grant, still runs; the CLI's counts pass 50.
import { describe, expect, it } from 'vitest'
import type { AdmitAnswer, ModelCallWorst } from '../do/brand-agent/ports.ts'
import { gatewayRequest, gatewayUpstream } from './gateway.ts'
import { handleEgress } from './index.ts'
import { deferred, egressRequest, GRANT, harness, sseFeed, TOKEN, until } from './testing/harness.ts'
import type { Harness } from './testing/harness.ts'

const MSG = '/model/v1/messages'
const small = { model: 'claude-sonnet-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] }
const call = (h: Harness, body: unknown = small, init: { signal?: AbortSignal; headers?: Record<string, string> } = {}) =>
  handleEgress(egressRequest(MSG, { body, ...init }), h.deps)
const json = async (r: Response) => (await r.json()) as { type?: string; error?: { type: string; message: string } }
const settle = (h: Harness) => Promise.all(h.waits)

describe('the gateway request (failure 1)', () => {
  it('is exactly this: the binding URL + /v1/messages, the cf-aig headers, no x-api-key, no token', async () => {
    const forwarded = new Headers({ 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'x-api-key': 'sk-caller', authorization: 'Bearer caller' })
    const req = gatewayRequest('https://gateway.ai.cloudflare.com/v1/acct-test/gw-test/anthropic/', '/v1/messages', { body: '{"a":1}', headers: forwarded, signal: new AbortController().signal }, 'gw-token-test')
    expect(req.url).toBe('https://gateway.ai.cloudflare.com/v1/acct-test/gw-test/anthropic/v1/messages')
    expect(req.method).toBe('POST')
    expect(req.redirect).toBe('manual')
    expect([...req.headers].sort()).toEqual([
      ['anthropic-version', '2023-06-01'], ['cf-aig-authorization', 'Bearer gw-token-test'], ['cf-aig-collect-log-payload', 'false'],
      ['cf-aig-max-attempts', '1'], ['cf-aig-skip-cache', 'true'], ['content-type', 'application/json'],
    ])
    expect(await req.text()).toBe('{"a":1}')
  })

  it('through the route: the body clamped, only the Messages headers forwarded, the run token nowhere', async () => {
    const seen: Request[] = []
    const ai = { gateway: (id: string) => ({ getUrl: async (p: string) => `https://gateway.ai.cloudflare.com/v1/acct-test/${id}/${p}` }) }
    const fetcher = (async (r: Request) => {
      seen.push(r)
      // max_tokens clamped to 32,000 puts the worst case over the start hold, so the gate counts first.
      if (r.url.endsWith('/count_tokens')) return Response.json({ input_tokens: 5 })
      return Response.json({ type: 'message', usage: { input_tokens: 1, output_tokens: 1 } })
    }) as unknown as typeof fetch
    const h = await harness()
    h.deps.upstream = gatewayUpstream({ AI: ai, AI_GATEWAY_ID: 'gw-test', AI_GATEWAY_TOKEN: 'gw-token-test' }, fetcher)
    const res = await call(h, { ...small, max_tokens: 99_999 }, { headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'claude-code-20250219, interleaved-thinking-2025-05-14', 'x-api-key': 'sk-x', cookie: 'c=1', 'x-forwarded-for': '10.0.0.1' } })
    expect(res.status).toBe(200)
    expect(seen.map(x => x.url)).toEqual([
      'https://gateway.ai.cloudflare.com/v1/acct-test/gw-test/anthropic/v1/messages/count_tokens',
      'https://gateway.ai.cloudflare.com/v1/acct-test/gw-test/anthropic/v1/messages',
    ])
    const r = seen[1]!
    expect(r.url).toBe('https://gateway.ai.cloudflare.com/v1/acct-test/gw-test/anthropic/v1/messages')
    expect([...r.headers].sort()).toEqual([
      ['anthropic-beta', 'claude-code-20250219,interleaved-thinking-2025-05-14'], ['anthropic-version', '2023-06-01'], ['cf-aig-authorization', 'Bearer gw-token-test'],
      ['cf-aig-collect-log-payload', 'false'], ['cf-aig-max-attempts', '1'], ['cf-aig-skip-cache', 'true'], ['content-type', 'application/json'],
    ])
    const sent = await r.text()
    expect(JSON.parse(sent)).toEqual({ ...small, max_tokens: 32_000 })
    expect(sent).not.toContain(TOKEN)
    expect(JSON.stringify([...r.headers])).not.toContain(TOKEN)
  })
})

describe('a noisy upstream (failure 2)', () => {
  const noisyHeaders = { 'content-type': 'application/json', 'request-id': 'req_1', 'retry-after': '3', 'anthropic-ratelimit-requests-remaining': '9', 'set-cookie': 'a=b', 'cf-ray': 'ray-internal', 'x-internal-host': '10.1.2.3', server: 'internal' }
  it('passes only allowlisted headers and the mapped error shape', async () => {
    const h = await harness()
    h.answer = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'pod 10.1.2.3 db=prod failed', trace: 'stack...' }, internal: { host: 'x' } }), { status: 500, headers: noisyHeaders })
    const res = await call(h)
    expect(res.status).toBe(500)
    expect([...res.headers].sort()).toEqual([
      ['anthropic-ratelimit-requests-remaining', '9'], ['content-type', 'application/json'], ['request-id', 'req_1'], ['retry-after', '3'],
    ])
    expect(await res.json()).toEqual({ type: 'error', error: { type: 'api_error', message: 'The model service failed.' } })
  })
  it("passes an invalid_request_error's own message (the CLI reads it), single-line and capped", async () => {
    const h = await harness()
    h.answer = async () => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long:\n 210000 tokens' } }, { status: 400 })
    expect(await json(await call(h))).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens' } })
  })
  it('a body that is not the documented shape gets the fixed message', async () => {
    const h = await harness()
    h.answer = async () => Response.json([{ code: 2044, message: 'account acct-test has no key' }], { status: 400 })
    expect(await json(await call(h))).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'The model refused the request.' } })
  })
  it('a 3xx is a 502, and the call closes at zero', async () => {
    const h = await harness()
    h.answer = async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.test/' } })
    const res = await call(h)
    expect(res.status).toBe(502)
    expect(res.headers.get('location')).toBeNull()
    await settle(h)
    expect(h.rpc.callsOf('releaseModelCall').map(c => c.args[2])).toEqual([{ usage: { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0, micro: 0 }, cut: false }])
  })
})

describe('the worst case and the count (failure 3)', () => {
  const big = { model: 'claude-sonnet-5-5', max_tokens: 1000, stream: true, metadata: { user_id: 'u' }, system: 's', messages: [{ role: 'user', content: 'x'.repeat(130_000) }], tools: [{ name: 'Bash', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'web_search', max_uses: 2 }] }
  it('a small body is never counted: its worst case fits the start hold', async () => {
    const h = await harness()
    await call(h)
    expect(h.upstreamCalls.map(c => c.path)).toEqual(['/v1/messages'])
    const len = new TextEncoder().encode('{"messages":[{"role":"user","content":"hi"}]}').length
    // Sonnet: len × $2 + 1,000 × $10 per MTok, rounded up.
    expect(h.rpc.callsOf('admitModelCall')[0]!.args[2]).toEqual({ model: 'claude-sonnet-5-5', inputTokens: len, maxTokens: 1000, modifiers: { rate: 'input', searchUses: 0, fast: false }, micro: Math.ceil(len * 2 + 10_000) })
  })
  it('a big body counts the projection: its fields only, server tools out; I = ceil(count × 1.1) + 1,000, + 10,000 a search', async () => {
    const h = await harness()
    h.answer = async c => (c.path === '/v1/messages/count_tokens' ? Response.json({ input_tokens: 40_000 }) : Response.json({ usage: {} }))
    await call(h, big)
    expect(h.upstreamCalls.map(c => c.path)).toEqual(['/v1/messages/count_tokens', '/v1/messages'])
    expect(JSON.parse(h.upstreamCalls[0]!.body)).toEqual({ model: 'claude-sonnet-5-5', system: 's', messages: big.messages, tools: [{ name: 'Bash', input_schema: { type: 'object' } }] })
    // 44,000 + 1,000 + 2 × 10,000 = 65,000 tokens × $2 + 1,000 × $10 per MTok + 2 × $0.01.
    expect(h.rpc.callsOf('admitModelCall')[0]!.args[2]).toEqual({ model: 'claude-sonnet-5-5', inputTokens: 65_000, maxTokens: 1000, modifiers: { rate: 'input', searchUses: 2, fast: false }, micro: 160_000 })
  })
  it('a 4xx count falls back to the byte bound; a 5xx is 503 and nothing is admitted', async () => {
    const h = await harness()
    h.answer = async c => (c.path === '/v1/messages/count_tokens' ? Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'no' } }, { status: 400 }) : Response.json({ usage: {} }))
    expect((await call(h, big)).status).toBe(200)
    const worst = h.rpc.callsOf('admitModelCall')[0]!.args[2] as ModelCallWorst
    expect(worst.inputTokens).toBeGreaterThan(130_000 + 20_000)
    const h5 = await harness()
    h5.answer = async () => new Response('down', { status: 503 })
    const res = await call(h5, big)
    expect(res.status).toBe(503)
    expect(h5.rpc.callsOf('admitModelCall')).toEqual([])
    expect(h5.upstreamCalls.map(c => c.path)).toEqual(['/v1/messages/count_tokens'])
  })
  it('a literal 650,001-token input is refused with 400 before any call; 650,000 is admitted', async () => {
    const prefix = '{"messages":[{"role":"user","content":"'
    const suffix = '"}]}'
    const sized = (total: number) => ({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'y'.repeat(total - prefix.length - suffix.length) }] })
    const count400 = async (c: { path: string }) => (c.path === '/v1/messages/count_tokens' ? new Response('{}', { status: 400 }) : Response.json({ usage: {} }))
    const over = await harness()
    over.answer = count400
    const res = await call(over, sized(650_001))
    expect(res.status).toBe(400)
    expect((await json(res)).error?.type).toBe('invalid_request_error')
    expect(over.rpc.callsOf('admitModelCall')).toEqual([])
    expect(over.upstreamCalls.map(c => c.path)).toEqual(['/v1/messages/count_tokens'])
    const at = await harness()
    at.answer = count400
    expect((await call(at, sized(650_000))).status).toBe(200)
    expect((at.rpc.callsOf('admitModelCall')[0]!.args[2] as ModelCallWorst).inputTokens).toBe(650_000)
  })
})

describe('admission and the lease (failures 4, 5)', () => {
  it('confirms with one renew before the upstream request, then closes once with the tally', async () => {
    const h = await harness()
    const order: string[] = []
    const renew = h.rpc.renewModelCall.bind(h.rpc)
    h.rpc.renewModelCall = async (...a) => (order.push('renew'), renew(...a))
    h.answer = async () => (order.push('upstream'), Response.json({ usage: { input_tokens: 1000, output_tokens: 500 } }))
    expect((await call(h)).status).toBe(200)
    await settle(h)
    expect(order).toEqual(['renew', 'upstream'])
    expect(h.rpc.callsOf('renewModelCall')[0]!.args).toEqual(['t_turn1', 'c_1', { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0, micro: 0 }])
    expect(h.rpc.callsOf('releaseModelCall').map(c => c.args)).toEqual([['t_turn1', 'c_1', { usage: { inputTokens: 1000, outputTokens: 500, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0, micro: 7_000 }, cut: false }]])
  })

  it('a stream with three cumulative deltas closes at its last values; renews carry the running usage', async () => {
    const h = await harness()
    const feed = sseFeed()
    h.answer = async () => new Response(feed.stream, { headers: { 'content-type': 'text/event-stream' } })
    const res = await call(h, { ...small, stream: true })
    const reader = res.body!.getReader()
    feed.send({ type: 'message_start', message: { usage: { input_tokens: 2000, cache_read_input_tokens: 10000, output_tokens: 1 } } })
    feed.send({ type: 'message_delta', usage: { output_tokens: 50 } })
    await reader.read()
    await reader.read()
    h.intervals[0]!()
    await until(() => h.rpc.callsOf('renewModelCall').length === 2, 'the 20 s renew')
    // Sonnet: 2,000 × $2 + 10,000 × $0.10 + 50 × $10 per MTok.
    expect((h.rpc.callsOf('renewModelCall')[1]!.args[2] as { micro: number }).micro).toBe(5_500)
    feed.send({ type: 'message_delta', usage: { output_tokens: 120 } })
    feed.send({ type: 'message_delta', usage: { input_tokens: 2000, output_tokens: 300 } })
    feed.send({ type: 'message_stop' })
    feed.end()
    while (!(await reader.read()).done) { /* drain */ }
    await settle(h)
    const end = h.rpc.callsOf('releaseModelCall').map(c => c.args[2])
    expect(end).toEqual([{ usage: { inputTokens: 2000, outputTokens: 300, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 10000, webSearches: 0, micro: 8_000 }, cut: false }])
  })

  it('the client aborts mid-stream: the upstream is aborted and the call closes cut, at its admitted worst case', async () => {
    const h = await harness()
    const feed = sseFeed()
    h.answer = async () => new Response(feed.stream, { headers: { 'content-type': 'text/event-stream' } })
    const ac = new AbortController()
    const res = await call(h, { ...small, stream: true }, { signal: ac.signal })
    const reader = res.body!.getReader()
    feed.send({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })
    await reader.read()
    ac.abort()
    await settle(h)
    const worst = h.rpc.callsOf('admitModelCall')[0]!.args[2] as ModelCallWorst
    expect(h.upstreamCalls[0]!.signal.aborted).toBe(true)
    const releases = h.rpc.callsOf('releaseModelCall')
    expect(releases).toHaveLength(1)
    expect(releases[0]!.args[2]).toMatchObject({ cut: true, usage: { inputTokens: 10, micro: worst.micro } })
  })

  it('the caller cancels the response body: the same cut close', async () => {
    const h = await harness()
    const feed = sseFeed()
    h.answer = async () => new Response(feed.stream, { headers: { 'content-type': 'text/event-stream' } })
    const res = await call(h, { ...small, stream: true })
    await res.body!.cancel()
    await settle(h)
    expect(h.rpc.callsOf('releaseModelCall').map(c => (c.args[2] as { cut: boolean }).cut)).toEqual([true])
    expect(h.upstreamCalls[0]!.signal.aborted).toBe(true)
  })

  it('cancelled while waiting inside admitModelCall: no confirm, no upstream, nothing to close', async () => {
    const h = await harness()
    const gate = deferred<AdmitAnswer>()
    h.rpc.admitAnswer = () => gate.promise
    const ac = new AbortController()
    const pending = call(h, small, { signal: ac.signal })
    await until(() => h.rpc.callsOf('admitModelCall').length === 1, 'admission asked')
    ac.abort()
    gate.resolve({ granted: true })
    expect((await pending).status).toBe(499)
    expect(h.rpc.callsOf('renewModelCall')).toEqual([])
    expect(h.upstreamCalls).toEqual([])
    expect(h.waits).toEqual([])
  })

  it('a renew answered gone aborts the upstream fetch at once', async () => {
    const h = await harness()
    const feed = sseFeed()
    h.answer = async () => new Response(feed.stream, { headers: { 'content-type': 'text/event-stream' } })
    const res = await call(h, { ...small, stream: true })
    const reader = res.body!.getReader()
    feed.send({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })
    await reader.read()
    h.rpc.renewAnswer = { gone: true }
    h.rpc.releaseAnswer = { gone: true }
    h.intervals[0]!()
    await until(() => h.upstreamCalls[0]!.signal.aborted, 'the upstream aborted')
    await settle(h)
    // The close still goes out once; the BrandAgent answers gone and prices nothing more.
    expect(h.rpc.callsOf('releaseModelCall').map(c => (c.args[2] as { cut: boolean }).cut)).toEqual([true])
  })

  it('a confirm answered gone sends nothing upstream', async () => {
    const h = await harness()
    h.rpc.renewAnswer = { gone: true }
    expect((await call(h)).status).toBe(503)
    expect(h.upstreamCalls).toEqual([])
  })
})

describe('the gate (failure 6)', () => {
  /** A reference gate, written apart from W1's: 4 slots per turn, FIFO, a slot freed by its call's release. */
  function fourSlots(h: Harness) {
    let inFlight = 0
    const waiting: (() => void)[] = []
    h.rpc.admitAnswer = async () => {
      if (inFlight >= 4) await new Promise<void>(r => waiting.push(r))
      inFlight++
      return { granted: true }
    }
    const release = h.rpc.releaseModelCall.bind(h.rpc)
    h.rpc.releaseModelCall = async (...a) => {
      inFlight--
      waiting.shift()?.()
      return release(...a)
    }
  }

  it('five concurrent calls: four upstream requests, the fifth held until one closes', async () => {
    const h = await harness()
    fourSlots(h)
    const holds = Array.from({ length: 5 }, () => deferred())
    h.answer = async () => {
      await holds[h.upstreamCalls.length - 1]!.promise
      return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } })
    }
    const calls = Array.from({ length: 5 }, () => call(h))
    await until(() => h.upstreamCalls.length === 4 && h.rpc.callsOf('admitModelCall').length === 5, 'four upstream, five asked')
    expect(h.upstreamCalls).toHaveLength(4)
    holds[0]!.resolve()
    await until(() => h.upstreamCalls.length === 5, 'the fifth after a close')
    for (const d of holds) d.resolve()
    expect((await Promise.all(calls)).map(r => r.status)).toEqual([200, 200, 200, 200, 200])
    await settle(h)
    expect(new Set(h.rpc.callsOf('releaseModelCall').map(c => c.args[1]))).toEqual(new Set(['c_1', 'c_2', 'c_3', 'c_4', 'c_5']))
  })

  it('two calls racing for the last headroom: one upstream request, the other refused 400 (never 429)', async () => {
    const h = await harness()
    let granted = false
    h.rpc.admitAnswer = async () => (granted ? { refused: 'turn_budget' } : ((granted = true), { granted: true }))
    const [a, b] = await Promise.all([call(h), call(h)])
    expect([a.status, b.status].sort()).toEqual([200, 400])
    const refused = a.status === 400 ? a : b
    expect(await json(refused)).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'turn_budget' } })
    expect(h.upstreamCalls).toHaveLength(1)
  })

  it('a gate wait past its bound is 503 for that call only', async () => {
    const h = await harness()
    h.rpc.admitAnswer = { busy: true }
    expect((await call(h)).status).toBe(503)
    expect(h.upstreamCalls).toEqual([])
  })

  it('an abort while another call closes: two releases, each with its own callId', async () => {
    const h = await harness()
    const feedA = sseFeed()
    const feedB = sseFeed()
    let n = 0
    h.answer = async () => new Response((n++ === 0 ? feedA : feedB).stream, { headers: { 'content-type': 'text/event-stream' } })
    const ac = new AbortController()
    const resA = await call(h, { ...small, stream: true }, { signal: ac.signal })
    const resB = await call(h, { ...small, stream: true })
    const readerB = resB.body!.getReader()
    feedB.send({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } })
    feedB.send({ type: 'message_delta', usage: { output_tokens: 2 } })
    feedB.send({ type: 'message_stop' })
    feedB.end()
    ac.abort()
    while (!(await readerB.read()).done) { /* drain */ }
    void resA
    await settle(h)
    const ends = h.rpc.callsOf('releaseModelCall').map(c => [c.args[1], (c.args[2] as { cut: boolean }).cut])
    expect(ends.sort()).toEqual([['c_1', true], ['c_2', false]])
  })
})

describe('the model and the counts (failure 7)', () => {
  it('a model switched off mid-turn: the next call is refused model_off', async () => {
    const h = await harness()
    expect((await call(h)).status).toBe(200)
    h.settings['tm:sonnet:on'] = 'off'
    const res = await call(h)
    expect(res.status).toBe(403)
    expect(await json(res)).toEqual({ type: 'error', error: { type: 'permission_error', message: 'model_off' } })
    expect(h.upstreamCalls).toHaveLength(1)
    h.settings['tm:sonnet:on'] = 'on'
    expect((await call(h)).status).toBe(200)
  })
  it('only the grant model and side model; the side model is off when Haiku is', async () => {
    const h = await harness()
    expect((await call(h, { ...small, model: 'claude-opus-5-5' })).status).toBe(403)
    expect((await call(h, { ...small, model: 'claude-haiku-5-5' })).status).toBe(200)
    h.settings['tm:haiku:on'] = 'off'
    expect((await call(h, { ...small, model: 'claude-haiku-5-5' })).status).toBe(403)
    expect(h.rpc.callsOf('admitModelCall').map(c => (c.args[2] as ModelCallWorst).model)).toEqual(['claude-haiku-5-5'])
  })
  it("the CLI's own count_tokens pass unpriced, 50 per turn, then 400", async () => {
    const h = await harness()
    h.answer = async () => Response.json({ input_tokens: 12 })
    for (let i = 0; i < 50; i++) expect((await handleEgress(egressRequest('/model/v1/messages/count_tokens', { body: small }), h.deps)).status).toBe(200)
    const res = await handleEgress(egressRequest('/model/v1/messages/count_tokens', { body: small }), h.deps)
    expect(res.status).toBe(400)
    expect(h.upstreamCalls).toHaveLength(50)
    expect(h.rpc.callsOf('admitModelCall')).toEqual([])
  })
  it('refused shapes are 400 before any upstream call or admission', async () => {
    const h = await harness()
    const res = await call(h, { ...small, mcp_servers: [{ type: 'url', url: 'https://x.example.test', name: 'x' }] })
    expect(res.status).toBe(400)
    expect(h.upstreamCalls).toEqual([])
    expect(h.rpc.callsOf('admitModelCall')).toEqual([])
  })
  it('the run grant comes from the token only: no token or an unknown one is 401 and logged without it', async () => {
    const h = await harness()
    expect((await handleEgress(egressRequest(MSG, { body: small, token: null }), h.deps)).status).toBe(401)
    expect((await handleEgress(egressRequest(MSG, { body: small, token: 'another-token-0123456789' }), h.deps)).status).toBe(401)
    expect(h.logs).toEqual([
      { event: 'egress_refused', route: 'model', why: 'unknown', runner: 'runner-0' },
      { event: 'egress_refused', route: 'model', why: 'unknown', runner: 'runner-0' },
    ])
    expect(JSON.stringify(h.logs)).not.toContain('another-token')
    void GRANT
  })
})

describe('the test build hook', () => {
  it('the scripted model answers a scenario named in the first user message, and has no count', async () => {
    const { scenarioOf, scriptedUpstream } = await import('./gateway.ts')
    expect(scenarioOf({ model: 'm', messages: [{ role: 'user', content: 'please scenario:write-output now' }] })).toBe('write-output')
    expect(scenarioOf({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })).toBe('hello')
    const up = scriptedUpstream()
    const body = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 10, tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: 'hi' }] })
    const res = await up('/v1/messages', { body, headers: new Headers(), signal: new AbortController().signal })
    expect(((await res.json()) as { content: unknown }).content).toEqual([{ type: 'text', text: 'Hello from the scripted model.' }])
    expect((await up('/v1/messages/count_tokens', { body, headers: new Headers(), signal: new AbortController().signal })).status).toBe(400)
  })
})
