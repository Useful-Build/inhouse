// The session process's run loop, with the SDK's query() mocked at the process boundary. Ways it could fail:
// - the query gets options that don't come from the run config, misses settingSources: [], or swaps sessionId/resume;
// - the guards aren't applied, a NODE_CHANNEL_ variable reaches the CLI's env, or a custom CLI spawn or MCP delivery
//   sneaks back in (the SDK's default spawn keeps the session's stdio from the CLI);
// - an interrupt that falls back to abort is reported as an SDK error;
// - a run ends twice, or not at all, when the query throws, is stopped, or the root sends garbage;
// - sessionEnv() grows a variable that isn't on its list (where a token could hide);
// - the session process keeps the inherited umask (022), so what it writes in /tmp is readable by other sessions;
// - production can start unguarded: no guards, injected host deps, or an audit hook that lets a call through.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { LOCAL_MAX_DEPTH, LineReader, encodeLine, type LineResult } from '../../src/protocol/ndjson.ts'
import { SDK_MESSAGE_MAX_DEPTH, runSession, type QueryFn } from '../../src/session/core.ts'
import { sessionEnv } from '../../src/session/env.ts'
import type { QueryGuards } from '../../src/session/seam.ts'
import { AuditRefusedError } from '../../src/guards/audit.ts'
import { sessionPaths } from '../../src/guards/paths.ts'
import { poolUserName } from '../../src/guards/users.ts'
import { RunConfig } from '../../src/protocol/local.ts'
import { baseOptions, cliEnv } from '../../src/session/core.ts'
import { GuardsMissingError, productionHostDeps, productionQueryGuards, productionSessionUsers, requireProduction } from '../../src/server/production.ts'
import { runStart } from './support/root-client.ts'
import { testQueryGuards, testSessionUsers } from './support/test-seams.ts'

const result = { type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 5 } } as unknown as SDKMessage
const assistant = { type: 'assistant', message: { content: [] } } as unknown as SDKMessage

function harness(query: QueryFn, guards: QueryGuards = testQueryGuards) {
  const sent: any[] = []
  let handler: (line: LineResult) => void = () => {}
  const done = runSession({
    channel: { send: (m) => void sent.push(m), onMessage: (h) => (handler = h) },
    query,
    guards,
    cwd: '/work/s1',
    env: { PATH: '/bin', NODE_CHANNEL_FD: '3', NODE_CHANNEL_SERIALIZATION_MODE: 'json' },
  })
  const events = () => sent.filter((m) => m.type === 'event').map((m) => m.event)
  return { sent, events, done, deliver: (m: unknown) => handler({ ok: true, value: m }), deliverLine: (l: LineResult) => handler(l) }
}

const config = (over = {}) => {
  const { runToken: _, ...c } = runStart(over)
  return c
}

function fakeQuery(messages: SDKMessage[], opts: { throwAt?: number; holdUntilInterrupt?: boolean; interruptThrows?: boolean; abortThrows?: boolean } = {}) {
  const calls: { prompt: string; options: Options }[] = []
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

async function waitForTicks(cond: () => boolean) {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r))
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
    expect(prompt).toBe('hello')
    expect(options).toMatchObject({
      cwd: '/work/s1',
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
    expect(h.events().map((e) => e.type)).toEqual(['sdk', 'sdk', 'finished'])
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
    expect(h.events().map((e) => e.type)).toEqual(['sdk', 'failed'])
    expect(h.events().at(-1)).toMatchObject({ reason: 'sdk_error' })
  })

  it('stop interrupts the query and ends with one failed stopped', async () => {
    const q = fakeQuery([assistant], { holdUntilInterrupt: true })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    await new Promise((r) => setImmediate(r))
    h.deliver({ type: 'stop' })
    await h.done
    expect(q.interrupts()).toBe(1)
    expect(h.events().filter((e) => e.type === 'failed' || e.type === 'finished')).toEqual([{ type: 'failed', reason: 'stopped', message: 'stopped' }])
  })

  it('when interrupt() is refused, the abort signal fires', async () => {
    const q = fakeQuery([assistant], { holdUntilInterrupt: true, interruptThrows: true })
    const h = harness(q.query)
    h.deliver({ type: 'run', config: config() })
    await new Promise((r) => setImmediate(r))
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
    await new Promise((r) => setImmediate(r))
    h.deliver({ type: 'interrupt' })
    await h.done
    expect(h.events().map((e) => e.type)).toEqual(['sdk', 'failed'])
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
      cwd: '/work/s1',
      env: {},
    })
    handler({ ok: true, value: { type: 'run', config: config() } })
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    expect(pulled).toBe(1)
    expect(sent.filter((m) => m.type === 'event')).toHaveLength(1)
    for (let n = 2; n <= 4; n++) {
      drain()
      await waitForTicks(() => pulled === n)
    }
    drain()
    await done
    expect(sent.filter((m) => m.type === 'event').map((m) => m.event.type)).toEqual(['sdk', 'sdk', 'sdk', 'sdk', 'finished'])
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
      ].sort(),
    )
    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}/model`)
    expect(new URL(env.INHOUSE_PROXY_URL!).username + new URL(env.INHOUSE_PROXY_URL!).password).toBe('')
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
      const start = (entry: string) =>
        spawnSync(process.execPath, ['--require', preload, join(out, entry)], {
          env: { PATH: process.env.PATH, EGRESS_URL: 'http://127.0.0.1:9' },
          encoding: 'utf8',
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

  it('production cannot run a tool call unrecorded, takes no injected host deps, and refuses a missing guard', async () => {
    const config = RunConfig.parse({
      runId: 'r1', chatId: 'chat1', sessionId: '00000000-0000-4000-8000-000000000000', resume: false, prompt: 'hi',
      model: 'claude-sonnet-5-5', effort: 'low', maxTurns: 1, maxBudgetUsd: 1, webFetchDomains: [],
      fileCaps: { maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 0, allowedTypes: [] },
    })
    const p = sessionPaths(config.chatId)
    const env = sessionEnv({ uid: 30001, gid: 30001, user: 's01', home: p.home, workDir: p.workDir }, 8081)
    const o = productionQueryGuards().apply(baseOptions(config, p.workDir, cliEnv(env), new AbortController()), config)
    const audit = o.hooks!.PreToolUse!.filter((m) => m.matcher === undefined)
    expect(audit.length).toBeGreaterThan(0)
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'u1', session_id: 's', transcript_path: '', cwd: p.workDir }
    for (const m of audit) {
      expect(m.onFailure).toBe('block')
      await expect(m.hooks[0]!(input as never, 'u1', { signal: new AbortController().signal })).rejects.toThrow(AuditRefusedError)
    }
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
