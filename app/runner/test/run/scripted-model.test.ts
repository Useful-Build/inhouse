// The scripted model (app/test/scripted-model/). Ways it could fail, written first:
// - a request it has no turn for gets an answer anyway (the agent improvises and the test passes on a guess), or gets a
//   status the CLI retries for minutes instead of failing;
// - a turn is picked by request count, not conversation position, so a resume or a side request shifts every answer;
// - its stream doesn't add up to the message (a tool call's input lost or garbled);
// - a script's own `expect` or `hold` throws and the CLI gets a 500 (which it retries for minutes) instead of a miss;
// - a side request the CLI makes on its own (a title, a summary: no tool list) takes a scripted turn;
// - the `ask` scenario's resume answers a request that doesn't carry the question's result.
// The real CLI against it is in test/store/eager.test.ts.
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { createScriptedModel, type ScriptedTurn } from '../../../test/scripted-model/index.ts'
import { HARNESS_MODEL, SCENARIOS } from '../../../test/scripted-model/scenarios.ts'

type Msg = { role: 'user' | 'assistant'; content: unknown }
const req = (messages: Msg[], stream = false, extra: Record<string, unknown> = {}) =>
  new Request('http://proxy/model/v1/messages?beta=true', { method: 'POST', body: JSON.stringify({ model: 'm', messages, stream, ...extra }) })
/** A main-loop request as the CLI makes it for a harness run: the run's model and its tool list. */
const mainReq = (messages: Msg[], stream = false) =>
  req(messages, stream, { model: HARNESS_MODEL, tools: [{ name: 'Bash' }, { name: 'mcp__inhouse__question_ask' }] })
const convo = (assistants: number) => [{ role: 'user' as const, content: 'q' }, ...Array.from({ length: assistants }, () => [{ role: 'assistant' as const, content: 'a' }, { role: 'user' as const, content: 'r' }]).flat()]

const turn = (i: number): ScriptedTurn => ({ content: [{ type: 'text', text: `turn ${i}` }] })

describe('the scripted model', () => {
  it.prop([fc.integer({ min: 0, max: 5 }), fc.integer({ min: 1, max: 4 })])('answers by conversation position, however often asked', async (n, times) => {
    const model = createScriptedModel({ s: { turns: [0, 1, 2, 3, 4, 5].map(turn) } })
    for (let i = 0; i < times; i++) {
      const body = (await (await model.handle(req(convo(n)), 's')).json()) as { content: { text: string }[] }
      expect(body.content[0]!.text).toBe(`turn ${n}`)
    }
    expect(model.misses).toEqual([])
  })

  it.each([
    ['an unknown scenario', 'nope', convo(0)],
    ['a turn past the script', 's', convo(2)],
    ['a turn left null', 's', convo(1)],
  ])('%s is a miss: a 400 the CLI does not retry, recorded', async (_, scenario, messages) => {
    const model = createScriptedModel({ s: { turns: [turn(0), null] } })
    const res = await model.handle(req(messages), scenario)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { type: string; message: string } }).error).toMatchObject({ type: 'invalid_request_error', message: expect.stringContaining('scripted model miss') })
    expect(model.misses).toHaveLength(1)
  })

  it('a turn whose expect fails is a miss', async () => {
    const model = createScriptedModel({ s: { turns: [{ ...turn(0), expect: () => false }] } })
    expect((await model.handle(req(convo(0)), 's')).status).toBe(400)
    expect(model.misses).toEqual([{ scenario: 's', turn: 0, reason: 'the request does not match the turn' }])
  })

  it('its stream adds up to the message: text, then a tool call with its input', async () => {
    const model = createScriptedModel(SCENARIOS)
    const text = await (await model.handle(mainReq(convo(0), true), 'write-output')).text()
    const events = text
      .trim()
      .split('\n\n')
      .map((e) => JSON.parse(e.split('\n')[1]!.slice('data: '.length)) as Record<string, any>)
    expect(events[0]!.type).toBe('message_start')
    expect(events.at(-1)!.type).toBe('message_stop')
    const deltas = events.filter((e) => e.type === 'content_block_delta')
    expect(deltas[0]!.delta).toEqual({ type: 'text_delta', text: 'Writing the table.' })
    expect(JSON.parse(deltas[1]!.delta.partial_json)).toEqual((SCENARIOS['write-output']!.turns[0]!.content[1] as { input: unknown }).input)
    expect(events.find((e) => e.type === 'message_delta')!.delta.stop_reason).toBe('tool_use')
  })

  it.each([
    ['expect', { expect: () => { throw new Error('boom') } }],
    ['hold', { hold: () => Promise.reject(new Error('boom')) }],
  ])("a turn whose %s throws is a miss (400, recorded), never a 500", async (what, part) => {
    const model = createScriptedModel({ s: { turns: [{ ...turn(0), ...part }] } })
    const res = await model.handle(req(convo(0)), 's')
    expect(res.status).toBe(400)
    expect(model.misses).toEqual([{ scenario: 's', turn: 0, reason: `the turn's ${what} threw: boom` }])
    expect(model.log).toEqual([{ scenario: 's', turn: 0, path: '/model/v1/messages', missed: true }])
  })

  const toolResult = (id: string): Msg => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Friday works.' }] })

  it.each(Object.keys(SCENARIOS))('%s: a side request on turn 0 (no tool list, or another model) is a miss', async (name) => {
    const model = createScriptedModel(SCENARIOS)
    expect((await model.handle(req(convo(0), false, { model: HARNESS_MODEL }), name)).status).toBe(400)
    expect((await model.handle(req(convo(0), false, { model: 'claude-haiku-5-5', tools: [{ name: 'Bash' }, { name: 'mcp__inhouse__question_ask' }] }), name)).status).toBe(400)
    expect(model.misses.map((m) => m.reason)).toEqual(['the request does not match the turn', 'the request does not match the turn'])
    expect((await model.handle(mainReq(convo(0)), name)).status).toBe(200)
  })

  it("ask: the resume (turn 1) answers only a request whose last user message carries the question's result", async () => {
    const model = createScriptedModel(SCENARIOS)
    const asked: Msg = { role: 'assistant', content: SCENARIOS.ask!.turns[0]!.content }
    expect((await model.handle(mainReq([{ role: 'user', content: 'q' }, asked, { role: 'user', content: 'go on' }]), 'ask')).status).toBe(400)
    const res = await model.handle(mainReq([{ role: 'user', content: 'q' }, asked, toolResult('toolu_scripted_ask')]), 'ask')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { content: { text: string }[] }).content[0]!.text).toBe('Noted, thanks.')
  })
})

// count_tokens (P3 R3), as the token counting docs describe it (read 2026-11-20). Ways it could fail: a body the real
// endpoint refuses gets a count (so the Worker's fallback never runs in tests); a refusal isn't the documented
// invalid_request_error 400; a countable body is refused, or the count isn't `{ input_tokens }`.
describe('count_tokens', () => {
  const count = (body: Record<string, unknown>) =>
    new Request('http://proxy/model/v1/messages/count_tokens', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...body }) })
  const img = (source: Record<string, unknown>) => ({ messages: [{ role: 'user', content: [{ type: 'image', source }, { type: 'text', text: 'what is it?' }] }] })
  const doc = (source: Record<string, unknown>) => ({ messages: [{ role: 'user', content: [{ type: 'document', source }] }] })

  it("answers a scenario's scripted count, and a default for others", async () => {
    const model = createScriptedModel({ s: { turns: [], countTokens: 1234 } })
    const r = await model.handle(count({}), 's')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ input_tokens: 1234 })
    const d = await (await createScriptedModel({ t: { turns: [] } }).handle(count({}), 't')).json()
    expect(d).toEqual({ input_tokens: expect.any(Number) })
    expect(model.misses).toEqual([])
  })

  it.each([
    ['a web search server tool', { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] }],
    ['a code execution server tool', { tools: [{ name: 'Bash' }, { type: 'code_execution_20250825', name: 'code_execution' }] }],
    ['the MCP connector', { mcp_servers: [{ type: 'url', url: 'https://mcp.example.com', name: 'x' }] }],
    ['an image with a url source', img({ type: 'url', url: 'https://example.com/a.png' })],
    ['a document with a file source', doc({ type: 'file', file_id: 'file_01' })],
    ['a document with a url source inside a tool result', { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } }] }] }] }],
  ])('%s: the documented invalid_request_error 400', async (_, body) => {
    const r = await createScriptedModel({ s: { turns: [], countTokens: 1 } }).handle(count(body), 's')
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } })
  })

  it.each([
    ['client tools (with and without type custom)', { tools: [{ name: 'Bash', input_schema: { type: 'object' } }, { type: 'custom', name: 'x', input_schema: { type: 'object' } }] }],
    ['an advisor tool', { tools: [{ type: 'advisor_20260301', name: 'advisor' }] }],
    ['a base64 image', img({ type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' })],
    ['a base64 PDF', doc({ type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' })],
  ])('%s: counted', async (_, body) => {
    const r = await createScriptedModel({ s: { turns: [], countTokens: 7 } }).handle(count(body), 's')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ input_tokens: 7 })
  })
})
