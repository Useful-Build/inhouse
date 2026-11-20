// Test helpers for the egress (never imported by the Worker): deps over W1's fake BrandAgentRpc, a recording upstream,
// captured timers and `waitUntil` promises, and a request with a run token.
import { hashRunToken } from '../../do/brand-agent/tokens.ts'
import type { RunGrant, RunTokens } from '../../do/brand-agent/tokens.ts'
import { FakeBrandAgentRpc } from '../../do/brand-agent/testing/fake-brand-agent-rpc.ts'
import type { SettingsView } from '../../model/catalog.ts'
import type { EgressDeps, McpHandler } from '../deps.ts'
import type { ModelPath } from '../gateway.ts'
import { RUN_TOKEN_HEADER } from '../http.ts'

/** W1's fake, with a filter over its call log. */
export class FakeEgressRpc extends FakeBrandAgentRpc {
  constructor(tokens?: RunTokens, now?: () => number) {
    super(tokens, now)
  }
  callsOf(method: string) {
    return this.calls.filter(c => c.method === method)
  }
}

/** A captured timeout: a test fires it by hand (no real wait). */
export interface FakeTimeout {
  fn: () => void
  ms: number
  cleared: boolean
}

export interface UpstreamCall {
  path: ModelPath
  body: string
  headers: Headers
  signal: AbortSignal
}

export const TOKEN = 'run-token-for-tests-0123456789abcdef'
export const GRANT: RunGrant = {
  turnId: 't_turn1', runId: 'r_run1', chatId: 'chat-a', memberId: 'm_alice', sessionId: '00000000-0000-4000-8000-00000000000a',
  model: 'claude-sonnet-5-5', sideModel: 'claude-haiku-5-5', expiresAtMs: 4_102_444_800_000,
}

export interface Harness {
  deps: EgressDeps
  rpc: FakeEgressRpc
  upstreamCalls: UpstreamCall[]
  /** What the upstream answers; a test replaces it. */
  answer: (call: UpstreamCall) => Promise<Response>
  settings: Record<string, string>
  waits: Promise<unknown>[]
  intervals: (() => void)[]
  timeouts: FakeTimeout[]
  logs: Record<string, unknown>[]
  touched: string[]
  mcpCalls: { request: Request; scope: unknown }[]
}

export async function harness(over: Partial<EgressDeps> = {}, grant: RunGrant = GRANT): Promise<Harness> {
  const rpc = new FakeEgressRpc()
  rpc.grants.set(await hashRunToken(TOKEN), grant)
  let n = 0
  const h: Harness = {
    rpc, upstreamCalls: [], settings: {}, waits: [], intervals: [], timeouts: [], logs: [], touched: [], mcpCalls: [],
    answer: async () => Response.json({ type: 'message', usage: { input_tokens: 10, output_tokens: 5 } }),
    deps: undefined as unknown as EgressDeps,
  }
  const mcp: McpHandler = async (request, scope) => {
    h.mcpCalls.push({ request, scope })
    return new Response('{}')
  }
  h.deps = {
    rpc,
    runner: 'runner-0',
    touchRunner: async r => void h.touched.push(r),
    upstream: (path, init) => {
      const call = { path, ...init }
      h.upstreamCalls.push(call)
      return h.answer(call)
    },
    settings: async (): Promise<SettingsView> => ({ ...h.settings }),
    bucket: undefined as unknown as EgressDeps['bucket'],
    db: undefined as unknown as D1Database,
    files: undefined as unknown as EgressDeps['files'],
    newFileId: () => `f_${String(++n).padStart(22, '0')}`,
    mcp,
    waitUntil: p => void h.waits.push(p),
    setInterval: fn => {
      h.intervals.push(fn)
      return h.intervals.length as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => undefined,
    setTimeout: (fn, ms) => {
      h.timeouts.push({ fn, ms, cleared: false })
      return h.timeouts.length as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: t => void (h.timeouts[(t as unknown as number) - 1]!.cleared = true),
    newCallId: () => `c_${++n}`,
    now: () => 1_800_000_000_000,
    log: e => void h.logs.push(e),
    ...over,
  }
  return h
}

export function egressRequest(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; token?: string | null } = {}): Request {
  const headers = new Headers(init.headers)
  if (init.token !== null) headers.set(RUN_TOKEN_HEADER, init.token ?? TOKEN)
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
  return new Request(`http://egress.internal${path}`, { method: init.method ?? 'POST', headers, body, signal: init.signal })
}

/** A promise and the function that settles it (a barrier a test opens). */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => (resolve = r))
  return { promise, resolve }
}

/** Resolves once `check` holds, re-checked after every settled microtask turn (no fixed wait). */
export async function until(check: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    if (check()) return
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
  }
  throw new Error(`until: ${label} never held`)
}

/** An SSE body the test feeds event by event. */
export function sseFeed(): { stream: ReadableStream<Uint8Array>; send: (e: object) => void; end: () => void } {
  let c!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start: ctl => void (c = ctl) })
  const enc = new TextEncoder()
  return {
    stream,
    send: e => c.enqueue(enc.encode(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)),
    end: () => c.close(),
  }
}
