// The scripted model (P3): a fake Anthropic Messages endpoint for tests, keyed by scenario and turn. No real model is
// ever called through it. Test builds only: it must never reach a product build (its canary, below, joins the product
// build check's server scan).
//
// A request's turn is the number of assistant messages already in its `messages`, so a turn answers the same way
// whether the conversation is fresh, resumed from the store or resumed in a new container. A request the scenario has
// no turn for (an unknown scenario, a turn past the script or left `null`, a turn whose `expect` doesn't hold) is a miss:
// it gets a 400 (`invalid_request_error`, which the CLI doesn't retry) that names the miss, and it is recorded in
// `misses`, so the test fails loudly instead of the agent improvising or the CLI retrying for minutes.
//
// Web-standard APIs only (Request, Response, ReadableStream), so it runs in Node tests and in the harness Worker alike.

export const SCRIPTED_MODEL_CANARY = 'inhouse-scripted-model-canary-7f3c9b21'
export { SCENARIOS } from './scenarios.ts'
export { routesFor } from './routes.ts'
export type { ScenarioRoute } from './routes.ts'

export type ScriptedBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

export type ScriptedTurn = {
  content: ScriptedBlock[]
  /**
   * The answer worked out from the request, when part of it can't be written down in advance (an id an earlier tool result
   * gave, a tag the person's message carries). It wins over `content`, which stays as the turn's fixed shape for readers of the
   * script. A throw is a miss that says why.
   */
  contentFor?: (request: MessagesRequest) => ScriptedBlock[]
  /** Default: `tool_use` when the content has a tool call, else `end_turn`. */
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens'
  usage?: { input_tokens: number; output_tokens: number }
  /**
   * A check on the request (say, that the last user message holds a tool result): `true` passes; `false` makes the turn
   * a miss, and a string makes it a miss that says why (the 400's message carries it, so a container run shows it).
   */
  expect?: (request: MessagesRequest) => boolean | string
  /** The answer waits for this before it is sent (a test holds a turn open to act mid-run). */
  hold?: () => Promise<void>
}

/**
 * A named conversation inside a scenario (a subagent's, say): its own turns, picked for a request by `match`. Parallel
 * subagents each start their own conversation at turn 0, so position alone can't tell them from the main thread.
 */
export type ScriptedBranch = { match: (request: MessagesRequest) => boolean; turns: (ScriptedTurn | null)[] }

/**
 * `turns[n]` answers the request with n assistant messages before it; `null` marks a turn that must not be asked for.
 * `branches`: other conversations, each chosen by its `match`; a request no branch matches is the main thread's
 * (`turns`), and one that two branches match is a miss. `countTokens`: what `POST /v1/messages/count_tokens` answers
 * (default: the body's UTF-8 bytes / 4, rounded up).
 */
export type Scenario = { turns: (ScriptedTurn | null)[]; branches?: Record<string, ScriptedBranch>; countTokens?: number }

export type MessagesRequest = {
  model: string
  /** The real CLI also sends `system` messages mid-conversation (fixtures/cli-requests.json). */
  messages: { role: 'user' | 'assistant' | 'system'; content: unknown }[]
  stream?: boolean
  tools?: { name: string; defer_loading?: boolean }[]
  [k: string]: unknown
}

export type Miss = { scenario: string; turn: number | null; reason: string }

export type ScriptedModel = {
  /**
   * Answers one `POST /v1/messages` (any path ending in `/v1/messages`) for `scenario`, or one
   * `POST /v1/messages/count_tokens` (a scripted count, or the endpoint's documented 400).
   */
  handle(request: Request, scenario: string): Promise<Response>
  /** Every request answered or missed, in order. */
  readonly log: { scenario: string; turn: number | null; path: string; missed: boolean; branch?: string }[]
  readonly misses: Miss[]
}

export function turnOf(request: MessagesRequest): number {
  return request.messages.filter((m) => m.role === 'assistant').length
}

export function createScriptedModel(scenarios: Record<string, Scenario>): ScriptedModel {
  const log: ScriptedModel['log'] = []
  const misses: Miss[] = []

  const miss = (scenario: string, turn: number | null, path: string, reason: string, logged?: ScriptedModel['log'][number]) => {
    misses.push({ scenario, turn, reason })
    if (logged) logged.missed = true
    else log.push({ scenario, turn, path, missed: true })
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: `scripted model miss: scenario "${scenario}", turn ${turn ?? '?'}: ${reason}` } },
      { status: 400 },
    )
  }

  /**
   * The token counting endpoint as its docs describe it (read 2026-11-20): `{ input_tokens }`, or an
   * `invalid_request_error` 400 for a server tool (any but the advisor), the MCP connector, or an `image` or `document`
   * block with a `url` or `file` source, so the Worker's fallback to its byte bound runs in tests.
   */
  async function countTokens(request: Request, scenario: string, path: string): Promise<Response> {
    const text = await request.text()
    let body: MessagesRequest
    try {
      body = JSON.parse(text) as MessagesRequest
    } catch {
      return miss(scenario, null, path, 'the body is not JSON')
    }
    const refused = uncountable(body)
    log.push({ scenario, turn: null, path, missed: false })
    if (refused !== null) return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: refused } }, { status: 400 })
    const count = scenarios[scenario]?.countTokens ?? Math.ceil(new TextEncoder().encode(text).length / 4)
    return Response.json({ input_tokens: count })
  }

  return {
    log,
    misses,
    async handle(request, scenario) {
      const path = new URL(request.url).pathname
      if (request.method === 'POST' && path.endsWith('/v1/messages/count_tokens')) return countTokens(request, scenario, path)
      if (request.method !== 'POST' || !path.endsWith('/v1/messages')) return miss(scenario, null, path, `no route for ${request.method} ${path}`)
      let body: MessagesRequest
      try {
        body = (await request.json()) as MessagesRequest
      } catch {
        return miss(scenario, null, path, 'the body is not JSON')
      }
      const script = scenarios[scenario]
      if (!script) return miss(scenario, null, path, 'no such scenario')
      if (!Array.isArray(body.messages)) return miss(scenario, null, path, 'no messages')
      // The conversation first (a branch, or the main thread), then the turn within it.
      let branch: string | undefined
      try {
        const matched = Object.entries(script.branches ?? {}).filter(([, b]) => b.match(body))
        if (matched.length > 1) return miss(scenario, null, path, `the request matches ${matched.length} branches: ${matched.map(([n]) => n).join(', ')}`)
        branch = matched[0]?.[0]
      } catch (e) {
        return miss(scenario, null, path, `a branch's match threw: ${errorText(e)}`)
      }
      const turns = branch === undefined ? script.turns : script.branches![branch]!.turns
      const where = branch === undefined ? '' : `branch "${branch}", `
      const turn = turnOf(body)
      const t = turns[turn]
      if (t === undefined) return miss(scenario, turn, path, `${where}the script has ${turns.length} turns`)
      if (t === null) return miss(scenario, turn, path, `${where}this turn is not scripted`)
      // A script's own check or hold that throws is a miss too (a 400 that names it), never a 500 the CLI retries.
      try {
        const ok = t.expect ? t.expect(body) : true
        if (ok !== true) return miss(scenario, turn, path, `the request does not match the turn${typeof ok === 'string' ? `: ${ok}` : ''}`)
      } catch (e) {
        return miss(scenario, turn, path, `the turn's expect threw: ${errorText(e)}`)
      }
      // Logged before the hold, so a test can see the turn was asked for while it's held.
      const entry = { scenario, turn, path, missed: false, ...(branch === undefined ? {} : { branch }) }
      log.push(entry)
      try {
        await t.hold?.()
      } catch (e) {
        return miss(scenario, turn, path, `the turn's hold threw: ${errorText(e)}`, entry)
      }
      let content: ScriptedBlock[]
      try {
        content = t.contentFor ? t.contentFor(body) : t.content
      } catch (e) {
        return miss(scenario, turn, path, `the turn's contentFor threw: ${errorText(e)}`, entry)
      }
      const message = messageFor(t, content, body.model, `${scenario}-${branch ?? 'main'}-${turn}`)
      return body.stream ? new Response(sse(message), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(message)
    },
  }
}

/** Why the count endpoint refuses a body (its docs' list), or null when it counts it. */
export function uncountable(body: MessagesRequest): string | null {
  for (const t of Array.isArray(body.tools) ? (body.tools as { type?: unknown }[]) : []) {
    const type = t?.type
    if (typeof type === 'string' && type !== 'custom' && !type.startsWith('advisor')) return `count_tokens does not support the server tool ${type}`
  }
  if (body.mcp_servers !== undefined) return 'count_tokens does not support the MCP connector'
  const sources: unknown[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v === null || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if ((o.type === 'image' || o.type === 'document') && o.source && typeof o.source === 'object') sources.push((o.source as { type?: unknown }).type)
    for (const x of Object.values(o)) walk(x)
  }
  walk(body.messages)
  const bad = sources.find((t) => t === 'url' || t === 'file')
  return bad === undefined ? null : `count_tokens does not support image or document blocks with a ${String(bad)} source`
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200)

type Message = {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: ScriptedBlock[]
  stop_reason: string
  stop_sequence: null
  usage: { input_tokens: number; output_tokens: number }
}

function messageFor(t: ScriptedTurn, content: ScriptedBlock[], model: string, id: string): Message {
  return {
    id: `msg_scripted_${id.replace(/[^A-Za-z0-9_]/g, '_')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: t.stopReason ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: t.usage ?? { input_tokens: 10, output_tokens: 5 },
  }
}

/** The Messages API's streaming events for one whole message. */
function sse(m: Message): ReadableStream<Uint8Array> {
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { ...m, content: [], stop_reason: null, usage: { input_tokens: m.usage.input_tokens, output_tokens: 0 } } }],
  ]
  m.content.forEach((b, index) => {
    if (b.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }])
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }])
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
  })
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: m.usage.output_tokens } }])
  events.push(['message_stop', { type: 'message_stop' }])
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text))
      c.close()
    },
  })
}
