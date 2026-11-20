// How a model call closes (fix round 1 of #145: p3-design 8.2, 8.3) and the gate's new refusals. Every expected amount
// is a literal written by hand. The small request is 45 bytes of text with max_tokens 1,000 on Sonnet 5.5 ($2 / $10 per
// MTok), so its admitted worst case is 45 × 2 + 1,000 × 10 = 10,090 micro-USD. Ways it can fail, written down first:
//  1. a call that never went upstream (a connect failure, the caller gone during the confirm) is booked at its worst case;
//  2. a whole answer is booked at its worst case because the caller left after message_stop;
//  3. an answer with no usage (JSON or stream) is booked at zero, or a stream with no message_stop at its tally;
//  4. a cut call is booked below its running tally (search results past the allowance);
//  5. a stalled upstream (no headers, or a silent stream) holds its slot until the turn ends;
//  6. server-side compaction, an unknown beta or a compaction iteration's tokens get past the gate or the tally;
//  7. an upstream message that names the account's state reaches the member.
import { describe, expect, it } from 'vitest'
import { gatewayUpstream } from './gateway.ts'
import { FIRST_BYTE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from './model.ts'
import { handleEgress } from './index.ts'
import { egressRequest, harness, sseFeed, until } from './testing/harness.ts'
import type { Harness } from './testing/harness.ts'

const small = { model: 'claude-sonnet-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] }
const WORST = 10_090
const ZERO = { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0 }
const call = (h: Harness, body: unknown = small, init: { signal?: AbortSignal; headers?: Record<string, string> } = {}) =>
  handleEgress(egressRequest('/model/v1/messages', { body, ...init }), h.deps)
const releases = (h: Harness) => h.rpc.callsOf('releaseModelCall').map(c => c.args[2] as { usage: Record<string, number>; cut: boolean })
const settle = (h: Harness) => Promise.all(h.waits)
const sse = { headers: { 'content-type': 'text/event-stream' } }
const drain = async (r: ReadableStreamDefaultReader<Uint8Array>) => {
  while (!(await r.read()).done) { /* read to the end */ }
}

describe('nothing went upstream: zero, not cut; a fetch that rejects: cut (failure 1)', () => {
  it('a fetch that rejects after it was called may have reached the model: booked at its worst case', async () => {
    const h = await harness()
    h.answer = async () => { throw new TypeError('connection reset') }
    expect((await call(h)).status).toBe(502)
    await settle(h)
    expect(releases(h)).toEqual([{ usage: { ...ZERO, micro: WORST }, cut: true }])
  })
  it('through the configured gateway, a fetcher that rejects after it was called is booked at its worst case', async () => {
    const ai = { gateway: () => ({ getUrl: async () => 'https://gateway.example.test/anthropic' }) }
    let called = 0
    const fetcher = (async () => {
      called++
      throw new TypeError('connection reset')
    }) as unknown as typeof fetch
    const h = await harness()
    h.deps.upstream = gatewayUpstream({ AI: ai, AI_GATEWAY_ID: 'gw', AI_GATEWAY_TOKEN: 't' }, fetcher)
    expect((await call(h)).status).toBe(502)
    await settle(h)
    expect(called).toBe(1)
    expect(releases(h)).toEqual([{ usage: { ...ZERO, micro: WORST }, cut: true }])
  })
  it('failures known to come before the send (the gateway not configured, its URL lookup) are zero', async () => {
    const ai = (fail: boolean) => ({ gateway: () => ({ getUrl: async () => { if (fail) throw new Error('lookup'); return 'https://gateway.example.test/anthropic' } }) })
    const fetcher = (async () => { throw new Error('never called') }) as unknown as typeof fetch
    for (const env of [{ AI_GATEWAY_ID: 'gw', AI_GATEWAY_TOKEN: 't' }, { AI: ai(true), AI_GATEWAY_ID: 'gw', AI_GATEWAY_TOKEN: 't' }, { AI: ai(false), AI_GATEWAY_ID: 'gw' }]) {
      const h = await harness()
      h.deps.upstream = gatewayUpstream(env, fetcher)
      expect((await call(h)).status).toBe(502)
      await settle(h)
      expect(releases(h)).toEqual([{ usage: { ...ZERO, micro: 0 }, cut: false }])
    }
  })
  it('the caller gone during the confirm: no upstream request, zero', async () => {
    const h = await harness()
    const ac = new AbortController()
    const renew = h.rpc.renewModelCall.bind(h.rpc)
    h.rpc.renewModelCall = async (...a) => {
      ac.abort()
      return renew(...a)
    }
    expect((await call(h, small, { signal: ac.signal })).status).toBe(499)
    await settle(h)
    expect(h.upstreamCalls).toEqual([])
    expect(releases(h)).toEqual([{ usage: { ...ZERO, micro: 0 }, cut: false }])
  })
})

describe('a whole answer is priced from its tally, whenever the caller leaves (failure 2)', () => {
  const finished = (feed: ReturnType<typeof sseFeed>) => {
    feed.send({ type: 'message_start', message: { usage: { input_tokens: 1000, output_tokens: 1 } } })
    feed.send({ type: 'message_delta', usage: { output_tokens: 200 } })
    feed.send({ type: 'message_stop' })
  }
  // Sonnet: 1,000 × $2 + 200 × $10 per MTok.
  const TALLY = { ...ZERO, inputTokens: 1000, outputTokens: 200, micro: 4_000 }
  it('a cancel after message_stop, before the end of the body', async () => {
    const h = await harness()
    const feed = sseFeed()
    h.answer = async () => new Response(feed.stream, sse)
    const res = await call(h, { ...small, stream: true })
    const reader = res.body!.getReader()
    finished(feed)
    for (let i = 0; i < 3; i++) await reader.read()
    await reader.cancel()
    await settle(h)
    expect(releases(h)).toEqual([{ usage: TALLY, cut: false }])
  })
  it('an abort after message_stop', async () => {
    const h = await harness()
    const feed = sseFeed()
    h.answer = async () => new Response(feed.stream, sse)
    const ac = new AbortController()
    const res = await call(h, { ...small, stream: true }, { signal: ac.signal })
    const reader = res.body!.getReader()
    finished(feed)
    for (let i = 0; i < 3; i++) await reader.read()
    ac.abort()
    await settle(h)
    expect(releases(h)).toEqual([{ usage: TALLY, cut: false }])
  })
})

describe('no usage, or no message_stop: cut at the worst case (failure 3)', () => {
  it('a 200 JSON answer with no usage, logged', async () => {
    const h = await harness()
    h.answer = async () => Response.json({ type: 'message', content: [] })
    expect((await call(h)).status).toBe(200)
    await settle(h)
    expect(releases(h)).toEqual([{ usage: { ...ZERO, micro: WORST }, cut: true }])
    expect(h.logs).toContainEqual({ event: 'egress_model_no_usage', route: 'model', shape: 'json' })
  })
  it('a finished stream that never carried usage, logged', async () => {
    const h = await harness()
    const feed = sseFeed()
    h.answer = async () => new Response(feed.stream, sse)
    const res = await call(h, { ...small, stream: true })
    feed.send({ type: 'message_start', message: {} })
    feed.send({ type: 'message_stop' })
    feed.end()
    await drain(res.body!.getReader())
    await settle(h)
    expect(releases(h)).toEqual([{ usage: { ...ZERO, micro: WORST }, cut: true }])
    expect(h.logs).toContainEqual({ event: 'egress_model_no_usage', route: 'model', shape: 'stream' })
  })
  it('a stream with message_start and message_stop but no message_delta usage is cut', async () => {
    const h = await harness()
    const feed = sseFeed()
    h.answer = async () => new Response(feed.stream, sse)
    const res = await call(h, { ...small, stream: true })
    feed.send({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })
    feed.send({ type: 'message_stop' })
    feed.end()
    await drain(res.body!.getReader())
    await settle(h)
    expect(releases(h)).toEqual([{ usage: { ...ZERO, inputTokens: 10, outputTokens: 1, micro: WORST }, cut: true }])
  })
  it("an error that isn't the API's own (a gateway 524 after forwarding) is cut; the API's own is zero", async () => {
    const h = await harness()
    h.answer = async () => new Response('<html>timeout</html>', { status: 524, headers: { 'content-type': 'text/html' } })
    expect((await call(h)).status).toBe(524)
    await settle(h)
    expect(releases(h)).toEqual([{ usage: { ...ZERO, micro: WORST }, cut: true }])
    const own = await harness()
    own.answer = async () => Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 })
    expect((await call(own)).status).toBe(529)
    await settle(own)
    expect(releases(own)).toEqual([{ usage: { ...ZERO, micro: 0 }, cut: false }])
  })
  it('a stream that ends without message_stop is cut, not priced at its partial tally', async () => {
    const h = await harness()
    const feed = sseFeed()
    h.answer = async () => new Response(feed.stream, sse)
    const res = await call(h, { ...small, stream: true })
    feed.send({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })
    feed.send({ type: 'message_delta', usage: { output_tokens: 3 } })
    feed.end()
    await drain(res.body!.getReader())
    await settle(h)
    expect(releases(h)).toEqual([{ usage: { ...ZERO, inputTokens: 10, outputTokens: 3, micro: WORST }, cut: true }])
  })
})

describe('a cut call is never booked below its tally (failure 4)', () => {
  it('search results past the allowance: the running tally wins over the worst case', async () => {
    const h = await harness()
    const feed = sseFeed()
    h.answer = async () => new Response(feed.stream, sse)
    const ac = new AbortController()
    const res = await call(h, { ...small, stream: true }, { signal: ac.signal })
    const reader = res.body!.getReader()
    feed.send({ type: 'message_start', message: { usage: { input_tokens: 500_000, output_tokens: 1 } } })
    await reader.read()
    ac.abort()
    await settle(h)
    // 500,000 × $2 + 1 × $10 per MTok = 1,000,010 micro-USD, above the 10,090 worst case.
    expect(releases(h)).toEqual([{ usage: { ...ZERO, inputTokens: 500_000, outputTokens: 1, micro: 1_000_010 }, cut: true }])
  })
})

describe('timeouts (failure 5)', () => {
  const hanging = (h: Harness) => {
    h.answer = c => new Promise((_r, reject) => c.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  }
  it('no headers in 10 minutes (whole) or 2 minutes (stream): cut, 504, the upstream aborted', async () => {
    expect(FIRST_BYTE_TIMEOUT_MS).toEqual({ stream: 120_000, whole: 600_000 })
    for (const [body, ms] of [[small, 600_000], [{ ...small, stream: true }, 120_000]] as const) {
      const h = await harness()
      hanging(h)
      const pending = call(h, body)
      await until(() => h.upstreamCalls.length === 1, 'the send')
      const t = h.timeouts.find(x => x.ms === ms && !x.cleared)!
      t.fn()
      const res = await pending
      expect(res.status).toBe(504)
      await settle(h)
      expect(h.upstreamCalls[0]!.signal.aborted).toBe(true)
      expect(releases(h)).toEqual([{ usage: { ...ZERO, micro: WORST }, cut: true }])
      expect(h.logs).toContainEqual({ event: 'egress_model_timeout', route: 'model', phase: 'first_byte' })
    }
  })
  it('a stream silent for 5 minutes: cut, the body errors', async () => {
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(300_000)
    const h = await harness()
    const feed = sseFeed()
    h.answer = async () => new Response(feed.stream, sse)
    const res = await call(h, { ...small, stream: true })
    const reader = res.body!.getReader()
    feed.send({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })
    await reader.read()
    const reading = reader.read()
    await until(() => h.timeouts.some(x => x.ms === 300_000 && !x.cleared), 'the idle timer')
    h.timeouts.find(x => x.ms === 300_000 && !x.cleared)!.fn()
    await expect(reading).rejects.toThrow()
    await settle(h)
    expect(releases(h)).toEqual([{ usage: { ...ZERO, inputTokens: 10, outputTokens: 1, micro: WORST }, cut: true }])
  })
})

describe('the gate and the tally against server-side compaction and unknown betas (failure 6)', () => {
  it('refuses the compaction field and compact_* edits with 400 before any call; clear_* edits pass', async () => {
    for (const body of [
      { ...small, compaction: { type: 'enabled' } },
      { ...small, context_management: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 50000 } }] } },
    ]) {
      const h = await harness()
      const res = await call(h, body)
      expect(res.status).toBe(400)
      expect(h.upstreamCalls).toEqual([])
      expect(h.rpc.callsOf('admitModelCall')).toEqual([])
    }
    const h = await harness()
    expect((await call(h, { ...small, context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] } })).status).toBe(200)
  })
  it('refuses an anthropic-beta outside the allowlist, alone or in a list', async () => {
    for (const beta of ['compact-2026-01-12', 'claude-code-20250219,fast-mode-2026-02-01', 'mcp-servers-2025-12-04']) {
      const h = await harness()
      const res = await call(h, small, { headers: { 'anthropic-beta': beta } })
      expect(res.status, beta).toBe(400)
      expect(h.upstreamCalls, beta).toEqual([])
    }
  })
  it('bills a response with usage.iterations at their sum (the compaction iteration included)', async () => {
    const h = await harness()
    h.answer = async () => Response.json({ usage: { input_tokens: 23000, output_tokens: 1000, iterations: [
      { type: 'compaction', input_tokens: 180000, output_tokens: 3500 }, { type: 'message', input_tokens: 23000, output_tokens: 1000 },
    ] } })
    await call(h)
    await settle(h)
    // 203,000 × $2 + 4,500 × $10 per MTok = 406,000 + 45,000.
    expect(releases(h)).toEqual([{ usage: { ...ZERO, inputTokens: 203_000, outputTokens: 4_500, micro: 451_000 }, cut: false }])
  })
})

describe('account state stays out of the member\'s view (failure 7)', () => {
  it('an invalid_request_error about credit or billing gets the fixed message', async () => {
    for (const message of ['Your credit balance is too low to access the Anthropic API.', 'This organization has been disabled.', 'Invalid API key for workspace w1']) {
      const h = await harness()
      h.answer = async () => Response.json({ type: 'error', error: { type: 'invalid_request_error', message } }, { status: 400 })
      expect(await (await call(h)).json(), message).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'The model refused the request.' } })
    }
  })
})
