// Shared parts of the container probes (run.ts drives them as root inside the image; direct.ts is a session process
// started by run.ts as a pool user). Bundled by build.sh; never part of the product image.
//
// The fake egress plays the Worker's side: the scripted model (app/test/scripted-model/) answers every model call, so no
// real model is ever called, and the store, files and inhouse MCP routes answer just enough for a run to go through.
// Each scripted turn is built when its request arrives, so a probe can name a pid or path only known once the run is up.
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { createScriptedModel, type MessagesRequest, type ScriptedTurn } from '../../../test/scripted-model/index.ts'

export const PROBE_MODEL = 'claude-sonnet-5-5'
/** The plugin the direct `plugins-not-off` variant adds: one we don't ship. */
export const EXTRA_PLUGIN = 'probe-extra'
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
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
    child.stdin.end(opts.input ?? '')
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Scripted runs

export type Step = { tool: string; input: Record<string, unknown> }
/** A run's script: each step is a tool call (built when its turn is asked for), then one closing answer. */
export type Script = { steps: (() => Step)[]; finalText?: string }
export type ToolResult = { text: string; isError: boolean }

export type ScriptState = {
  script: Script
  /** The tool call ids, in step order. */
  ids: string[]
  results: Map<string, ToolResult>
  /** Every model request body that came in, for checks on what the CLI sent. */
  requests: MessagesRequest[]
  misses: string[]
}

let scriptCount = 0
export function newScript(script: Script): ScriptState {
  const n = scriptCount++
  return { script, ids: script.steps.map((_, i) => `toolu_probe${n}x${i}`), results: new Map(), requests: [], misses: [] }
}

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
  const turns: (ScriptedTurn | null)[] = []
  const mainLoop = (r: MessagesRequest) => Array.isArray(r.tools) && r.tools.length > 0
  const turn = body.messages?.filter((m) => m.role === 'assistant').length ?? 0
  for (let i = 0; i <= state.script.steps.length; i++) {
    if (i !== turn) {
      turns.push(null)
      continue
    }
    if (i < state.script.steps.length) {
      const step = state.script.steps[i]!()
      turns.push({ content: [{ type: 'tool_use', id: state.ids[i]!, name: step.tool, input: step.input }], expect: mainLoop })
    } else turns.push({ content: [{ type: 'text', text: state.script.finalText ?? 'Done.' }], expect: mainLoop })
  }
  const model = createScriptedModel({ s: { turns } })
  const res = await model.handle(request, 's')
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
      return ok({ tools: [{ name: 'probe_ping', description: 'Probe tool: answers pong.', inputSchema: { type: 'object', properties: {} } }] })
    case 'tools/call':
      return ok({ content: [{ type: 'text', text: 'pong' }] })
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

export function startEgress(): Promise<Egress> {
  const byToken = new Map<string, ScriptState>()
  const byDirect = new Map<string, ScriptState>()
  const mcpCalls: string[] = []
  const refused: string[] = []
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
      if (route === 'mcp') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
        const parsed = JSON.parse(body.toString('utf8')) as unknown
        const answers = (Array.isArray(parsed) ? parsed : [parsed]).map((m) => mcp(mcpCalls, m as never)).filter((a) => a !== null)
        if (answers.length === 0) return res.writeHead(202).end()
        return sendJson(res, 200, Array.isArray(parsed) ? answers : answers[0])
      }
      if (route === 'store') {
        if (path === '/store/load') return sendJson(res, 200, { entries: null })
        if (path === '/store/list-subkeys') return sendJson(res, 200, { subkeys: [] })
        return sendJson(res, 200, { ok: true })
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
      resolve({ port, byToken, byDirect, mcpCalls, refused, close: () => new Promise<void>((r) => server.close(() => r())) })
    }),
  )
}
