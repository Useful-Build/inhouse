// The runner harness (P3): a small Worker that owns one runner container through `ctx.container` (never the deprecated
// `Container` class) and plays the Worker's egress with the scripted model, so the runner runs under `wrangler dev`
// before the real server pieces (P2, W1 to W3) exist. Local development only: no deploy, no account ids, no hosts, no
// secrets; a deployed copy refuses every request (./guards.ts). Deleted once the real runner objects carry the runner tests (P3 plan, "Order and parallelism" 6).
//
// The container's only way out is `egress.internal` (the runner's EGRESS_URL), intercepted here; every other HTTP and
// HTTPS host is refused and logged. The egress checks each call's run token against the runs this harness started,
// then serves the routes: `/model/*` from the scripted model (the run's scenario), `/store/*` and `/files/*` from this
// object's storage, scoped to the run's chat, and protocol v2's `/events/` (the runner pushes the run's events; acked
// by seq) and `/audit/` (each blocking audit entry; 204).
//
// Protocol v2: the runner answers `POST /runs` with `202 { accepted }` and pushes the run's events to `/events/`. The
// harness turns those pushes back into the NDJSON answer its callers read (s6-check.mjs, image/cold-start.mjs), in
// seq order, ending at the run's `released` event; the run's token stays valid until then.
//
// The orchestrator drives it with plain HTTP:
//   POST /runs                    { scenario, chatId, prompt, resume?, sessionId?, fileCaps? } -> the run's NDJSON
//                                 (the pushed events, `released` last), or the runner's refusal as it answered
//   POST /runs/:runId/stop        and /interrupt
//   GET  /health, GET /protocol   the runner's own
//   PUT  /files/:chatId/<path>    seed a chat file (an attachment under inputs/)
//   GET  /model-log               the scripted model's requests and misses (a miss fails the check)
//   POST /restart?mode=sigterm|destroy
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { AuditPost, FileListing, PROTOCOL_HEADER, PROTOCOL_VERSION, PushBatch, RunStart, StoreAppend, StoreListSubkeys, StoreLoad, encodeRunEvent, type FileCaps } from '../../../shared/protocol/index.ts'
import { createScriptedModel } from '../../../test/scripted-model/index.ts'
import { HARNESS_MODEL, SCENARIOS } from '../../../test/scripted-model/scenarios.ts'
import { forScriptedModel, localOnlyRefusal } from './guards.ts'

const RUNNER_PORT = 8080
const EGRESS_HOST = 'egress.internal'
const RUN_TOKEN_HEADER = 'x-inhouse-run-token'
const IDLE_MS = 10 * 60_000

const DEFAULT_CAPS: FileCaps = {
  maxFileBytes: 1_000_000,
  maxFilesPerTurn: 10,
  maxRestoreBytes: 10_000_000,
  allowedTypes: ['application/pdf', 'image/png', 'image/jpeg', 'text/csv', 'text/plain', 'text/markdown', 'application/json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
}

type RunInfo = { runId: string; chatId: string; scenario: string }
/** A run's NDJSON answer to its caller: the pushed events go out here, deduped by seq. */
type RunSink = { writer: WritableStreamDefaultWriter<Uint8Array>; next: number }

/** The container's egress: checks the run token, then hands the call to the harness object. */
export class HarnessEgress extends WorkerEntrypoint<Env, { name: string }> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.hostname !== EGRESS_HOST) return deny(request)
    return this.env.HARNESS.getByName(this.ctx.props.name).egress(request)
  }
}

/** Every other host the container tries. */
export class DenyEgress extends WorkerEntrypoint<Env> {
  fetch(request: Request): Response {
    return deny(request)
  }
}

function deny(request: Request): Response {
  console.log(JSON.stringify({ egress: 'denied', url: request.url }))
  return new Response('forbidden', { status: 403 })
}

export class RunnerHarness extends DurableObject<Env> {
  #model = createScriptedModel(SCENARIOS)
  /** Run tokens of the runs this object started (memory only, like the real token table's role). */
  #tokens = new Map<string, RunInfo>()
  #sinks = new Map<string, RunSink>()
  /** Tokens of runs that have ended here (released, refused or restarted away): their calls get 410, not 403. */
  #ended = new Set<string>()
  #booting: Promise<void> | undefined

  get #c() {
    return this.ctx.container!
  }

  async #boot(name: string) {
    const c = this.#c
    if (c.running) {
      // A recreated object finds its container running: the inactivity timeout is set again on every run (P0 S1).
      await c.setInactivityTimeout(IDLE_MS)
      return
    }
    // Hostname intercepts first, then the catch-alls (precedence by registration order).
    await c.interceptOutboundHttp(EGRESS_HOST, this.ctx.exports.HarnessEgress({ props: { name } }))
    await c.interceptAllOutboundHttp(this.ctx.exports.DenyEgress({ props: {} }))
    await c.interceptOutboundHttps('*', this.ctx.exports.DenyEgress({ props: {} }))
    c.start({ enableInternet: false, env: { EGRESS_URL: `http://${EGRESS_HOST}`, PORT: String(RUNNER_PORT), PROXY_PORT: '8081' } })
    await c.setInactivityTimeout(IDLE_MS)
    const port = c.getTcpPort(RUNNER_PORT)
    for (let i = 0; ; i++) {
      try {
        const res = await port.fetch('http://runner/health', { signal: AbortSignal.timeout(1000) })
        await res.body?.cancel()
        if (res.ok) return
      } catch {
        // Not listening yet.
      }
      if (i > 600) throw new Error('the runner did not answer /health in 60 s')
      await scheduler.wait(100)
    }
  }

  #ensure(name: string) {
    return (this.#booting ??= this.#boot(name).finally(() => (this.#booting = undefined)))
  }

  #runner(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers)
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION))
    return this.#c.getTcpPort(RUNNER_PORT).fetch(`http://runner${path}`, { ...init, headers })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const name = url.searchParams.get('name') ?? 'default'
    const path = url.pathname

    if (path === '/model-log') return Response.json({ log: this.#model.log, misses: this.#model.misses })
    if (path === '/restart' && request.method === 'POST') {
      const mode = url.searchParams.get('mode') ?? 'sigterm'
      if (this.#c.running && mode === 'sigterm') {
        this.#c.signal(15)
        for (let i = 0; i < 300 && this.#c.running; i++) await scheduler.wait(100)
      }
      if (this.#c.running) await this.#c.destroy()
      // The container's runs are gone with it: their answers end and their tokens go.
      for (const sink of this.#sinks.values()) void sink.writer.close().catch(() => undefined)
      this.#sinks.clear()
      for (const token of this.#tokens.keys()) this.#ended.add(token)
      this.#tokens.clear()
      return Response.json({ mode, running: this.#c.running })
    }

    const seed = /^\/files\/([A-Za-z0-9_-]{1,64})\/(.+)$/.exec(path)
    if (seed && request.method === 'PUT') {
      await this.ctx.storage.put(`file:${seed[1]}:${seed[2].split('/').map(decodeURIComponent).join('/')}`, new Uint8Array(await request.arrayBuffer()))
      return Response.json({ ok: true })
    }

    await this.#ensure(name)
    if ((path === '/health' || path === '/protocol') && request.method === 'GET') return this.#runner(path)
    const action = /^\/runs\/([A-Za-z0-9_-]{1,64})\/(stop|interrupt)$/.exec(path)
    if (action && request.method === 'POST') return this.#runner(path, { method: 'POST' })
    if (path === '/runs' && request.method === 'POST') return this.#startRun(await request.json())
    return new Response('not found', { status: 404 })
  }

  async #startRun(body: { scenario?: string; chatId?: string; prompt?: string; resume?: boolean; expect?: unknown; sessionId?: string; runId?: string; fileCaps?: FileCaps; outputFormat?: unknown }) {
    if (!body.scenario || !(body.scenario in SCENARIOS)) return Response.json({ error: `unknown scenario; known: ${Object.keys(SCENARIOS).join(', ')}` }, { status: 400 })
    const chatId = body.chatId ?? 'chat-1'
    const runToken = `harness_${crypto.randomUUID().replaceAll('-', '')}`
    const start = RunStart.parse({
      runId: body.runId ?? `run-${crypto.randomUUID().slice(0, 8)}`,
      chatId,
      sessionId: body.sessionId ?? crypto.randomUUID(),
      resume: body.resume ?? false,
      prompt: body.prompt ?? '',
      model: HARNESS_MODEL,
      sideModel: HARNESS_MODEL,
      systemPrompt: '',
      attachments: [],
      // A resume names what the store must hold (protocol v2); the caller passes it with `resume: true`.
      expect: body.expect ?? null,
      effort: 'medium',
      maxTurns: 8,
      maxBudgetUsd: 1,
      runToken,
      webFetchDomains: [],
      fileCaps: body.fileCaps ?? DEFAULT_CAPS,
      // Structured output, passed through (the `structured` scenarios answer STRUCTURED_SCHEMA).
      ...(body.outputFormat === undefined ? {} : { outputFormat: body.outputFormat }),
    })
    // One answer per run id: a second POST for a run still streaming would steal its sink.
    if (this.#sinks.has(start.runId)) return Response.json({ error: 'run_live' }, { status: 409 })
    this.#tokens.set(runToken, { runId: start.runId, chatId, scenario: body.scenario })
    // The sink is ready before the runner can push (it may push before its 202 reaches us).
    const pipe = new TransformStream<Uint8Array, Uint8Array>()
    const sink: RunSink = { writer: pipe.writable.getWriter(), next: 0 }
    this.#sinks.set(start.runId, sink)
    const drop = () => {
      this.#tokens.delete(runToken)
      this.#ended.add(runToken)
      void sink.writer.close().catch(() => undefined)
      if (this.#sinks.get(start.runId) === sink) this.#sinks.delete(start.runId)
    }
    let res: Response
    try {
      res = await this.#runner('/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(start) })
    } catch (e) {
      // The runner couldn't be reached: nothing was admitted.
      drop()
      throw e
    }
    if (res.status !== 202) {
      // Refused (409, 503, 400 ...): nothing was admitted, so no push will come. The runner's answer as it was.
      drop()
      return res
    }
    await res.body?.cancel()
    // The token stays valid until the run's `released` arrives (/events/ below).
    return new Response(pipe.readable, { status: 200, headers: { 'content-type': 'application/x-ndjson', 'x-run-id': start.runId, 'x-session-id': start.sessionId } })
  }

  /** `POST /events/`: the run's pushed events, written to its caller in seq order; acked up to the last one held. */
  #events(token: string, run: RunInfo, body: unknown): Response {
    const parsed = PushBatch.safeParse(body)
    if (!parsed.success || parsed.data.turnId !== run.runId) {
      console.log(JSON.stringify({ egress: 'refused', reason: 'bad push batch', runId: run.runId }))
      return new Response('{"error":"bad push batch"}', { status: 400 })
    }
    const sink = this.#sinks.get(run.runId) ?? { writer: null, next: 0 }
    let released = false
    for (const e of parsed.data.events) {
      if (e.seq < sink.next) continue
      if (e.seq > sink.next) return new Response('{"error":"seq gap"}', { status: 409 })
      // The caller may have hung up: the run goes on, and its events are dropped here.
      void sink.writer?.write(new TextEncoder().encode(encodeRunEvent(e))).catch(() => undefined)
      sink.next++
      if (e.type === 'released') released = true
    }
    if (sink.writer) this.#sinks.set(run.runId, sink as RunSink)
    if (released) {
      void sink.writer?.close().catch(() => undefined)
      this.#sinks.delete(run.runId)
      this.#tokens.delete(token)
      this.#ended.add(token)
    }
    return Response.json({ ackSeq: sink.next - 1, stop: false })
  }

  /** The egress routes, for the run whose token the call carries. Called by `HarnessEgress`. */
  async egress(request: Request): Promise<Response> {
    const token = request.headers.get(RUN_TOKEN_HEADER)
    const run = token === null ? undefined : this.#tokens.get(token)
    if (!run) {
      // A run that has ended here: the protocol's run-ended answer, so the runner's pusher drops what it still holds.
      if (token !== null && this.#ended.has(token)) return new Response('{"error":"run ended"}', { status: 410 })
      console.log(JSON.stringify({ egress: 'refused', reason: 'unknown run token', url: request.url }))
      return new Response('{"error":"unknown run token"}', { status: 403 })
    }
    const url = new URL(request.url)
    const [, route, ...rest] = url.pathname.split('/')
    const sub = `/${rest.join('/')}`

    if (route === 'model') {
      return this.#model.handle(forScriptedModel(request, sub), run.scenario)
    }
    if (route === 'events' && request.method === 'POST') return this.#events(token!, run, await request.json())
    if (route === 'audit' && request.method === 'POST') {
      // The durable audit ACK: the harness keeps no record, it only lets the hook go on (a log line for the check).
      const post = AuditPost.safeParse(await request.json())
      if (!post.success) return new Response('{"error":"bad audit entry"}', { status: 400 })
      console.log(JSON.stringify({ audit: post.data.entry.toolName, decision: post.data.entry.decision, n: post.data.n }))
      return new Response(null, { status: 204 })
    }
    if (route === 'store' && request.method === 'POST') return this.#store(run.chatId, sub, await request.json())
    if (route === 'files') return this.#files(run.chatId, request, rest)
    return new Response('{"error":"no such route"}', { status: 404 })
  }

  async #store(chatId: string, op: string, body: unknown): Promise<Response> {
    const prefix = (key: { projectKey: string; sessionId: string; subpath?: string }) => `store:${chatId}:${JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null])}:`
    if (op === '/append') {
      const b = StoreAppend.parse(body)
      await this.ctx.storage.put(prefix(b.key) + b.part, b.entries)
      return Response.json({ ok: true })
    }
    if (op === '/load') {
      const { key } = StoreLoad.parse(body)
      const parts = await this.ctx.storage.list<unknown[]>({ prefix: prefix(key) })
      // list() returns keys in order: the parts, in append order.
      return Response.json({ entries: parts.size === 0 ? null : [...parts.values()].flat() })
    }
    if (op === '/list-subkeys') {
      const { key } = StoreListSubkeys.parse(body)
      const all = await this.ctx.storage.list({ prefix: `store:${chatId}:` })
      const subkeys = new Set<string>()
      for (const k of all.keys()) {
        const [p, s, sub] = JSON.parse(k.slice(`store:${chatId}:`.length, k.lastIndexOf(':'))) as [string, string, string | null]
        if (p === key.projectKey && s === key.sessionId && sub !== null) subkeys.add(sub)
      }
      return Response.json({ subkeys: [...subkeys] })
    }
    return new Response('{"error":"no such store op"}', { status: 404 })
  }

  async #files(chatId: string, request: Request, segments: string[]): Promise<Response> {
    const prefix = `file:${chatId}:`
    if (request.method === 'GET' && segments.join('') === '') {
      const files = await this.ctx.storage.list<Uint8Array>({ prefix })
      return Response.json(FileListing.parse({ files: [...files].map(([k, v]) => ({ path: k.slice(prefix.length), bytes: v.byteLength })) }))
    }
    const path = segments.map(decodeURIComponent).join('/')
    if (request.method === 'GET') {
      const body = await this.ctx.storage.get<Uint8Array>(prefix + path)
      return body ? new Response(body) : new Response('{"error":"no such file"}', { status: 404 })
    }
    if (request.method === 'PUT') {
      await this.ctx.storage.put(prefix + path, new Uint8Array(await request.arrayBuffer()))
      console.log(JSON.stringify({ file_saved: path, contentType: request.headers.get('content-type') }))
      return Response.json({ ok: true })
    }
    return new Response('{"error":"no such files op"}', { status: 405 })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Local development only: a deployed copy (no HARNESS_LOCAL_ONLY) refuses everything.
    const refused = localOnlyRefusal(env)
    if (refused) return refused
    const url = new URL(request.url)
    // One harness object (one container) per name: `?name=` picks it, `default` otherwise.
    return env.HARNESS.getByName(url.searchParams.get('name') ?? 'default').fetch(request)
  },
} satisfies ExportedHandler<Env>
