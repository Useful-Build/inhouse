// The session process's run loop, with the SDK's query() mocked at the process boundary. Ways it could fail:
// - the query gets options that don't come from the run config, misses settingSources: [], or swaps sessionId/resume;
// - the guards aren't applied, a NODE_CHANNEL_ variable reaches the CLI's env, or a custom CLI spawn or MCP delivery
//   sneaks back in (the SDK's default spawn keeps the session's stdio from the CLI);
// - an interrupt that falls back to abort is reported as an SDK error;
// - an interrupt the SDK honours (its `error_during_execution` result, then its throw) is reported as an SDK error, while
//   a genuine SDK error with a throw and no interrupt is reported as anything but one;
// - a run ends twice, or not at all, when the query throws, is stopped, or the root sends garbage;
// - sessionEnv() grows a variable that isn't on its list (where a token could hide);
// - the session process keeps the inherited umask (022), so what it writes in /tmp is readable by other sessions;
// - production can start unguarded: no guards, injected host deps, or an audit hook that lets a call through.
// - a subagent's tool call counts against the main turn's lone deferred call, or a deferral whose id isn't the turn's
//   one call is taken;
// - after a stop, a slow files save runs out the root's grace before the checkpoint (the run loses it, its cost and a
//   deferred call's waiting state);
// - an audit entry carries no expiry, so the root writes one the hook already refused on its timeout;
// - the note on left-out files grows with the number of files, or counts the event's "and N more" as a name;
// - a stop's deadline doesn't cut a hanging checkpoint, or a query that ends after it still waits on the checkpoint;
// - a stop during the restore waits for it (past the stop's deadline);
// - a first run that wrote no main transcript sends no checkpoint (the Worker could never mark it waiting) or a
//   non-empty one; a resume that wrote none sends a checkpoint it can't back (protocol v2's checkpoint is the store's
//   total, which only a load can tell: R3's second PR).
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { fc, it } from '@fast-check/vitest'
import { afterAll, describe, expect } from 'vitest'
import { LOCAL_MAX_DEPTH, LineReader, encodeLine, type LineResult } from '../../src/protocol/ndjson.ts'
import { LEFT_OUT_MAX } from '../../src/files/files.ts'
import { AUDIT_ACK_MARGIN_MS, LEFT_OUT_NOTE_MAX_CHARS, SDK_MESSAGE_MAX_DEPTH, leftOutNote, runSession, type QueryFn } from '../../src/session/core.ts'
import { monotonicMs, parseSessionMessage } from '../../src/protocol/local.ts'
import { sessionEnv } from '../../src/session/env.ts'
import type { QueryGuards, RunContext } from '../../src/session/seam.ts'
import { AUDIT_HOOK_TIMEOUT_S, AuditRefusedError } from '../../src/guards/audit.ts'
import { DEFER, DEFERRED_TOOL, deferHook } from '../../src/guards/defer.ts'
import { sessionPaths, userPaths } from '../../src/guards/paths.ts'
import { poolUserName } from '../../src/guards/users.ts'
import { RunConfig } from '../../src/protocol/local.ts'
import { baseOptions, cliEnv } from '../../src/session/core.ts'
import { GuardsMissingError, productionHostDeps, productionQueryGuards, productionSessionUsers, requireProduction } from '../../src/server/production.ts'
import { runStart } from './support/root-client.ts'
import { PROXY_URL, fakeEgress, type FakeEgress } from './support/fake-egress.ts'
import { gate, testQueryGuards, testSessionUsers } from './support/test-seams.ts'

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

function harness(query: QueryFn, guards: QueryGuards = testQueryGuards, opts: { egress?: FakeEgress; auditTimeoutMs?: number; cwd?: string; env?: Record<string, string> } = {}) {
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
    env: { PATH: '/bin', NODE_CHANNEL_FD: '3', NODE_CHANNEL_SERIALIZATION_MODE: 'json', ...opts.env },
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

/**
 * `afterHold`: what the query yields once released (by `interrupt()`), and `thenThrow`: the error it throws after
 * everything it yielded, as the real SDK does after an `is_error` result ("Claude Code returned an error result").
 */
function fakeQuery(messages: SDKMessage[], opts: { throwAt?: number; holdUntilInterrupt?: boolean; interruptThrows?: boolean; abortThrows?: boolean; afterHold?: SDKMessage[]; thenThrow?: string } = {}) {
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
      for (const m of opts.afterHold ?? []) yield m
      if (opts.thenThrow !== undefined) throw new Error(opts.thenThrow)
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
      sessionStoreFlush: 'eager',
      model: c.model,
      effort: c.effort,
      maxTurns: c.maxTurns,
      maxBudgetUsd: c.maxBudgetUsd,
      settingSources: [],
      sessionId: c.sessionId,
      tools: ['Read'],
    })
    expect(options.resume).toBeUndefined()
    // The model settings (Claude Code's env-vars page): every alias on a model the egress allows, the default subagent
    // model the turn's (not forced: a helper's definition outranks it, N6), compaction at 600,000 (the 1M window kept).
    // The session env comes first, merged, not replaced.
    expect(options.env).toEqual({
      PATH: '/bin',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-5-5',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-sonnet-5-5',
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000',
    })
    expect(options.env).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')
    expect(options.env).not.toHaveProperty('CLAUDE_CODE_DISABLE_1M_CONTEXT')
    expect(options.systemPrompt).toBe(c.systemPrompt)
    // No proxy in this env: no inhouse server (production's sessionEnv always sets it; the next test).
    expect(options.mcpServers).toBeUndefined()
    expect(options.sessionStore).toBeDefined()
    expect(h.events().map((e) => e.type)).toEqual(['sdk', 'sdk', 'checkpoint', 'finished'])
    expect(h.events().at(-1)).toEqual({ type: 'finished', subtype: 'success', isError: false, numTurns: 2, costUsd: 0.01, usage: { input_tokens: 5 } })
  })

  it("the inhouse and apps servers go through the proxy, and the system prompt is the run's own", async () => {
    const q = fakeQuery([assistant, result])
    const h = harness(q.query, testQueryGuards, { env: { INHOUSE_PROXY_URL: 'http://127.0.0.1:8081' } })
    h.deliver({ type: 'run', config: config({ systemPrompt: 'You answer for the brand.' }) })
    await h.done
    const { options } = q.calls[0]!
    expect(options.mcpServers).toEqual({ inhouse: { type: 'http', url: 'http://127.0.0.1:8081/mcp/' }, apps: { type: 'http', url: 'http://127.0.0.1:8081/hub/' } })
    expect(options.systemPrompt).toBe('You answer for the brand.')
  })

  // Stage 1 (N6): the `actions` server is there only when the run config's `actions` is true; absent or false, the
  // session has the two servers it has today.
  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ])('the actions server (proxy /actions/) with actions %s: present %s', async (actions, present) => {
    const q = fakeQuery([assistant, result])
    const h = harness(q.query, testQueryGuards, { env: { INHOUSE_PROXY_URL: 'http://127.0.0.1:8081' } })
    h.deliver({ type: 'run', config: config(actions === undefined ? {} : { actions }) })
    await h.done
    const servers = q.calls[0]!.options.mcpServers as Record<string, unknown>
    expect(Object.keys(servers).sort()).toEqual(present ? ['actions', 'apps', 'inhouse'] : ['apps', 'inhouse'])
    if (present) expect(servers.actions).toEqual({ type: 'http', url: 'http://127.0.0.1:8081/actions/' })
  })

  it('resume: true passes resume, not sessionId; "" is passed as the prompt', async () => {
    const q = fakeQuery([result])
    const h = harness(q.query)
    const c = config({ resume: true, prompt: '', expect: { mainEntries: 1, lastUuid: null, lastUuidIndex: null } })
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
    h.deliver({ type: 'stop', endWithinMs: 5_000 })
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

  // The real SDK, asked to interrupt (live-turns.spec on the sandbox, and a local run of the real CLI): the turn ends with
  // an `error_during_execution` result (is_error), then the iteration throws "Claude Code returned an error result".
  const EDE = { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0.00007, usage: { input_tokens: 10 }, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'] } as unknown as SDKMessage
  const EDE_THROW = 'Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'
  const EDE_FINISHED = { type: 'finished', subtype: 'error_during_execution', isError: true, numTurns: 1, costUsd: 0.00007, usage: { input_tokens: 10 } }

  it("an interrupt the SDK honours (its error_during_execution result, then its throw) ends finished with that result", async () => {
    const q = fakeQuery([assistant], { holdUntilInterrupt: true, afterHold: [EDE], thenThrow: EDE_THROW })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    await waitForTicks(() => q.calls.length === 1)
    h.deliver({ type: 'interrupt' })
    await h.done
    expect(q.interrupts()).toBe(1)
    expect(h.events().filter((e) => e.type === 'failed' || e.type === 'finished')).toEqual([EDE_FINISHED])
  })

  it('an interrupt delivered with the run (pending until the query exists), honoured the same way, ends finished', async () => {
    const q = fakeQuery([assistant], { holdUntilInterrupt: true, afterHold: [EDE], thenThrow: EDE_THROW })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    h.deliver({ type: 'interrupt' })
    await h.done
    expect(q.interrupts()).toBe(1)
    expect(h.events().filter((e) => e.type === 'failed' || e.type === 'finished')).toEqual([EDE_FINISHED])
  })

  it('the same result and throw with no interrupt is an SDK error', async () => {
    const q = fakeQuery([assistant, EDE], { thenThrow: EDE_THROW })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(q.interrupts()).toBe(0)
    expect(h.events().filter((e) => e.type === 'failed' || e.type === 'finished')).toEqual([{ type: 'failed', reason: 'sdk_error', message: EDE_THROW }])
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
    h.deliver({ type: 'stop', endWithinMs: 5_000 })
    await h.done
    expect(q.calls).toHaveLength(0)
    expect(h.events()).toEqual([{ type: 'failed', reason: 'stopped', message: 'stopped before the query started' }])
  })

  it('a stop with no run ends the session as stopped; no query runs', async () => {
    const q = fakeQuery([result])
    const h = harness(q.query)
    h.deliver({ type: 'stop', endWithinMs: 5_000 })
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
    h.deliver({ type: 'stop', endWithinMs: 5_000 })
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

describe('stream events and the defer hook (Stage 1, N16)', () => {
  // The CLI streams a turn's calls one block per assistant message and runs a call's PreToolUse hook as its block
  // arrives; only the message's `message_stop` stream event says no sibling block is coming. Ways it could fail,
  // written first: stream events stay off (so nothing is ever deferred), reach the Worker as `sdk` events (the chat,
  // the transcript mirror and the ledger would see them), or the hook defers before the message is complete.
  const ev = (event: Record<string, unknown>, parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, uuid: 'x', session_id: 's', event }) as unknown as SDKMessage
  const block = (id: string, message: string) =>
    ({ type: 'assistant', parent_tool_use_id: null, message: { id: message, stop_reason: null, content: [{ type: 'tool_use', id, name: DEFERRED_TOOL, input: { question: 'Which?', options: ['A', 'B'] } }] } }) as unknown as SDKMessage
  const hookInput = (id: string) => ({ hook_event_name: 'PreToolUse', tool_name: DEFERRED_TOOL, tool_input: {}, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '/work/a' })
  /** The guards the session applies, keeping the run context the hooks get. */
  function capturing() {
    const box: { run: RunContext | null } = { run: null }
    const guards: QueryGuards = { kind: 'test', apply: (options, _c, run) => ((box.run = run), options) }
    return { guards, box }
  }

  it('asks the SDK for stream events and sends none to the Worker', async () => {
    const q = fakeQuery([ev({ type: 'message_start', message: { id: 'm1' } }), ev({ type: 'content_block_delta' }), assistant, ev({ type: 'message_stop' }), result])
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(q.calls[0]!.options.includePartialMessages).toBe(true)
    expect(types(h.events())).toEqual(['sdk', 'sdk', 'checkpoint', 'finished'])
    expect(h.events().filter((e) => e.type === 'sdk').map((e) => e.message.type)).toEqual(['assistant', 'result'])
  })

  it('a lone call is deferred once its message is complete; the deferral then ends the run waiting', async () => {
    const { guards, box } = capturing()
    let decided: unknown = 'pending'
    const q = scriptedQuery(async function* () {
      yield ev({ type: 'message_start', message: { id: 'm1' } })
      yield block('t1', 'm1')
      // The CLI runs the hook now, before the rest of the message has streamed.
      const hook = deferHook(box.run!).hooks[0]!(hookInput('t1') as never, 't1', { signal: new AbortController().signal }).then((d) => (decided = d))
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
      expect(decided).toBe('pending')
      yield ev({ type: 'message_delta' })
      yield ev({ type: 'message_stop' })
      await hook
      expect(decided).toEqual(DEFER)
      yield { ...(result as object), stop_reason: 'tool_deferred', deferred_tool_use: { id: 't1', name: DEFERRED_TOOL, input: { question: 'Which?', options: ['A', 'B'] } } } as unknown as SDKMessage
    })
    const h = harness(q.query, guards)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'sdk', 'deferred', 'checkpoint', 'finished'])
  })

  it('a call whose message carries a second call is not deferred (the second block streams after the hook fired)', async () => {
    const { guards, box } = capturing()
    let decided: unknown = 'pending'
    const q = scriptedQuery(async function* () {
      yield ev({ type: 'message_start', message: { id: 'm1' } })
      yield block('t1', 'm1')
      const hook = deferHook(box.run!).hooks[0]!(hookInput('t1') as never, 't1', { signal: new AbortController().signal }).then((d) => (decided = d))
      yield block('t2', 'm1')
      yield ev({ type: 'message_stop' })
      await hook
      expect(decided).toEqual({})
      yield toolResult('t1')
      yield result
    })
    const h = harness(q.query, guards)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(types(h.events())).not.toContain('deferred')
    expect(h.events().at(-1)?.type).toBe('finished')
  })
})

describe('resume verification (protocol v2 expect)', () => {
  const SID = '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11'
  const MAIN = { projectKey: 'k', sessionId: SID }
  /** A store holding `main` as the main transcript and `subs` subagent transcripts, written as one part each. */
  function seeded(main: unknown[], subs: Record<string, unknown[]> = {}) {
    const egress = fakeEgress()
    egress.parts.set(JSON.stringify(['k', SID, null]), new Map([['000000000000001-000001', main]]))
    for (const [sub, entries] of Object.entries(subs)) egress.parts.set(JSON.stringify(['k', SID, sub]), new Map([['000000000000001-000001', entries]]))
    return egress
  }
  /** A query that loads the main transcript first (as the SDK does on a resume), then calls the model. */
  function resumingQuery() {
    const seen = { modelCalled: false }
    const q = scriptedQuery(async function* ({ options }) {
      await options.sessionStore!.load(MAIN)
      seen.modelCalled = true
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [] } } as unknown as SDKMessage
      yield result
    })
    return { ...q, seen }
  }
  const resume = (expect: { mainEntries: number; lastUuid: string | null; lastUuidIndex: number | null }) => config({ resume: true, prompt: 'go on', expect })
  const three = [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'u2' }, { type: 'user', uuid: 'u3' }]

  it.each([
    ['a store missing early entries', [three[2]], { mainEntries: 3, lastUuid: 'u3', lastUuidIndex: 2 }],
    ['a store one entry short (uuids not checked)', three.slice(0, 2), { mainEntries: 3, lastUuid: null, lastUuidIndex: null }],
    ['a different uuid at mainEntries - 1', [three[0], three[1], { type: 'user', uuid: 'other' }], { mainEntries: 3, lastUuid: 'u3', lastUuidIndex: 2 }],
    ['an empty store', [], { mainEntries: 1, lastUuid: null, lastUuidIndex: null }],
  ])('%s: failed store, and the model is never called', async (_, main, expect_) => {
    const q = resumingQuery()
    const h = harness(q.query, testQueryGuards, { egress: seeded(main as unknown[]) })
    h.deliver({ type: 'run', config: resume(expect_) })
    await h.done
    expect(q.seen.modelCalled).toBe(false)
    expect(h.events().at(-1)).toMatchObject({ type: 'failed', reason: 'store' })
    expect(h.events().filter((e: { type: string }) => e.type === 'finished' || e.type === 'failed')).toHaveLength(1)
  })

  it("a subagent-heavy turn's resume passes: subagent transcripts don't count toward mainEntries", async () => {
    const q = resumingQuery()
    const subs = { 'subagents/agent-1': Array.from({ length: 12 }, (_, i) => ({ type: 'user', uuid: `s${i}` })) }
    const h = harness(q.query, testQueryGuards, { egress: seeded(three, subs) })
    h.deliver({ type: 'run', config: resume({ mainEntries: 3, lastUuid: 'u3', lastUuidIndex: 2 }) })
    await h.done
    expect(q.seen.modelCalled).toBe(true)
    expect(types(h.events())).toEqual(['sdk', 'sdk', 'checkpoint', 'finished'])
    // Nothing new written: the checkpoint is the store's main transcript as it stands.
    expect(h.events()[2]).toEqual({ type: 'checkpoint', mainEntries: 3, lastUuid: 'u3', lastUuidIndex: 2, runEntries: 0 })
  })

  it('a store holding more than expected (a flush after the last checkpoint) passes', async () => {
    const q = resumingQuery()
    const h = harness(q.query, testQueryGuards, { egress: seeded([...three, { type: 'assistant', uuid: 'u4' }]) })
    h.deliver({ type: 'run', config: resume({ mainEntries: 3, lastUuid: 'u3', lastUuidIndex: 2 }) })
    await h.done
    expect(h.events().at(-1)).toMatchObject({ type: 'finished' })
  })

  it('a resume whose query never loads the transcript ends failed store (nothing proved the transcript)', async () => {
    const q = fakeQuery([result])
    const h = harness(q.query, testQueryGuards, { egress: seeded(three) })
    h.deliver({ type: 'run', config: resume({ mainEntries: 3, lastUuid: 'u3', lastUuidIndex: 2 }) })
    await h.done
    expect(h.events().at(-1)).toEqual({ type: 'failed', reason: 'store', message: 'the resume never loaded its transcript from the store' })
  })
})

const toolUse = (...ids: string[]) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: ids.map((id) => ({ type: 'tool_use', id, name: 'mcp__inhouse__question_ask', input: {} })) } }) as unknown as SDKMessage
const toolResult = (id: string) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }) as unknown as SDKMessage
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

  it("a subagent's tool calls don't count against the main turn's lone call", async () => {
    const sub = { type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_use', id: 's1', name: 'Read', input: {} }] } } as unknown as SDKMessage
    const h = harness(fakeQuery([toolUse('t1'), sub, deferredResult('t1')]).query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(h.events().find((e) => e.type === 'deferred')).toMatchObject({ toolUseId: 't1' })
    expect(h.events().at(-1)?.type).toBe('finished')
  })

  it("a deferral whose id isn't the turn's one call is refused", async () => {
    const h = harness(fakeQuery([toolUse('t1'), deferredResult('t9')]).query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'sdk', 'checkpoint', 'failed'])
    expect(h.events().at(-1)).toMatchObject({ reason: 'sdk_error' })
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
    expect(h.events()[2]).toEqual({ type: 'checkpoint', mainEntries: 2, lastUuid: 'u2', lastUuidIndex: 1, runEntries: 2 })
    expect(egress.entries({ projectKey: 'k', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11' }).map((e: any) => e.uuid)).toEqual(['u1', 'u2'])
    expect(h.logs).toContainEqual({ type: 'store_repaired', batches: 1 })
  })

  it('the store: a first run that wrote no main transcript checkpoints an empty store', async () => {
    const q = fakeQuery([result])
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config({ resume: false }) })
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'checkpoint', 'finished'])
    expect(h.events()[1]).toEqual({ type: 'checkpoint', mainEntries: 0, lastUuid: null, lastUuidIndex: null, runEntries: 0 })
  })

  // #132's interim rule (a resume that wrote nothing was always a mirror_error) is replaced by the real load: a resume
  // that loaded its transcript and wrote nothing checkpoints the store's state (the resume verification tests below).
  // One whose query got a result without ever calling the store fails `store` (nothing proved the transcript), but the
  // store is untouched: no checkpoint and no mirror error, so the chat keeps its last good state.
  it('the store: a resume that got a result without touching the store fails store, with no checkpoint or mirror error', async () => {
    const q = fakeQuery([result])
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config({ resume: true, expect: { mainEntries: 4, lastUuid: 'u', lastUuidIndex: 3 } }) })
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'failed'])
    expect(h.events()[1]).toEqual({ type: 'failed', reason: 'store', message: 'the resume never loaded its transcript from the store' })
    expect(h.sent).not.toContainEqual({ type: 'query_started' })
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

  it('after a stop, the checkpoint comes before the files', async () => {
    const g = gate()
    const q = scriptedQuery(async function* ({ options }) {
      writeFileSync(join(options.cwd!, 'outputs', 'answer.txt'), 'forty-two')
      yield assistant
      await g.promise
    })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config({ fileCaps: { maxFileBytes: 1000, maxFilesPerTurn: 5, maxRestoreBytes: 1000, allowedTypes: ['text/plain'] } }) })
    await waitForTicks(() => h.events().length > 0)
    h.deliver({ type: 'stop', endWithinMs: 5_000 })
    g.open()
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'checkpoint', 'file_saved', 'failed'])
    expect(h.events().at(-1)).toMatchObject({ reason: 'stopped' })
  })

  it("a stop during a slow files save: the save gives way, the checkpoint goes first, and the run ends by the stop's deadline", async () => {
    const egress = fakeEgress()
    const real = egress.fetch
    let puts = 0
    // Every upload hangs: only the stop's deadline ends the save.
    egress.fetch = (url, init) => (init.method === 'PUT' ? (puts++, new Promise<Response>(() => {})) : real(url, init))
    const key = { projectKey: 'k', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11' }
    const q = scriptedQuery(async function* ({ options }) {
      await options.sessionStore!.append(key, [{ type: 'user', uuid: 'u1' }])
      writeFileSync(join(options.cwd!, 'outputs', 'answer.txt'), 'forty-two')
      yield result
    })
    const h = harness(q.query, testQueryGuards, { egress })
    h.deliver({ type: 'run', config: config({ fileCaps: { maxFileBytes: 1000, maxFilesPerTurn: 5, maxRestoreBytes: 1000, allowedTypes: ['text/plain'] } }) })
    await waitForTicks(() => puts === 1)
    h.deliver({ type: 'stop', endWithinMs: 200 })
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'checkpoint', 'finished'])
    expect(h.events().at(-1)).toMatchObject({ costUsd: 0.01 })
    expect(puts).toBe(2)
    expect(h.logs).toContainEqual({ type: 'files_save_cut', why: "the stop's deadline" })
  })

  it("a stop's deadline cuts a hanging checkpoint: mirror_error, then one terminal", async () => {
    const egress = fakeEgress()
    const real = egress.fetch
    // The checkpoint's load never answers.
    egress.fetch = (url, init) => (url.endsWith('/store/load') ? new Promise<Response>(() => {}) : real(url, init))
    const g = gate()
    const q = scriptedQuery(async function* ({ options }) {
      await options.sessionStore!.append({ projectKey: 'k', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11' }, [{ type: 'user', uuid: 'u1' }])
      yield assistant
      await g.promise
    })
    const h = harness(q.query, testQueryGuards, { egress })
    h.deliver({ type: 'run', config: config() })
    await waitForTicks(() => h.events().length > 0)
    h.deliver({ type: 'stop', endWithinMs: 100 })
    g.open()
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'mirror_error', 'failed'])
    expect(h.events()[1]).toEqual({ type: 'mirror_error', message: "the store's checkpoint did not finish before the stop's deadline" })
    expect(h.events().at(-1)).toMatchObject({ reason: 'stopped' })
  })

  it("a query that ends after the stop's deadline: no checkpoint wait, mirror_error, then one terminal", async () => {
    const endWithinMs = 50
    const g = gate()
    const q = scriptedQuery(async function* ({ options }) {
      await options.sessionStore!.append({ projectKey: 'k', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11' }, [{ type: 'user', uuid: 'u1' }])
      yield assistant
      await g.promise
    })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    await waitForTicks(() => h.events().length > 0)
    h.deliver({ type: 'stop', endWithinMs })
    // Same delay, set after the session's deadline timer: Node fires it after that one (timers of one duration run in
    // the order they were set), so the query ends only once the deadline has passed.
    setTimeout(() => g.open(), endWithinMs)
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'mirror_error', 'failed'])
    expect(h.events().at(-1)).toMatchObject({ reason: 'stopped' })
  })

  it('a stop during a slow restore cuts it at once: stopped, with no query', async () => {
    const egress = fakeEgress()
    egress.files.set('inputs/a.txt', { body: new TextEncoder().encode('a') })
    const real = egress.fetch
    let gets = 0
    // The download never answers: only the stop can end the restore.
    egress.fetch = (url, init) => (url.endsWith('/files/inputs/a.txt') ? (gets++, new Promise<Response>(() => {})) : real(url, init))
    const q = fakeQuery([result])
    const h = harness(q.query, testQueryGuards, { egress })
    h.deliver({ type: 'run', config: config({ fileCaps: { maxFileBytes: 10, maxFilesPerTurn: 1, maxRestoreBytes: 10, allowedTypes: ['text/plain'] } }) })
    await waitForTicks(() => gets === 1)
    h.deliver({ type: 'stop', endWithinMs: 60_000 })
    await h.done
    expect(q.calls).toHaveLength(0)
    expect(h.events()).toEqual([{ type: 'failed', reason: 'stopped', message: 'stopped before the query started' }])
    // No query: the root's `released` says so (queryRan: false), and the Worker keeps the chat's last good state.
    expect(h.sent).not.toContainEqual({ type: 'query_started' })
  })

  it("query_started goes to the root on the SDK's first store call, not when the query is called", async () => {
    let sentAtQuery: unknown[] = []
    let sentAfterLoad: unknown[] = []
    const holder: { h?: ReturnType<typeof harness> } = {}
    const q = scriptedQuery(async function* ({ options }) {
      sentAtQuery = [...holder.h!.sent]
      await options.sessionStore!.load({ projectKey: 'k', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11' })
      sentAfterLoad = [...holder.h!.sent]
      yield result
    })
    holder.h = harness(q.query)
    holder.h.deliver({ type: 'run', config: config() })
    await holder.h.done
    expect(sentAtQuery).not.toContainEqual({ type: 'query_started' })
    expect(sentAfterLoad.filter((m) => JSON.stringify(m) === '{"type":"query_started"}')).toHaveLength(1)
    expect(holder.h.sent.filter((m) => JSON.stringify(m) === '{"type":"query_started"}')).toHaveLength(1)
  })

  // #137 review round 1 (high): a resume that ends before the SDK's first store call keeps its own terminal, sends no
  // query_started, and emits no checkpoint or mirror error (the root's released is then { checkpoint: null,
  // queryRan: false }: lifecycle.test.ts proves that end to end with this core). Each failed on 52bd866.
  describe('a resume that ends before the SDK touched the store', () => {
    const resumeConfig = () => config({ resume: true, prompt: 'go on', expect: { mainEntries: 3, lastUuid: 'u3', lastUuidIndex: 2 } })
    /** A query that waits (before any store call) until interrupted or aborted. */
    function waitingQuery(opts: { interruptThrows: boolean }) {
      let wake!: () => void
      const woken = new Promise<void>((r) => (wake = r))
      const calls: unknown[] = []
      const query: QueryFn = (params) => {
        calls.push(params)
        const signal = params.options.abortController!.signal
        signal.addEventListener('abort', () => wake(), { once: true })
        return Object.assign(
          (async function* () {
            await woken
            if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          })(),
          {
            interrupt: async () => {
              if (opts.interruptThrows) throw new Error('needs streaming input')
              wake()
            },
          },
        ) as unknown as ReturnType<QueryFn>
      }
      return { query, calls }
    }
    const noStoreTrace = (h: ReturnType<typeof harness>) => {
      expect(h.events().filter((e: { type: string }) => e.type === 'checkpoint' || e.type === 'mirror_error')).toEqual([])
      expect(h.sent).not.toContainEqual({ type: 'query_started' })
    }

    it('a stop: failed stopped', async () => {
      const q = waitingQuery({ interruptThrows: false })
      const h = harness(q.query)
      h.deliver({ type: 'run', config: resumeConfig() })
      await waitForTicks(() => q.calls.length === 1)
      h.deliver({ type: 'stop', endWithinMs: 60_000 })
      await h.done
      expect(h.events().at(-1)).toEqual({ type: 'failed', reason: 'stopped', message: 'stopped' })
      noStoreTrace(h)
    })

    it('an interrupt (falling back to the abort signal): failed interrupted', async () => {
      const q = waitingQuery({ interruptThrows: true })
      const h = harness(q.query)
      h.deliver({ type: 'run', config: resumeConfig() })
      await waitForTicks(() => q.calls.length === 1)
      h.deliver({ type: 'interrupt' })
      await h.done
      expect(h.events().at(-1)).toEqual({ type: 'failed', reason: 'interrupted', message: 'interrupted' })
      noStoreTrace(h)
    })

    it('a stop after the SDK wrote but before it loaded: stopped (failed store is only for an unstopped query)', async () => {
      let wake!: () => void
      const woken = new Promise<void>((r) => (wake = r))
      const q = scriptedQuery(async function* ({ options }) {
        options.abortController!.signal.addEventListener('abort', () => wake(), { once: true })
        await options.sessionStore!.append({ projectKey: 'k', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11' }, [{ type: 'user', uuid: 'w1' }])
        await woken
      })
      const real = q.query
      const query: QueryFn = (params) => Object.assign(real(params), { interrupt: async () => wake() })
      // The store holds the three entries the resume expects.
      const egress = fakeEgress()
      egress.parts.set(JSON.stringify(['k', '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11', null]), new Map([['000000000000001-000001', [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'u2' }, { type: 'user', uuid: 'u3' }]]]))
      const h = harness(query, testQueryGuards, { egress })
      h.deliver({ type: 'run', config: resumeConfig() })
      await waitForTicks(() => h.sent.some((m) => JSON.stringify(m) === '{"type":"query_started"}'))
      h.deliver({ type: 'stop', endWithinMs: 60_000 })
      await h.done
      expect(h.events().at(-1)).toEqual({ type: 'failed', reason: 'stopped', message: 'stopped' })
      // It touched the store: its checkpoint reports what the store holds (the three, then its own).
      expect(h.events().filter((e: { type: string }) => e.type === 'checkpoint')).toEqual([{ type: 'checkpoint', mainEntries: 4, lastUuid: 'w1', lastUuidIndex: 3, runEntries: 1 }])
    })

    // Round 2: a failed read can't change the transcript. Opus's probe: the store holds u1..u3, the first load answers
    // 503 and the query (awaiting the load) fails with it. Failed at b3f5503 (touched before the POST).
    it('a first load that fails (503): sdk_error, no query_started, no checkpoint or mirror error', async () => {
      const egress = fakeEgress()
      egress.parts.set(JSON.stringify(['k', '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11', null]), new Map([['000000000000001-000001', [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'u2' }, { type: 'user', uuid: 'u3' }]]]))
      let loads = 0
      egress.fail = (_m, p) => (p === '/store/load' && loads++ === 0 ? 503 : null)
      const q = scriptedQuery(async function* ({ options }) {
        await options.sessionStore!.load({ projectKey: 'k', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11' })
        yield result
      })
      const h = harness(q.query, testQueryGuards, { egress })
      h.deliver({ type: 'run', config: resumeConfig() })
      await h.done
      expect(h.events().at(-1)).toEqual({ type: 'failed', reason: 'sdk_error', message: 'store load: 503' })
      noStoreTrace(h)
    })

    it('an SDK error: failed sdk_error', async () => {
      const h = harness(fakeQuery([result], { throwAt: 0 }).query)
      h.deliver({ type: 'run', config: resumeConfig() })
      await h.done
      expect(h.events().at(-1)).toEqual({ type: 'failed', reason: 'sdk_error', message: 'the CLI exited' })
      noStoreTrace(h)
    })
  })

  it(`past ${LEFT_OUT_MAX} left-out files, the note still counts every one (the event's "and N more" is not a name)`, async () => {
    const egress = fakeEgress()
    const total = LEFT_OUT_MAX + 200
    for (let i = 0; i < total; i++) egress.files.set(`inputs/${i}.txt`, { body: new Uint8Array(2) })
    const q = fakeQuery([result])
    const h = harness(q.query, testQueryGuards, { egress })
    h.deliver({ type: 'run', config: config({ prompt: 'go', fileCaps: { maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 1, allowedTypes: [] } }) })
    await h.done
    const text = (await promptText(q.calls[0]!.prompt)).text
    const m = /work folder: (.*), and (\d+) more\]$/.exec(text)
    expect(m).not.toBeNull()
    expect(m![1]).not.toMatch(/more/)
    expect(m![1]!.split(', ').length + Number(m![2])).toBe(total)
  })

  it('the note on left-out files stays under its cap, saying how many more', () => {
    const names = Array.from({ length: 5000 }, (_, i) => `inputs/file-${i}.pdf`)
    const note = leftOutNote(names)
    expect(note.length).toBeLessThan(LEFT_OUT_NOTE_MAX_CHARS + 200)
    expect(note).toMatch(/and \d+ more\]$/)
    expect(leftOutNote(['inputs/a.pdf'])).toBe("[The chat's files over the restore size cap were not brought into the work folder: inputs/a.pdf]")
  })

  it('the "" resume prompt stays a plain empty string, even with files left out', async () => {
    const egress = fakeEgress()
    egress.files.set('inputs/huge.txt', { body: new Uint8Array(5000) })
    const q = fakeQuery([result])
    const h = harness(q.query, testQueryGuards, { egress })
    h.deliver({ type: 'run', config: config({ resume: true, prompt: '', expect: { mainEntries: 1, lastUuid: null, lastUuidIndex: null }, fileCaps: { maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 10, allowedTypes: [] } }) })
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

  // Root makes any folder (EACCES never comes), so this runs as a plain user only.
  ;(process.getuid?.() === 0 ? it.skip : it)("a restore that fails on the file system logs the error's code, never its message (a stored file's folder)", async () => {
    const cwd = workDir()
    mkdirSync(join(cwd, 'inputs'))
    chmodSync(join(cwd, 'inputs'), 0o500)
    try {
      const egress = fakeEgress()
      egress.files.set('inputs/CANARY-folder/a.txt', { body: new Uint8Array(3) })
      const h = harness(fakeQuery([result]).query, testQueryGuards, { egress, cwd })
      h.deliver({ type: 'run', config: config() })
      await h.done
      expect(h.events()).toEqual([{ type: 'failed', reason: 'files', message: "the chat's files could not be brought into the work folder" }])
      expect(h.logs).toContainEqual({ type: 'files_restore_failed', code: 'EACCES', syscall: 'mkdir' })
      expect(JSON.stringify(h.logs)).not.toContain('CANARY')
    } finally {
      chmodSync(join(cwd, 'inputs'), 0o700)
    }
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
    const expiresAt = expect.any(Number)
    expect(audits(h.sent)).toEqual([{ type: 'audit', id: 0, expiresAt, entry }, { type: 'audit', id: 1, expiresAt, entry: { ...entry, toolName: 'Read' } }])
    h.deliver({ type: 'audit_nack', id: 1, error: 'the Worker has gone' })
    h.deliver({ type: 'audit_ack', id: 0 })
    await expect(a).resolves.toBeUndefined()
    await expect(b).rejects.toThrow(/the Worker has gone/)
    q.release()
    await h.done
  })

  it('each entry says when the hook stops waiting for it, less the margin for the ack', async () => {
    const { h, q, audit } = held()
    await waitForTicks(() => audit() !== undefined)
    // On the monotonic clock both ends share (a wall clock can step between them).
    const t0 = monotonicMs()
    void audit()(entry).catch(() => undefined)
    const t1 = monotonicMs()
    const sent = audits(h.sent)[0]
    expect(sent.expiresAt).toBeGreaterThanOrEqual(t0 + 10_000 - AUDIT_ACK_MARGIN_MS)
    expect(sent.expiresAt).toBeLessThanOrEqual(t1 + 10_000 - AUDIT_ACK_MARGIN_MS)
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
    expect(parseSessionMessage({ type: 'audit', id: 3, expiresAt: 1, entry })).toEqual({ ok: true, message: { type: 'audit', id: 3, expiresAt: 1, entry } })
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
        'PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'INHOUSE_PROXY_URL',
        'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER',
        'MCP_CONNECTION_NONBLOCKING', 'MCP_CONNECT_TIMEOUT_MS',
        // Stage 1 (N6, N14): the helpers' caps, the foreground switches and the MCP tool timeout.
        'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', 'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS',
        'CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS', 'MCP_TOOL_TIMEOUT',
      ].sort(),
    )
    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}/model`)
    expect(new URL(env.INHOUSE_PROXY_URL!).username + new URL(env.INHOUSE_PROXY_URL!).password).toBe('')
    expect(env.MCP_CONNECTION_NONBLOCKING).toBe('0')
    expect(env.MCP_CONNECT_TIMEOUT_MS).toBe('15000')
    // Literal values (the env-vars page, read 2026-11-26): one layer of helpers, four at once, no built-in agents, no
    // forks, nothing in the background, MCP calls up to 180 s.
    expect(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe('1')
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('4')
    expect(env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBe('1')
    expect(env.CLAUDE_CODE_FORK_SUBAGENT).toBe('0')
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1')
    expect(env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS).toBe('0')
    expect(env.MCP_TOOL_TIMEOUT).toBe('180000')
    expect(env).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')
  })
})

describe('the production wiring', () => {
  // R2 wired the real guards: the session's guards are production ones, and the root refuses to start on a host whose
  // /etc/passwd lacks the image's session user pool (any test host).
  it('wires the real guards, and the root refuses a host without the session user pool', () => {
    expect(productionQueryGuards().kind).toBe('production')
    expect(() => productionSessionUsers()).toThrow(/pool user s00 is missing/)
  })

  // The bundle the image runs, built by the package's own build script into a temp folder.
  it('the bundled root refuses to start without the session user pool, the session entry gets past its guards, and zod is bundled as ESM', () => {
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

      // Reports the umask the process ends with, however it ends.
      const preload = join(out, 'umask.cjs')
      writeFileSync(preload, "process.on('exit', () => process.stderr.write('umask=' + process.umask().toString(8) + '\\n'))")
      // fds 3 and 4 are the session's channel, as the root spawns it (src/server/session-host.ts).
      const start = (entry: string) =>
        spawnSync(process.execPath, ['--require', preload, join(out, entry)], {
          env: { PATH: process.env.PATH, EGRESS_URL: 'http://127.0.0.1:9' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        })
      const root = start('main.mjs')
      expect(root.status).not.toBe(0)
      expect(root.stderr).toMatch(/pool user s00 is missing/)
      // Outside the package the SDK can't load: the session ends there, after its guards were built.
      const session = start('session/main.mjs')
      expect(session.status).not.toBe(0)
      expect(session.stderr).not.toMatch(/refusing to start without the guards/)
      expect(session.stderr).toMatch(/claude-agent-sdk/)
      // The session entry sets umask 077 first thing: what it (and the CLI and Bash under it) writes is its own.
      expect(session.stderr).toMatch(/^umask=77$/m)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('production cannot run a tool call unrecorded (blocked on the transport\'s nack), takes no injected host deps, and refuses a missing guard', async () => {
    const config = RunConfig.parse({
      runId: 'r1', chatId: 'chat1', sessionId: '00000000-0000-4000-8000-000000000000', resume: false, prompt: 'hi',
      model: 'claude-sonnet-5-5', sideModel: 'claude-haiku-5-5', systemPrompt: '', attachments: [], expect: null,
      effort: 'low', maxTurns: 1, maxBudgetUsd: 1, webFetchDomains: [],
      fileCaps: { maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 0, allowedTypes: [] },
    })
    // The run's real audit transport (R1's, src/session/core.ts), on a channel this test answers for the root.
    let run: RunContext | undefined
    const q = fakeQuery([assistant], { holdUntilInterrupt: true })
    const h = harness(q.query, { kind: 'test', apply: (o, _c, r) => ((run = r), o) })
    h.deliver({ type: 'run', config: config })
    await waitForTicks(() => run !== undefined)

    const p = sessionPaths(config.chatId)
    const env = sessionEnv({ uid: 30001, gid: 30001, user: 's01', home: userPaths('s01').home, workDir: p.workDir }, 8081)
    const o = productionQueryGuards().apply(baseOptions(config, p.workDir, cliEnv(env), new AbortController()), config, run!)
    // Two matchers take every tool: the helper hook, then the audit hook (the one with the engine timeout).
    const every = o.hooks!.PreToolUse!.filter((m) => m.matcher === undefined)
    expect(every).toHaveLength(2)
    const audit = every.filter((m) => m.timeout === AUDIT_HOOK_TIMEOUT_S)
    expect(audit).toHaveLength(1)
    const m = audit[0]!
    expect(m.onFailure).toBe('block')
    const call = (id: string) =>
      m.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: id, session_id: 's', transcript_path: '', cwd: p.workDir } as never, id, {
        signal: new AbortController().signal,
      })
    const sentAudits = () => h.sent.filter((x) => x.type === 'audit')

    // The root nacks: the call is blocked.
    const refused = call('u1')
    await waitForTicks(() => sentAudits().length === 1)
    expect(sentAudits()[0]).toMatchObject({ type: 'audit', id: 0, entry: { hook: 'PreToolUse', toolName: 'Bash', toolUseId: 'u1', input: { cut: false, value: { command: 'ls' } } } })
    h.deliver({ type: 'audit_nack', id: 0, error: 'the Worker has gone' })
    await expect(refused).rejects.toThrow(AuditRefusedError)
    await expect(refused).rejects.toThrow(/the Worker has gone/)
    // The root acks: only then does the call go.
    const allowed = call('u2')
    await waitForTicks(() => sentAudits().length === 2)
    h.deliver({ type: 'audit_ack', id: 1 })
    await expect(allowed).resolves.toEqual({})
    q.release()
    await h.done

    const pool = Array.from({ length: 2 }, (_, i) => ({ user: poolUserName(i), uid: 30000 + i, gid: 30000 + i }))
    expect(Object.keys(productionHostDeps(pool))).toEqual(['poolUids'])
    expect(() => requireProduction(undefined, 'QueryGuards')).toThrow(GuardsMissingError)
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

// Structured output (R3 follow-up). Ways it could fail, written first:
// - the format isn't passed to the SDK, or is passed when not asked for;
// - a success's structured_output doesn't reach the terminal event, or reaches it when not asked for;
// - a success without one, one over 64 KB, or the SDK's retries running out ends as anything but failed structured_output
//   (the SDK throws after its error result: that must not read as a crash, sdk_error);
// - a deferred call, an error result or a stop is turned into a structured-output failure.
describe('structured output', () => {
  const SCHEMA = { type: 'object', properties: { late_orders: { type: 'integer' } }, required: ['late_orders'] }
  const asked = () => config({ outputFormat: { type: 'json_schema', schema: SCHEMA } })
  const withOutput = (value: unknown) => ({ ...(result as object), structured_output: value }) as unknown as SDKMessage
  const terminal = (h: ReturnType<typeof harness>) => h.events().at(-1)

  it('the format goes to the SDK, and the success carries its value on the terminal event', async () => {
    const q = fakeQuery([assistant, withOutput({ late_orders: 3 })])
    const h = harness(q.query)
    h.deliver({ type: 'run', config: asked() })
    await h.done
    expect(q.calls[0]!.options.outputFormat).toEqual({ type: 'json_schema', schema: SCHEMA })
    expect(terminal(h)).toEqual({ type: 'finished', subtype: 'success', isError: false, numTurns: 2, costUsd: 0.01, usage: { input_tokens: 5 }, structuredOutput: { late_orders: 3 } })
  })

  it('not asked: no format to the SDK, and a structured_output on the result is not passed on', async () => {
    const q = fakeQuery([withOutput({ late_orders: 3 })])
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    await h.done
    expect(q.calls[0]!.options.outputFormat).toBeUndefined()
    expect(terminal(h)).not.toHaveProperty('structuredOutput')
    expect(terminal(h)).toMatchObject({ type: 'finished', subtype: 'success' })
  })

  it('asked, and a success without one: failed structured_output', async () => {
    const h = harness(fakeQuery([result]).query)
    h.deliver({ type: 'run', config: asked() })
    await h.done
    expect(terminal(h)).toEqual({ type: 'failed', reason: 'structured_output', message: 'the run ended (success) without the structured output it was asked for' })
  })

  it('asked, and one over 64 KB: failed structured_output; at the cap it passes', async () => {
    const sized = (bytes: number) => ({ a: 'x'.repeat(bytes - 8) })
    const over = harness(fakeQuery([withOutput(sized(64 * 1024 + 1))]).query)
    over.deliver({ type: 'run', config: asked() })
    await over.done
    expect(terminal(over)).toMatchObject({ type: 'failed', reason: 'structured_output' })
    const at = harness(fakeQuery([withOutput(sized(64 * 1024))]).query)
    at.deliver({ type: 'run', config: asked() })
    await at.done
    expect(terminal(at)).toMatchObject({ type: 'finished', structuredOutput: sized(64 * 1024) })
  })

  it("the SDK's retries running out (its error result, then its throw): failed structured_output, not sdk_error", async () => {
    const retries = { ...(result as object), subtype: 'error_max_structured_output_retries', is_error: true } as unknown as SDKMessage
    const h = harness(fakeQuery([assistant, retries], { throwAt: 2 }).query)
    h.deliver({ type: 'run', config: asked() })
    await h.done
    expect(terminal(h)).toEqual({ type: 'failed', reason: 'structured_output', message: 'the agent could not produce output matching the schema' })
  })

  it('asked, and the result is an error (is_error): it keeps its own end', async () => {
    const h = harness(fakeQuery([{ ...(result as object), is_error: true } as unknown as SDKMessage]).query)
    h.deliver({ type: 'run', config: asked() })
    await h.done
    expect(terminal(h)).toMatchObject({ type: 'finished', isError: true })
    expect(terminal(h)).not.toHaveProperty('structuredOutput')
  })

  // #151 review round 1.
  it('asked: a clean end of any subtype without an output (error_max_turns, is_error false) fails structured_output; is_error true keeps finished', async () => {
    const maxTurns = harness(fakeQuery([{ ...(result as object), subtype: 'error_max_turns', is_error: false } as unknown as SDKMessage]).query)
    maxTurns.deliver({ type: 'run', config: asked() })
    await maxTurns.done
    expect(terminal(maxTurns)).toEqual({ type: 'failed', reason: 'structured_output', message: 'the run ended (error_max_turns) without the structured output it was asked for' })
    const isError = harness(fakeQuery([{ ...(result as object), subtype: 'error_max_turns', is_error: true } as unknown as SDKMessage]).query)
    isError.deliver({ type: 'run', config: asked() })
    await isError.done
    expect(terminal(isError)).toMatchObject({ type: 'finished', subtype: 'error_max_turns', isError: true })
  })

  it('the 64 KB cap counts UTF-8 bytes, not characters: multibyte at the cap passes, one byte over fails', async () => {
    // {"a":"…"} is 8 bytes of framing; each é is 2 bytes in UTF-8 but one character.
    const atCap = { a: 'é'.repeat((64 * 1024 - 8) / 2) }
    const overCap = { a: `${'é'.repeat((64 * 1024 - 8) / 2)}x` }
    expect(JSON.stringify(overCap).length).toBeLessThan(64 * 1024)
    const at = harness(fakeQuery([withOutput(atCap)]).query)
    at.deliver({ type: 'run', config: asked() })
    await at.done
    expect(terminal(at)).toMatchObject({ type: 'finished', structuredOutput: atCap })
    const over = harness(fakeQuery([withOutput(overCap)]).query)
    over.deliver({ type: 'run', config: asked() })
    await over.done
    expect(terminal(over)).toEqual({ type: 'failed', reason: 'structured_output', message: 'the structured output is 65537 bytes, over the 65536-byte cap' })
  })

  it('an output 64 levels deep passes; 65 fails structured_output (before the channel would refuse it)', async () => {
    const nest = (n: number): unknown => (n === 0 ? 1 : [nest(n - 1)])
    const at = harness(fakeQuery([withOutput(nest(64))]).query)
    at.deliver({ type: 'run', config: asked() })
    await at.done
    expect(terminal(at)).toMatchObject({ type: 'finished', structuredOutput: nest(64) })
    const deep = harness(fakeQuery([withOutput(nest(65))]).query)
    deep.deliver({ type: 'run', config: asked() })
    await deep.done
    expect(terminal(deep)).toEqual({ type: 'failed', reason: 'structured_output', message: 'the structured output nests deeper than 64 levels' })
  })

  // A result the SDK already gave wins over a stop that races it (no change in behaviour, pinned here).
  it.each([
    ['a success without an output', { subtype: 'success', is_error: false }, 'the run ended (success) without the structured output it was asked for'],
    ['the retries running out', { subtype: 'error_max_structured_output_retries', is_error: true }, 'the agent could not produce output matching the schema'],
  ])('a stop racing %s: failed structured_output, not stopped', async (_, over, message) => {
    let wake!: () => void
    const woken = new Promise<void>((r) => (wake = r))
    const q = scriptedQuery(async function* () {
      yield assistant
      await woken
      // The stop has arrived (stopping is set); the SDK still hands over its result.
      yield { ...(result as object), ...over } as unknown as SDKMessage
    })
    const query: QueryFn = (params) => Object.assign(q.query(params), { interrupt: async () => wake() })
    const h = harness(query)
    h.deliver({ type: 'run', config: asked() })
    await waitForTicks(() => h.events().some((e: { type: string }) => e.type === 'sdk'))
    h.deliver({ type: 'stop', endWithinMs: 60_000 })
    await h.done
    expect(terminal(h)).toEqual({ type: 'failed', reason: 'structured_output', message })
  })

  it('asked, and the run deferred a call: deferred, then finished (the answer comes on the resume)', async () => {
    const h = harness(fakeQuery([toolUse('t1'), deferredResult('t1')]).query)
    h.deliver({ type: 'run', config: asked() })
    await h.done
    expect(types(h.events())).toEqual(['sdk', 'sdk', 'deferred', 'checkpoint', 'finished'])
  })
})
