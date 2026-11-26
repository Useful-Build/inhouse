// Shared parts of the container probes (run.ts drives them as root inside the image; direct.ts is a session process
// started by run.ts as a pool user). Bundled by build.sh; never part of the product image.
//
// The fake egress plays the Worker's side: the scripted model (app/test/scripted-model/) answers every model call, so no
// real model is ever called, and the store, files and inhouse MCP routes answer just enough for a run to go through.
// Each scripted turn is built when its request arrives, so a probe can name a pid or path only known once the run is up.
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createScriptedModel, type MessagesRequest, type ScriptedTurn } from '../../../test/scripted-model/index.ts'

export const PROBE_MODEL = 'claude-sonnet-5-5'
/** The plugin the direct `plugins-not-off` variant adds: one we don't ship. */
export const EXTRA_PLUGIN = 'probe-extra'
export const HOME_SKILL = 'probe-home-skill'
export const RUN_TOKEN_HEADER = 'x-inhouse-run-token'

// ---------------------------------------------------------------------------------------------------------------------
// Results

export type Outcome = { name: string; ok: boolean; detail: string }
export const outcomes: Outcome[] = []
export const facts: { name: string; value: string }[] = []

/** One probe's result, printed at once so the CI log shows each as it lands. */
export function record(name: string, ok: boolean, detail: string): void {
  outcomes.push({ name, ok, detail })
  console.log(`PROBE ${ok ? 'PASS' : 'FAIL'} ${name}: ${detail.replace(/\s+/g, ' ').slice(0, 600)}`)
}

/** An observed kernel or platform fact (the PR reports each one). */
export function fact(name: string, value: string): void {
  facts.push({ name, value })
  console.log(`FACT ${name}: ${value.replace(/\s+/g, ' ').slice(0, 600)}`)
}

/** Waits on a condition (no fixed sleep): checks it every `everyMs` until it holds or `timeoutMs` passes. */
export async function waitUntil<T>(check: () => T | null | undefined | false | Promise<T | null | undefined | false>, what: string, timeoutMs = 60_000, everyMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Shell probe scripts: one Bash call runs many sub-probes and prints each one's exit code and output.

export type ShellProbe = { name: string; cmd: string }
export type ShellResult = { rc: number; out: string }

/** A bash script that runs each probe (10 s cap each) and prints `@@<name> rc=<n>` then the first 600 bytes of output. */
export function shellScript(probes: ShellProbe[]): string {
  const lines = [`t(){ n="$1"; shift; out=$(timeout 10 bash -c "$1" 2>&1); rc=$?; printf '@@%s rc=%s\\n%s\\n' "$n" "$rc" "$(printf %s "$out" | head -c 600)"; }`]
  for (const p of probes) lines.push(`t ${p.name} ${shq(p.cmd)}`)
  return lines.join('\n')
}

export function parseShell(text: string): Map<string, ShellResult> {
  const out = new Map<string, ShellResult>()
  const re = /^@@(\S+) rc=(\d+)$/gm
  const marks = [...text.matchAll(re)]
  marks.forEach((m, i) => {
    const start = m.index! + m[0].length + 1
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : text.length
    out.set(m[1]!, { rc: Number(m[2]), out: text.slice(start, end).trim() })
  })
  return out
}

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Runs a command without the agent, as root (no options) or as a pool user, and collects its output. */
export function runCommand(cmd: string, args: string[], opts: { uid?: number; gid?: number; cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...(opts.uid !== undefined ? { uid: opts.uid, gid: opts.gid } : {}),
      cwd: opts.cwd ?? '/',
      env: opts.env ?? { PATH: '/usr/local/bin:/usr/bin:/bin' },
      // No input: stdin is /dev/null. A pipe written to a child that has already exited (a quick `cat`) throws EPIPE.
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.stderr!.setEncoding('utf8').on('data', (d: string) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
    if (opts.input !== undefined) child.stdin!.end(opts.input)
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Scripted runs

export type Step = { tool: string; input: Record<string, unknown> }
/**
 * A helper's script (Stage 1, N6), keyed by a marker its definition's prompt carries (`helperMarker(key)`): every
 * conversation whose system prompt holds the marker is answered from it, turn by turn, each with its own tool ids.
 * `hold` runs before a conversation's first answer (the concurrency probe holds helpers open with it).
 */
export type HelperScript = { steps: (() => Step | Step[])[]; finalText?: string; hold?: (state: ScriptState) => Promise<void> }
/**
 * A run's script: each step is a tool call, or several in one turn (built when its turn is asked for), then one closing
 * answer. `mcp20`: the run's `inhouse` server (through the root's proxy, as production wires it) serves the 20 tools.
 * `helpers`: the helpers' scripts, by marker key. `resumed`: the run resumes a session, so its conversation already holds
 * the earlier runs' turns; the script counts its steps from the first turn this run is asked for.
 */
export type Script = { steps: (() => Step | Step[])[]; finalText?: string; mcp20?: boolean; helpers?: Record<string, HelperScript>; resumed?: boolean }
export type ToolResult = { text: string; isError: boolean }
/** The marker a helper's prompt carries so the probe's model knows which script answers it. */
export const helperMarker = (key: string) => `PROBE-HELPER-${key}`
/** One model request a helper made: which script, which conversation (by its first message), what it asked with. */
export type HelperRequest = { key: string; conv: string; turn: number; model: string; tools: string[]; at: number }

export type ScriptState = {
  script: Script
  /** The tool call ids, in step order. */
  ids: string[]
  results: Map<string, ToolResult>
  /** Every model request body that came in, for checks on what the CLI sent (the main agent's; helpers' in `helperLog`). */
  requests: MessagesRequest[]
  /** The helpers' model requests, in arrival order. */
  helperLog: HelperRequest[]
  /** The tool call ids each helper conversation was given, by `<key>:<conv>`, in step order (a step's calls in order). */
  helperIds: Map<string, string[]>
  /** The audit entries the root posted, as posted (protocol v4: with `agentId` and `inputSha256`). */
  auditEntries: { toolName: string; toolUseId?: string; decision: string; agentId?: string | null; inputSha256?: string }[]
  misses: string[]
  /** Protocol v2: the run's events as the root pushed them to `/events/` (deduped by seq), and audit posts taken. */
  pushed: { seq: number; type: string; [k: string]: unknown }[]
  audits: number
  /** A resumed run's first main turn number (the earlier runs' assistant turns before it). */
  base?: number
  /** Resolves once the run's `released` came in. */
  released: Promise<void>
  onReleased: () => void
}

let scriptCount = 0
export function newScript(script: Script): ScriptState {
  const n = scriptCount++
  let onReleased!: () => void
  const released = new Promise<void>((r) => (onReleased = r))
  return {
    script,
    ids: script.steps.map((_, i) => `toolu_probe${n}x${i}`),
    results: new Map(),
    requests: [],
    helperLog: [],
    helperIds: new Map(),
    auditEntries: [],
    misses: [],
    pushed: [],
    audits: 0,
    released,
    onReleased,
  }
}

/**
 * The tool calls of one scripted turn: a one-call step's id is the step's own; a several-call step's are the step's id
 * with `c<j>` after it. No id of one turn starts with another's: the CLI pairs parallel calls with their results in a way
 * that loses a result when one id is a prefix of another (`x0` and `x0_1`, seen on CLI 2.1.328).
 */
function callsOf(step: Step | Step[], id: string): { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }[] {
  if (!Array.isArray(step)) return [{ type: 'tool_use' as const, id, name: step.tool, input: step.input }]
  return step.map((s, j) => ({ type: 'tool_use' as const, id: `${id}c${j}`, name: s.tool, input: s.input }))
}

/** The id of call `j` of a several-call step `i` (`callsOf`). A one-call step's id is `state.ids[i]`. */
export const callId = (state: ScriptState, i: number, j: number) => `${state.ids[i]!}c${j}`

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : JSON.stringify(b))).join('\n')
  return JSON.stringify(content)
}

/** Answers one model request for a script. A side request (no tool list) or a turn past the script is a loud miss. */
export async function answerModel(state: ScriptState, request: Request): Promise<Response> {
  const body = (await request.clone().json()) as MessagesRequest
  state.requests.push(body)
  // Every tool result in the conversation (the CLI may put a message of its own after the one that carries them).
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const b of m.content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') state.results.set(b.tool_use_id, { text: resultText(b.content), isError: b.is_error === true })
    }
  }
  const mainLoop = (r: MessagesRequest) => Array.isArray(r.tools) && r.tools.length > 0
  const turn = body.messages?.filter((m) => m.role === 'assistant').length ?? 0
  const system = JSON.stringify((body as { system?: unknown }).system ?? '')
  const helper = Object.entries(state.script.helpers ?? {}).find(([key]) => system.includes(helperMarker(key)))
  if (helper) {
    const [key, script] = helper
    // A helper conversation is known by its first message (the task the main agent gave it), so each one it starts gets
    // its own tool ids.
    const conv = createHash('sha256').update(JSON.stringify(body.messages?.[0] ?? null)).digest('hex').slice(0, 10)
    state.requests.pop()
    state.helperLog.push({ key, conv, turn, model: String(body.model), tools: (Array.isArray(body.tools) ? body.tools : []).map((t) => String((t as { name?: unknown }).name)), at: Date.now() })
    if (turn === 0 && script.hold) await script.hold(state)
    const base = `toolu_h${key}${conv}`
    const ids = script.steps.map((_, i) => `${base}x${i}`)
    const steps = script.steps.map((s, i) => (i === turn ? callsOf(s(), ids[i]!) : null))
    const made = steps.flatMap((c) => c ?? []).map((c) => c.id)
    state.helperIds.set(`${key}:${conv}`, [...(state.helperIds.get(`${key}:${conv}`) ?? []), ...made])
    // Its own scenario name: the scripted model's message ids come from it, and the CLI keeps one message per id, so two
    // helpers answered under one name would lose all but one of their answers.
    return replyWith(state, request, turn, turn, steps, script.finalText, mainLoop, `h_${key}_${conv}`)
  }
  const own = state.script.resumed ? turn - (state.base ??= turn) : turn
  const steps = state.script.steps.map((s, i) => (i === own ? callsOf(s(), state.ids[i]!) : null))
  return replyWith(state, request, turn, own, steps, state.script.finalText, mainLoop)
}

/**
 * The scripted answer for the script's step `own`: its calls, or the closing text once the steps are done (past them,
 * the request is a miss). The scripted model reads the request's own turn (`at`, its assistant messages so far), so the
 * answer sits there; a resumed run's `own` is `at` less the earlier runs' turns.
 */
async function replyWith(state: ScriptState, request: Request, at: number, own: number, steps: (ReturnType<typeof callsOf> | null)[], finalText: string | undefined, expect: (r: MessagesRequest) => boolean, scenario = 's'): Promise<Response> {
  const turns: (ScriptedTurn | null)[] = Array.from({ length: at }, () => null)
  if (own < steps.length) turns.push({ content: steps[own]!, expect })
  else if (own === steps.length) turns.push({ content: [{ type: 'text', text: finalText ?? 'Done.' }], expect })
  const model = createScriptedModel({ [scenario]: { turns } })
  const res = await model.handle(request, scenario)
  for (const m of model.misses) state.misses.push(`turn ${m.turn}: ${m.reason}`)
  return res
}

// ---------------------------------------------------------------------------------------------------------------------
// The fake egress: the root proxy's upstream (EGRESS_URL), and the model base URL of direct sessions.

export type Egress = {
  port: number
  /** Scripts by run token (through the root's proxy) or by direct id (`/direct/<id>/model/...`). */
  byToken: Map<string, ScriptState>
  byDirect: Map<string, ScriptState>
  /** Every MCP method the stub was asked for. */
  mcpCalls: string[]
  /** Every MCP method asked of the `/actions/` route. */
  actionsCalls: string[]
  /** Every MCP `tools/call` any route got, with the arguments as they arrived. */
  toolCalls: { route: string; name: string; arguments: unknown }[]
  /** Calls the egress refused (an unknown token). */
  refused: string[]
  close(): Promise<void>
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c)
  return Buffer.concat(chunks)
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

/** The stub `inhouse` MCP server: one tool and one resource, JSON answers over streamable HTTP. */
function mcp(calls: string[], message: { jsonrpc?: string; id?: unknown; method?: string; params?: { protocolVersion?: string; uri?: string } }): unknown {
  calls.push(String(message.method))
  if (message.id === undefined) return null
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result })
  switch (message.method) {
    case 'initialize':
      return ok({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'inhouse-probe', version: '0.0.0' } })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({
        tools: [
          { name: 'probe_ping', description: 'Probe tool: answers pong.', inputSchema: { type: 'object', properties: {} } },
          { name: SLOW_TOOL, description: `Probe tool: answers after ${SLOW_TOOL_MS / 1000} s.`, inputSchema: { type: 'object', properties: {} } },
        ],
      })
    case 'tools/call':
      return ok({ content: [{ type: 'text', text: (message.params as { name?: string } | undefined)?.name === SLOW_TOOL ? SLOW_TOOL_ANSWER : 'pong' }] })
    case 'resources/list':
      return ok({ resources: [{ uri: 'inhouse://probe/one', name: 'one', description: 'The probe resource', mimeType: 'text/plain' }] })
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] })
    case 'resources/read':
      return ok({ contents: [{ uri: message.params?.uri ?? 'inhouse://probe/one', mimeType: 'text/plain', text: 'probe resource' }] })
    case 'prompts/list':
      return ok({ prompts: [] })
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no method ${message.method}` } }
  }
}

/** The stub's slow tool (N14): it answers only after `SLOW_TOOL_MS`, past the CLI's default 120 s backgrounding. */
export const SLOW_TOOL = 'probe_slow'
export const SLOW_TOOL_MS = 150_000
export const SLOW_TOOL_ANSWER = 'slow-done'

/** The 20 `inhouse` tools (docs/product/agent-tools.md): the six always loaded, then the fourteen found on demand. */
export const INHOUSE_ALWAYS = ['memory_search', 'memory_save', 'approval_request', 'question_ask', 'history_search', 'notification_send'] as const
export const INHOUSE_ON_DEMAND = [
  'memory_update', 'memory_forget', 'memory_list',
  'approval_get', 'approval_list', 'approval_withdraw',
  'routine_create', 'routine_list', 'routine_update', 'routine_delete', 'routine_run_now',
  'history_read', 'team_request_create', 'team_request_list',
] as const

/**
 * The stub with the 20 tools, the six marked always-load the way the MCP docs say a remote server marks one
 * (`_meta: { "anthropic/alwaysLoad": true }`).
 */
function mcp20(calls: string[], message: { jsonrpc?: string; id?: unknown; method?: string; params?: { protocolVersion?: string } }): unknown {
  if (message.method !== 'tools/list') return mcp(calls, message as never)
  calls.push('tools/list')
  const tool = (name: string, always: boolean) => ({
    name,
    description: `Probe stand-in for ${name}.`,
    inputSchema: { type: 'object', properties: {} },
    ...(always ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
  })
  return { jsonrpc: '2.0', id: message.id, result: { tools: [...INHOUSE_ALWAYS.map((n) => tool(n, true)), ...INHOUSE_ON_DEMAND.map((n) => tool(n, false))] } }
}

export function startEgress(): Promise<Egress> {
  const byToken = new Map<string, ScriptState>()
  const byDirect = new Map<string, ScriptState>()
  const mcpCalls: string[] = []
  const actionsCalls: string[] = []
  const toolCalls: Egress['toolCalls'] = []
  const refused: string[] = []
  const store = new Map<string, Map<string, unknown[]>>()
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://egress')
      const body = await readBody(req)
      const direct = /^\/direct\/([A-Za-z0-9_-]+)(\/.*)$/.exec(url.pathname)
      let state: ScriptState | undefined
      let path = url.pathname
      if (direct) {
        state = byDirect.get(direct[1]!)
        path = direct[2]!
      } else {
        const token = req.headers[RUN_TOKEN_HEADER]
        state = typeof token === 'string' ? byToken.get(token) : undefined
        if (!state && !path.startsWith('/mcp')) {
          refused.push(`${req.method} ${path}`)
          return sendJson(res, 403, { error: 'unknown run token' })
        }
      }
      const [, route] = path.split('/')
      if (route === 'model' && state) {
        const request = new Request(`http://egress${path}${url.search}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? body : undefined })
        const answer = await answerModel(state, request)
        res.writeHead(answer.status, Object.fromEntries(answer.headers))
        return res.end(Buffer.from(await answer.arrayBuffer()))
      }
      if (route === 'mcp' || route === 'mcp20' || route === 'actions') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
        const parsed = JSON.parse(body.toString('utf8')) as unknown
        if (route === 'actions') actionsCalls.push(...(Array.isArray(parsed) ? parsed : [parsed]).map((m) => String((m as { method?: unknown }).method)))
        for (const m of (Array.isArray(parsed) ? parsed : [parsed]) as { method?: string; params?: { name?: string; arguments?: unknown } }[]) {
          if (m.method === 'tools/call') toolCalls.push({ route, name: String(m.params?.name), arguments: m.params?.arguments })
        }
        // The slow tool's call waits here, as the egress's ask wait will (N14).
        const slow = (Array.isArray(parsed) ? parsed : [parsed]).some((m) => (m as { method?: string; params?: { name?: string } }).method === 'tools/call' && (m as { params?: { name?: string } }).params?.name === SLOW_TOOL)
        if (slow) await new Promise((r) => setTimeout(r, SLOW_TOOL_MS))
        const answer = route === 'mcp20' || state?.script.mcp20 === true ? mcp20 : mcp
        const answers = (Array.isArray(parsed) ? parsed : [parsed]).map((m) => answer(mcpCalls, m as never)).filter((a) => a !== null)
        if (answers.length === 0) return res.writeHead(202).end()
        return sendJson(res, 200, Array.isArray(parsed) ? answers : answers[0])
      }
      // Protocol v2: the root pushes the run's events here and posts each audit entry before it acks the hook.
      if (route === 'events' && state && req.method === 'POST') {
        const batch = JSON.parse(body.toString('utf8')) as { events: { seq: number; type: string }[] }
        for (const e of batch.events) if (e.seq === state.pushed.length) state.pushed.push(e)
        if (state.pushed.at(-1)?.type === 'released') state.onReleased()
        return sendJson(res, 200, { ackSeq: state.pushed.length - 1, stop: false })
      }
      if (route === 'audit' && state && req.method === 'POST') {
        state.audits++
        state.auditEntries.push((JSON.parse(body.toString('utf8')) as { entry: ScriptState['auditEntries'][number] }).entry)
        return res.writeHead(204).end()
      }
      if (route === 'store') {
        // A store in memory, by key, parts in append order (a resend of a part replaces it), so a run can be resumed.
        const b = JSON.parse(body.toString('utf8') || '{}') as { key?: { projectKey: string; sessionId: string; subpath?: string }; entries?: unknown[]; part?: string }
        const k = (key: NonNullable<typeof b.key>) => JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null])
        if (path === '/store/append' && b.key && b.part) {
          const parts = store.get(k(b.key)) ?? new Map<string, unknown[]>()
          parts.set(b.part, b.entries ?? [])
          store.set(k(b.key), parts)
          return sendJson(res, 200, { ok: true })
        }
        if (path === '/store/load' && b.key) {
          const parts = store.get(k(b.key))
          return sendJson(res, 200, { entries: parts ? [...parts.keys()].sort().flatMap((p) => parts.get(p)!) : null })
        }
        if (path === '/store/list-subkeys' && b.key) {
          const subkeys = [...store.keys()].map((x) => JSON.parse(x) as [string, string, string | null]).filter(([p, s, sub]) => p === b.key!.projectKey && s === b.key!.sessionId && sub !== null).map(([, , sub]) => sub!)
          return sendJson(res, 200, { subkeys })
        }
        return sendJson(res, 400, { error: 'bad store call' })
      }
      if (route === 'files') {
        if (req.method === 'GET' && (path === '/files/' || path === '/files')) return sendJson(res, 200, { files: [] })
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 404, { error: 'no such route' })
    })().catch((e: unknown) => {
      console.log(`egress error: ${String(e instanceof Error ? e.stack : e)}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'egress failed' })
      else res.destroy()
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ port, byToken, byDirect, mcpCalls, actionsCalls, toolCalls, refused, close: () => new Promise<void>((r) => server.close(() => r())) })
    }),
  )
}
