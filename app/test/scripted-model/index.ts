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

export type ScriptedBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

export type ScriptedTurn = {
  content: ScriptedBlock[]
  /** Default: `tool_use` when the content has a tool call, else `end_turn`. */
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens'
  usage?: { input_tokens: number; output_tokens: number }
  /** A check on the request (say, that the last user message holds a tool result); false makes the turn a miss. */
  expect?: (request: MessagesRequest) => boolean
  /** The answer waits for this before it is sent (a test holds a turn open to act mid-run). */
  hold?: () => Promise<void>
}

/** `turns[n]` answers the request with n assistant messages before it; `null` marks a turn that must not be asked for. */
export type Scenario = { turns: (ScriptedTurn | null)[] }

export type MessagesRequest = {
  model: string
  messages: { role: 'user' | 'assistant'; content: unknown }[]
  stream?: boolean
  tools?: { name: string }[]
  [k: string]: unknown
}

export type Miss = { scenario: string; turn: number | null; reason: string }

export type ScriptedModel = {
  /** Answers one `POST /v1/messages` (any path ending in `/v1/messages`) for `scenario`. */
  handle(request: Request, scenario: string): Promise<Response>
  /** Every request answered or missed, in order. */
  readonly log: { scenario: string; turn: number | null; path: string; missed: boolean }[]
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

  return {
    log,
    misses,
    async handle(request, scenario) {
      const path = new URL(request.url).pathname
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
      const turn = turnOf(body)
      const t = script.turns[turn]
      if (t === undefined) return miss(scenario, turn, path, `the script has ${script.turns.length} turns`)
      if (t === null) return miss(scenario, turn, path, 'this turn is not scripted')
      // A script's own check or hold that throws is a miss too (a 400 that names it), never a 500 the CLI retries.
      try {
        if (t.expect && !t.expect(body)) return miss(scenario, turn, path, 'the request does not match the turn')
      } catch (e) {
        return miss(scenario, turn, path, `the turn's expect threw: ${errorText(e)}`)
      }
      // Logged before the hold, so a test can see the turn was asked for while it's held.
      const entry = { scenario, turn, path, missed: false }
      log.push(entry)
      try {
        await t.hold?.()
      } catch (e) {
        return miss(scenario, turn, path, `the turn's hold threw: ${errorText(e)}`, entry)
      }
      const message = messageFor(t, body.model, `${scenario}-${turn}`)
      return body.stream ? new Response(sse(message), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(message)
    },
  }
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

function messageFor(t: ScriptedTurn, model: string, id: string): Message {
  return {
    id: `msg_scripted_${id.replace(/[^A-Za-z0-9_]/g, '_')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: t.content,
    stop_reason: t.stopReason ?? (t.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
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
