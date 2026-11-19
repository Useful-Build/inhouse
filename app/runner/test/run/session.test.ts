// The session process's run loop, with the SDK's query() mocked at the process boundary. Ways it could fail:
// - the query gets options that don't come from the run config, misses settingSources: [], or swaps sessionId/resume;
// - the guards aren't applied, a NODE_CHANNEL_ variable reaches the CLI's env, or a custom CLI spawn or MCP delivery
//   sneaks back in (the SDK's default spawn keeps the session's stdio from the CLI);
// - an interrupt that falls back to abort is reported as an SDK error;
// - a run ends twice, or not at all, when the query throws, is stopped, or the root sends garbage;
// - sessionEnv() grows a variable that isn't on its list (where a token could hide).
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { fc, it } from '@fast-check/vitest'
import { afterAll, describe, expect } from 'vitest'
import { LOCAL_MAX_DEPTH, LineReader, encodeLine, type LineResult } from '../../src/protocol/ndjson.ts'
import { SDK_MESSAGE_MAX_DEPTH, leftOutNote, runSession, type QueryFn } from '../../src/session/core.ts'
import { parseSessionMessage } from '../../src/protocol/local.ts'
import { sessionEnv } from '../../src/session/env.ts'
import type { QueryGuards, RunContext } from '../../src/session/seam.ts'
import { GuardsMissingError, productionQueryGuards, productionSessionUsers, requireProduction } from '../../src/server/production.ts'
import { runStart } from './support/root-client.ts'
import { PROXY_URL, fakeEgress, type FakeEgress } from './support/fake-egress.ts'
import { testQueryGuards, testSessionUsers } from './support/test-seams.ts'

const result = { type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 5 } } as unknown as SDKMessage
const assistant = { type: 'assistant', message: { content: [] } } as unknown as SDKMessage

const cwds: string[] = []
afterAll(() => {
  for (const d of cwds) rmSync(d, { recursive: true, force: true })
})
function workDir() {
  const d = mkdtempSync(join(tmpdir(), 'runner-session-'))
  cwds.push(d)
  return d
}

function harness(query: QueryFn, guards: QueryGuards = testQueryGuards, opts: { egress?: FakeEgress; auditTimeoutMs?: number; cwd?: string } = {}) {
  const sent: any[] = []
  let handler: (line: LineResult) => void = () => {}
  let onClose: () => void = () => {}
  const egress = opts.egress ?? fakeEgress()
  const cwd = opts.cwd ?? workDir()
  const logs: Record<string, unknown>[] = []
  const done = runSession({
    channel: { send: (m) => void sent.push(m), onMessage: (h) => (handler = h), onClose: (h) => (onClose = h) },
    query,
    guards,
    cwd,
    env: { PATH: '/bin', NODE_CHANNEL_FD: '3', NODE_CHANNEL_SERIALIZATION_MODE: 'json' },
    io: { fetch: egress.fetch, proxyUrl: PROXY_URL },
    log: (e) => logs.push(e),
    auditTimeoutMs: opts.auditTimeoutMs,
  })
  const events = () => sent.filter((m) => m.type === 'event').map((m) => m.event)
  return { sent, events, done, cwd, egress, logs, close: () => onClose(), deliver: (m: unknown) => handler({ ok: true, value: m }), deliverLine: (l: LineResult) => handler(l) }
}

/** The prompt a query got, as text: a stream's one message, or the plain string. */
async function promptText(p: string | AsyncIterable<SDKUserMessage>): Promise<{ streamed: boolean; text: string }> {
  if (typeof p === 'string') return { streamed: false, text: p }
  const it = p[Symbol.asyncIterator]()
  const first = await it.next()
  return { streamed: true, text: String((first.value as SDKUserMessage).message.content) }
}

const config = (over = {}) => {
  const { runToken: _, ...c } = runStart(over)
  return c
}

function fakeQuery(messages: SDKMessage[], opts: { throwAt?: number; holdUntilInterrupt?: boolean; interruptThrows?: boolean; abortThrows?: boolean } = {}) {
  const calls: Parameters<QueryFn>[0][] = []
  let interrupted = 0
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  const query: QueryFn = (params) => {
    calls.push(params)
    const signal = params.options.abortController!.signal
    async function* gen() {
      for (let i = 0; i < messages.length; i++) {
        if (opts.throwAt === i) throw new Error('the CLI exited')
        yield messages[i]!
      }
      if (opts.abortThrows) {
        // As the real SDK does on its abort signal: the iteration throws an AbortError.
        await new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(Object.assign(new Error('Claude Code process aborted by user'), { name: 'AbortError' })), { once: true }),
        )
      }
      if (opts.holdUntilInterrupt) await held
    }
    return Object.assign(gen(), {
      interrupt: async () => {
        interrupted++
        if (opts.interruptThrows) throw new Error('needs streaming input')
        release()
        return undefined
      },
    })
  }
  return { query, calls, interrupts: () => interrupted, release: () => release() }
}

/** Polls a condition on the event loop (no fixed sleep): resolves once it holds, fails after 10 s. */
async function waitForTicks(cond: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setImmediate(r))
  expect(cond()).toBe(true)
}

describe('runSession', () => {
  it('says ready, runs one query from the run config and ends with finished', async () => {
    const q = fakeQuery([assistant, result])
    const h = harness(q.query, { kind: 'test', apply: (o) => ({ ...o, tools: ['Read'] }) })
    expect(h.sent[0]).toEqual({ type: 'ready' })
    const c = config({ resume: false, prompt: 'hello' })
    h.deliver({ type: 'run', config: c })
    await h.done
    expect(q.calls).toHaveLength(1)
    const { prompt, options } = q.calls[0]!
    expect(await promptText(prompt)).toEqual({ streamed: true, text: 'hello' })
    expect(options).toMatchObject({
      cwd: h.cwd,
      sessionStoreFlush: 'batched',
      model: c.model,
      effort: c.effort,
      maxTurns: c.maxTurns,
      maxBudgetUsd: c.maxBudgetUsd,
      settingSources: [],
      sessionId: c.sessionId,
      tools: ['Read'],
    })
    expect(options.resume).toBeUndefined()
    expect(options.env).toEqual({ PATH: '/bin' })
    expect(options.sessionStore).toBeDefined()
    expect(h.events().map((e) => e.type)).toEqual(['sdk', 'sdk', 'checkpoint', 'finished'])
    expect(h.events().at(-1)).toEqual({ type: 'finished', subtype: 'success', isError: false, numTurns: 2, costUsd: 0.01, usage: { input_tokens: 5 } })
  })

  it('resume: true passes resume, not sessionId; "" is passed as the prompt', async () => {
    const q = fakeQuery([result])
    const h = harness(q.query)
    const c = config({ resume: true, prompt: '' })
    h.deliver({ type: 'run', config: c })
    await h.done
    expect(q.calls[0]!.options.resume).toBe(c.sessionId)
    expect(q.calls[0]!.options.sessionId).toBeUndefined()
    expect(q.calls[0]!.prompt).toBe('')
  })

  it('a query that throws ends with one failed sdk_error', async () => {
    const h = harness(fakeQuery([assistant, result], { throwAt: 1 }).query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(h.events().map((e) => e.type)).toEqual(['sdk', 'checkpoint', 'failed'])
    expect(h.events().at(-1)).toMatchObject({ reason: 'sdk_error' })
  })

  it('stop interrupts the query and ends with one failed stopped', async () => {
    const q = fakeQuery([assistant], { holdUntilInterrupt: true })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    await waitForTicks(() => q.calls.length === 1)
    h.deliver({ type: 'stop' })
    await h.done
    expect(q.interrupts()).toBe(1)
    expect(h.events().filter((e) => e.type === 'failed' || e.type === 'finished')).toEqual([{ type: 'failed', reason: 'stopped', message: 'stopped' }])
  })

  it('when interrupt() is refused, the abort signal fires', async () => {
    const q = fakeQuery([assistant], { holdUntilInterrupt: true, interruptThrows: true })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    await waitForTicks(() => q.calls.length === 1)
    h.deliver({ type: 'interrupt' })
    await new Promise((r) => setImmediate(r))
    expect(q.calls[0]!.options.abortController!.signal.aborted).toBe(true)
    q.release()
    await h.done
    expect(h.events().at(-1)).toMatchObject({ type: 'failed', reason: 'interrupted' })
  })

  it('an interrupt that falls back to abort, where the SDK throws an AbortError, ends as interrupted', async () => {
    const q = fakeQuery([assistant], { abortThrows: true, interruptThrows: true })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    await waitForTicks(() => q.calls.length === 1)
    h.deliver({ type: 'interrupt' })
    await h.done
    expect(h.events().map((e) => e.type)).toEqual(['sdk', 'checkpoint', 'failed'])
    expect(h.events().at(-1)).toMatchObject({ type: 'failed', reason: 'interrupted' })
  })

  it('an interrupt delivered with the run, in the same tick, reaches the query', async () => {
    const q = fakeQuery([assistant], { holdUntilInterrupt: true })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    h.deliver({ type: 'interrupt' })
    await h.done
    expect(q.interrupts()).toBe(1)
    expect(h.events().filter((e) => e.type === 'failed' || e.type === 'finished')).toHaveLength(1)
  })

  it('a stop delivered with the run, in the same tick, ends the run as stopped without calling query()', async () => {
    const q = fakeQuery([assistant, result])
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    h.deliver({ type: 'stop' })
    await h.done
    expect(q.calls).toHaveLength(0)
    expect(h.events()).toEqual([{ type: 'failed', reason: 'stopped', message: 'stopped before the query started' }])
  })

  it('a stop with no run ends the session as stopped; no query runs', async () => {
    const q = fakeQuery([result])
    const h = harness(q.query)
    h.deliver({ type: 'stop' })
    await h.done
    expect(q.calls).toHaveLength(0)
    expect(h.events()).toEqual([{ type: 'failed', reason: 'stopped', message: 'stopped before the run started' }])
  })

  it.each([false, true])('a stop racing the finish after the result ends as finished, with cost and usage (interrupt falls back: %s)', async (interruptThrows) => {
    const q = fakeQuery([assistant, result], { holdUntilInterrupt: !interruptThrows, abortThrows: interruptThrows, interruptThrows })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    // Once the result is out, the stop comes in.
    while (!h.events().some((e) => e.type === 'sdk' && e.message.type === 'result')) await new Promise((r) => setImmediate(r))
    h.deliver({ type: 'stop' })
    await h.done
    expect(h.events().filter((e) => e.type === 'failed' || e.type === 'finished')).toEqual([
      { type: 'finished', subtype: 'success', isError: false, numTurns: 2, costUsd: 0.01, usage: { input_tokens: 5 } },
    ])
  })

  it('an SDK message JSON cannot encode (a BigInt) is sent as a stub, never thrown', async () => {
    const h = harness(fakeQuery([{ type: 'assistant', n: 1n } as unknown as SDKMessage, result]).query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(h.events()[0]).toEqual({ type: 'sdk', message: { type: 'assistant', unencodable: true }, truncated: true })
    expect(h.events().at(-1)?.type).toBe('finished')
  })

  // The root refuses a line nested past LOCAL_MAX_DEPTH, envelope included: a message the session sends whole must fit
  // inside it, or one honest (if odd) SDK message would end the run as protocol.
  it.each([
    [SDK_MESSAGE_MAX_DEPTH, false],
    [SDK_MESSAGE_MAX_DEPTH + 1, true],
    [LOCAL_MAX_DEPTH - 1, true],
    [300_000, true],
  ])('an SDK message nested %i levels: stubbed %s, and its line always passes the root\'s reader', async (depth, stubbed) => {
    let inner: unknown = 1
    for (let i = 1; i < depth; i++) inner = [inner]
    const deep = { type: 'assistant', a: inner } as unknown as SDKMessage
    const h = harness(fakeQuery([deep, result]).query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    const sent = h.sent.find((m) => m.type === 'event' && m.event.type === 'sdk')
    if (stubbed) expect(sent.event).toEqual({ type: 'sdk', message: { type: 'assistant', tooDeep: true }, truncated: true })
    else expect(sent.event).toEqual({ type: 'sdk', message: deep, truncated: false })
    expect(new LineReader().push(Buffer.from(encodeLine(sent)))).toEqual([{ ok: true, value: sent }])
    expect(h.events().at(-1)?.type).toBe('finished')
  })

  it('while the channel is full, the next SDK message is not read; it is once the channel drains', async () => {
    let pulled = 0
    const query: QueryFn = () =>
      Object.assign(
        (async function* () {
          for (const m of [assistant, assistant, assistant, result]) {
            pulled++
            yield m
          }
        })(),
        { interrupt: async () => undefined },
      )
    const sent: any[] = []
    let handler: (line: LineResult) => void = () => {}
    let drain: () => void = () => {}
    const done = runSession({
      // Full after every sdk event, until the test drains it.
      channel: {
        send: (m: any) => {
          sent.push(m)
          if (m.type === 'event' && m.event.type === 'sdk') return new Promise<void>((r) => (drain = r))
        },
        onMessage: (h) => (handler = h),
      },
      query,
      guards: testQueryGuards,
      cwd: workDir(),
      env: {},
      io: { fetch: fakeEgress().fetch, proxyUrl: PROXY_URL },
    })
    handler({ ok: true, value: { type: 'run', config: config() } })
    // The files restore runs first: wait for the query's first message, then check no second one is pulled.
    await waitForTicks(() => pulled === 1)
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    expect(pulled).toBe(1)
    expect(sent.filter((m) => m.type === 'event')).toHaveLength(1)
    for (let n = 2; n <= 4; n++) {
      drain()
      await waitForTicks(() => pulled === n)
    }
    drain()
    await done
    expect(sent.filter((m) => m.type === 'event').map((m) => m.event.type)).toEqual(['sdk', 'sdk', 'sdk', 'sdk', 'checkpoint', 'finished'])
  })

  it('an unreadable line from the root (oversized, not JSON) ends the session with failed protocol', async () => {
    const q = fakeQuery([result])
    const h = harness(q.query)
    h.deliverLine({ ok: false, error: 'line over the size cap' })
    await h.done
    expect(q.calls).toHaveLength(0)
    expect(h.events()).toEqual([expect.objectContaining({ type: 'failed', reason: 'protocol' })])
  })

  it("the query uses the SDK's default CLI spawn and MCP delivery", async () => {
    const q = fakeQuery([result])
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(q.calls[0]!.options).not.toHaveProperty('spawnClaudeCodeProcess')
    expect(q.calls[0]!.options).not.toHaveProperty('mcpServersDelivery')
    expect(q.calls[0]!.options).not.toHaveProperty('pathToClaudeCodeExecutable')
  })

  it('an SDK message over the cap is stubbed before it is sent', async () => {
    const huge = { type: 'assistant', blob: 'a'.repeat(300 * 1024) } as unknown as SDKMessage
    const h = harness(fakeQuery([huge, result]).query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(h.events()[0]).toMatchObject({ type: 'sdk', truncated: true, message: { type: 'assistant' } })
  })

  it.prop([fc.anything().filter((m) => !(typeof m === 'object' && m !== null && 'type' in m))])(
    'a message from the root it cannot read ends the session with failed protocol, and no query runs',
    async (garbage) => {
      const q = fakeQuery([result])
      const h = harness(q.query)
      h.deliver(garbage)
      await h.done
      expect(q.calls).toHaveLength(0)
      expect(h.events()).toEqual([expect.objectContaining({ type: 'failed', reason: 'protocol' })])
    },
  )

  it('a run message carrying a runToken is refused', async () => {
    const q = fakeQuery([result])
    const h = harness(q.query)
    h.deliver({ type: 'run', config: { ...config(), runToken: 'tok_0123456789abcdef0123' } })
    await h.done
    expect(q.calls).toHaveLength(0)
    expect(h.events()).toEqual([expect.objectContaining({ type: 'failed', reason: 'protocol' })])
  })
})

/** A query whose run the test writes as a generator over the options and prompt the session passed (as the SDK sees them). */
function scriptedQuery(body: (p: Parameters<QueryFn>[0]) => AsyncGenerator<SDKMessage>) {
  const calls: Parameters<QueryFn>[0][] = []
  const query: QueryFn = (params) => {
    calls.push(params)
    return Object.assign(body(params), { interrupt: async () => undefined })
  }
  return { query, calls }
}

const toolUse = (...ids: string[]) => ({ type: 'assistant', message: { content: ids.map((id) => ({ type: 'tool_use', id, name: 'mcp__inhouse__question_ask', input: {} })) } }) as unknown as SDKMessage
const toolResult = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }) as unknown as SDKMessage
const deferredResult = (id: string) => ({ ...(result as object), stop_reason: 'tool_deferred', deferred_tool_use: { id, name: 'mcp__inhouse__question_ask', input: { q: 'which?' } } }) as unknown as SDKMessage
const types = (events: any[]) => events.map((e) => e.type)

describe('the run lifecycle', () => {
  it('a lone deferred call: deferred, then checkpoint, then finished', async () => {
    const h = harness(fakeQuery([toolUse('t1'), deferredResult('t1')]).query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'sdk', 'deferred', 'checkpoint', 'finished'])
    expect(h.events()[2]).toEqual({ type: 'deferred', toolUseId: 't1', toolName: 'mcp__inhouse__question_ask', input: { q: 'which?' } })
  })

  it('a deferral in a turn with two tool calls is refused (sdk_error), with no deferred event', async () => {
    const h = harness(fakeQuery([toolUse('t1', 't2'), deferredResult('t2')]).query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'sdk', 'checkpoint', 'failed'])
    expect(h.events().at(-1)).toMatchObject({ reason: 'sdk_error', message: expect.stringContaining('2 tool calls') })
  })

  it("calls from earlier turns don't count: a tool result starts the turn over", async () => {
    const h = harness(fakeQuery([toolUse('t0', 't1'), toolResult('t0'), toolUse('t2'), deferredResult('t2')]).query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(h.events().find((e) => e.type === 'deferred')).toMatchObject({ toolUseId: 't2' })
  })

  it('the prompt stream stays open until the result, then ends (so the SDK ends the run)', async () => {
    let afterResult: IteratorResult<SDKUserMessage> | null = null
    const q = scriptedQuery(async function* ({ prompt }) {
      const it = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]()
      expect((await it.next()).value).toEqual({ type: 'user', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null })
      let ended = false
      const next = it.next().then((r) => ((ended = true), r))
      yield assistant
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
      expect(ended).toBe(false)
      yield result
      afterResult = await next
    })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config({ prompt: 'hello' }) })
    await h.done
    expect(afterResult).toEqual({ done: true, value: undefined })
    expect(h.events().at(-1)?.type).toBe('finished')
  })

  it('the store: a batch the SDK dropped is repaired before checkpoint', async () => {
    const egress = fakeEgress()
    let appends = 0
    egress.fail = (_m, p) => (p === '/store/append' && appends++ < 3 ? 503 : null)
    const q = scriptedQuery(async function* ({ options }) {
      const key = { projectKey: 'k', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11' }
      for (let i = 0; i < 3; i++) await options.sessionStore!.append(key, [{ type: 'user', uuid: 'u1' }]).catch(() => undefined)
      yield { type: 'system', subtype: 'mirror_error', error: 'dropped' } as unknown as SDKMessage
      await options.sessionStore!.append(key, [{ type: 'user', uuid: 'u2' }])
      yield result
    })
    const h = harness(q.query, testQueryGuards, { egress })
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'sdk', 'checkpoint', 'finished'])
    expect(h.events()[2]).toEqual({ type: 'checkpoint', entries: 2 })
    expect(egress.entries({ projectKey: 'k', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11' }).map((e: any) => e.uuid)).toEqual(['u1', 'u2'])
    expect(h.logs).toContainEqual({ type: 'store_repaired', batches: 1 })
  })

  it('the store: when the repair fails too, mirror_error and no checkpoint; the run still finishes with its cost', async () => {
    const egress = fakeEgress()
    egress.fail = (_m, p) => (p === '/store/append' ? 503 : null)
    const q = scriptedQuery(async function* ({ options }) {
      await options.sessionStore!.append({ projectKey: 'k', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11' }, [{ type: 'user', uuid: 'u1' }]).catch(() => undefined)
      yield result
    })
    const h = harness(q.query, testQueryGuards, { egress })
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'mirror_error', 'finished'])
    expect(h.events().at(-1)).toMatchObject({ costUsd: 0.01 })
  })

  it('files: restored first (the agent told what was left out), outputs saved at the end, before the checkpoint', async () => {
    const egress = fakeEgress()
    egress.files.set('inputs/brief.txt', { body: new TextEncoder().encode('brief') })
    egress.files.set('inputs/huge.txt', { body: new Uint8Array(5000).fill(0x61) })
    const q = scriptedQuery(async function* ({ options }) {
      expect(readFileSync(join(options.cwd!, 'inputs', 'brief.txt'), 'utf8')).toBe('brief')
      writeFileSync(join(options.cwd!, 'outputs', 'answer.txt'), 'forty-two')
      yield result
    })
    const h = harness(q.query, testQueryGuards, { egress })
    const caps = { maxFileBytes: 1000, maxFilesPerTurn: 5, maxRestoreBytes: 1000, allowedTypes: ['text/plain'] }
    h.deliver({ type: 'run', config: config({ prompt: 'go', fileCaps: caps }) })
    await h.done
    expect(types(h.events())).toEqual(['files_restored', 'sdk', 'file_saved', 'checkpoint', 'finished'])
    expect(h.events()[0]).toEqual({ type: 'files_restored', restored: 1, bytes: 5, leftOut: ['inputs/huge.txt'] })
    expect((await promptText(q.calls[0]!.prompt)).text).toBe(`go\n\n${leftOutNote(['inputs/huge.txt'])}`)
    expect(egress.files.get('outputs/answer.txt')?.contentType).toBe('text/plain')
  })

  it('the "" resume prompt stays a plain empty string, even with files left out', async () => {
    const egress = fakeEgress()
    egress.files.set('inputs/huge.txt', { body: new Uint8Array(5000) })
    const q = fakeQuery([result])
    const h = harness(q.query, testQueryGuards, { egress })
    h.deliver({ type: 'run', config: config({ resume: true, prompt: '', fileCaps: { maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 10, allowedTypes: [] } }) })
    await h.done
    expect(q.calls[0]!.prompt).toBe('')
  })

  it("files that can't be restored end the run (files) before any query", async () => {
    const egress = fakeEgress()
    egress.fail = (_m, p) => (p === '/files/' ? 502 : null)
    const q = fakeQuery([result])
    const h = harness(q.query, testQueryGuards, { egress })
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(q.calls).toHaveLength(0)
    expect(h.events()).toEqual([{ type: 'failed', reason: 'files', message: "the chat's files could not be brought into the work folder" }])
  })
})

describe('the audit transport (session side)', () => {
  const entry = { hook: 'PreToolUse', toolName: 'Bash', decision: 'allow', input: { command: 'ls' } }

  /** A run held open, with the audit function the guards were given. */
  function held(opts: { auditTimeoutMs?: number } = {}) {
    let audit!: RunContext['audit']
    const q = fakeQuery([assistant], { holdUntilInterrupt: true })
    const h = harness(q.query, { kind: 'test', apply: (o, _c, run) => ((audit = run.audit), o) }, opts)
    h.deliver({ type: 'run', config: config() })
    return { h, q, audit: () => audit }
  }
  const audits = (sent: any[]) => sent.filter((m) => m.type === 'audit')

  it('resolves on the ack for its own id; rejects on a nack', async () => {
    const { h, q, audit } = held()
    await waitForTicks(() => audit() !== undefined)
    const a = audit()(entry)
    const b = audit()({ ...entry, toolName: 'Read' })
    expect(audits(h.sent)).toEqual([{ type: 'audit', id: 0, entry }, { type: 'audit', id: 1, entry: { ...entry, toolName: 'Read' } }])
    h.deliver({ type: 'audit_nack', id: 1, error: 'the Worker has gone' })
    h.deliver({ type: 'audit_ack', id: 0 })
    await expect(a).resolves.toBeUndefined()
    await expect(b).rejects.toThrow(/the Worker has gone/)
    q.release()
    await h.done
  })

  it('rejects on a timeout, on the channel closing and once the run has ended', async () => {
    const { h, q, audit } = held({ auditTimeoutMs: 20 })
    await waitForTicks(() => audit() !== undefined)
    await expect(audit()(entry)).rejects.toThrow(/in time/)
    const pending = audit()(entry)
    h.close()
    await expect(pending).rejects.toThrow(/closed/)
    q.release()
    await h.done
    await expect(audit()(entry)).rejects.toThrow(/ended/)
  })

  it('an entry that fails the schema is refused here and never sent', async () => {
    const { h, q, audit } = held()
    await waitForTicks(() => audit() !== undefined)
    await expect(audit()({ ...entry, input: 'x'.repeat(20_000) })).rejects.toThrow(/audit refused/)
    expect(audits(h.sent)).toEqual([])
    q.release()
    await h.done
  })

  it('a session may not send audit as a plain event (it would skip the ack)', () => {
    expect(parseSessionMessage({ type: 'event', event: { type: 'audit', entry } })).toMatchObject({ ok: false })
    expect(parseSessionMessage({ type: 'audit', id: 3, entry })).toEqual({ ok: true, message: { type: 'audit', id: 3, entry } })
  })
})

describe('sessionEnv', () => {
  const user = fc.record({
    uid: fc.integer({ min: 1, max: 60000 }),
    gid: fc.integer({ min: 1, max: 60000 }),
    user: fc.stringMatching(/^s_[a-z0-9]{1,16}$/),
    home: fc.stringMatching(/^\/home\/[a-z0-9_]{1,20}$/),
    workDir: fc.stringMatching(/^\/work\/[a-z0-9_]{1,20}$/),
  })
  it.prop([user, fc.integer({ min: 1024, max: 65535 })])('holds only its listed variables, and the proxy URL has no credentials', (u, port) => {
    const env = sessionEnv(u, port)
    expect(Object.keys(env).sort()).toEqual(
      [
        'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'INHOUSE_PROXY_URL',
        'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER',
      ].sort(),
    )
    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}/model`)
    expect(new URL(env.INHOUSE_PROXY_URL!).username + new URL(env.INHOUSE_PROXY_URL!).password).toBe('')
  })
})

describe('the production wiring', () => {
  it('refuses to start without the real guards', () => {
    expect(() => productionSessionUsers()).toThrow(GuardsMissingError)
    expect(() => productionQueryGuards()).toThrow(GuardsMissingError)
  })

  // The bundle the image runs, built by the package's own build script into a temp folder.
  it('the bundled root and session entries refuse to start without the guards, and zod is bundled as ESM', () => {
    const runner = fileURLToPath(new URL('../../', import.meta.url))
    const pkg = JSON.parse(readFileSync(join(runner, 'package.json'), 'utf8')) as { scripts: { build: string } }
    const [bin, ...args] = pkg.scripts.build.split(' ')
    expect(bin).toBe('esbuild')
    expect(args).toContain('--outdir=dist')
    const out = mkdtempSync(join(tmpdir(), 'runner-bundle-'))
    try {
      const buildArgs = [...args.filter((a) => a !== '--outdir=dist'), `--outdir=${out}`, `--metafile=${join(out, 'meta.json')}`, '--log-level=warning']
      execFileSync(join(runner, 'node_modules/.bin/esbuild'), buildArgs, { cwd: runner, stdio: 'pipe' })

      const inputs = Object.keys((JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')) as { inputs: Record<string, unknown> }).inputs)
      const zod = inputs.filter((i) => i.includes('node_modules/zod/'))
      expect(zod).toContain('node_modules/zod/index.js')
      expect(zod.filter((i) => i.endsWith('.cjs'))).toEqual([])
      expect(inputs.some((i) => i.includes('claude-agent-sdk'))).toBe(false)

      for (const entry of ['main.mjs', 'session/main.mjs']) {
        const run = spawnSync(process.execPath, [join(out, entry)], { env: { PATH: process.env.PATH, EGRESS_URL: 'http://127.0.0.1:9' }, encoding: 'utf8', timeout: 30_000 })
        expect(run.status, entry).not.toBe(0)
        expect(run.stderr, entry).toMatch(/refusing to start without the guards/)
      }
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('refuses the test implementation even when it is handed over', () => {
    expect(() => requireProduction(testSessionUsers(), 'SessionUsers')).toThrow(/test/)
    expect(() => requireProduction(testQueryGuards, 'QueryGuards')).toThrow(/test/)
    const real = { kind: 'production' as const }
    expect(requireProduction(real, 'x')).toBe(real)
  })
})

describe('imports', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []))
  const src = fileURLToPath(new URL('../../src/', import.meta.url))

  // Static imports, re-exports and dynamic import(), in either quote style.
  const fromTest = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])[^'"`]*\/test\//

  it('the import check catches every form', () => {
    for (const line of [`import x from '../test/a'`, `import x from "../test/a"`, `export { x } from "../../test/a"`, `await import('../test/a')`, `await import("../test/a")`, `import "../test/side-effect"`]) {
      expect(line).toMatch(fromTest)
    }
    expect(`import x from '../src/a'`).not.toMatch(fromTest)
  })

  it('nothing in src/ imports from test/', () => {
    for (const f of files(src)) expect(readFileSync(f, 'utf8'), f).not.toMatch(fromTest)
  })

  it('the root (main, server, proxy, protocol) loads the SDK for types only', () => {
    const root = [join(src, 'main.ts'), ...files(join(src, 'server')), ...files(join(src, 'proxy')), ...files(join(src, 'protocol'))]
    for (const f of root) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/^import (?!type )[^\n]*'@anthropic-ai\/claude-agent-sdk'/m)
      expect(text, f).not.toMatch(/import\(\s*'@anthropic-ai\/claude-agent-sdk'/)
    }
  })
})
