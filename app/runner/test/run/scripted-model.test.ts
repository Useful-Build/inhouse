// The scripted model (app/test/scripted-model/). Ways it could fail, written first:
// - a request it has no turn for gets an answer anyway (the agent improvises and the test passes on a guess), or gets a
//   status the CLI retries for minutes instead of failing;
// - a turn is picked by request count, not conversation position, so a resume or a side request shifts every answer;
// - its stream doesn't add up to the message (a tool call's input lost or garbled);
// - a script's own `expect` or `hold` throws and the CLI gets a 500 (which it retries for minutes) instead of a miss;
// - a side request the CLI makes on its own (a title, a summary: no tool list) takes a scripted turn;
// - the `ask` scenario's resume answers a request that doesn't carry the question's result.
// - a tool scenario misses the real CLI's own requests (deferred tools left out of the tool list, WebFetch's page
//   summary as a side request of its own), so the CLI's 400 step-down spends calls before turn 0 and turn 1 never matches;
// - a tool's result is missed because the CLI ends the request with a trailing `system` message (the budget line).
// The real CLI against it is in test/store/eager.test.ts; its captured requests are fixtures/cli-requests.json.
import { readFileSync } from 'node:fs'
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { createScriptedModel, type MessagesRequest, type ScriptedBranch, type ScriptedTurn } from '../../../test/scripted-model/index.ts'
import { HARNESS_MODEL, SCENARIOS, mainLoop, resultOf, STRUCTURED_BAD_TURNS, STRUCTURED_SCHEMA, openParallelHold, parallelSubagents, subagentMarker } from '../../../test/scripted-model/scenarios.ts'

type Msg = { role: 'user' | 'assistant'; content: unknown }
const req = (messages: Msg[], stream = false, extra: Record<string, unknown> = {}) =>
  new Request('http://proxy/model/v1/messages?beta=true', { method: 'POST', body: JSON.stringify({ model: 'm', messages, stream, ...extra }) })
/** A main-loop request as the CLI makes it for a harness run: the run's model and its tool list. */
const mainReq = (messages: Msg[], stream = false) =>
  req(messages, stream, { model: HARNESS_MODEL, tools: [{ name: 'Bash' }, { name: 'mcp__inhouse__question_ask' }] })
/** A structured run's main-loop request: the CLI adds the StructuredOutput tool when outputFormat is set. */
const structuredReq = (messages: Msg[]) =>
  req(messages, false, { model: HARNESS_MODEL, tools: [{ name: 'Bash' }, { name: 'mcp__inhouse__question_ask' }, { name: 'StructuredOutput' }] })
/** A main-loop request with WebFetch in its tool list, as the WebFetch scenarios expect. */
const webReq = (messages: Msg[]) =>
  req(messages, false, { model: HARNESS_MODEL, tools: [{ name: 'Bash' }, { name: 'mcp__inhouse__question_ask' }, { name: 'WebFetch' }] })
/** A main-loop request with the memory tool in its list, as `memory-save` expects. */
const memoryReq = (messages: Msg[]) =>
  req(messages, false, { model: HARNESS_MODEL, tools: [{ name: 'Bash' }, { name: 'mcp__inhouse__memory_save' }] })
/** The main-loop request a scenario expects: a structured one for the structured scenarios, a WebFetch one for those, the memory one for `memory-save`. */
const mainFor = (name: string) => (name.startsWith('structured') ? structuredReq : name.startsWith('webfetch') ? webReq : name.startsWith('memory-save') ? memoryReq : mainReq)
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
    // The miss names the failed check (#tool-turns): no tool list, then the wrong model.
    expect(model.misses.map((m) => m.reason)).toEqual(['the request does not match the turn: no tool list (a side request)', `the request does not match the turn: model claude-haiku-5-5, not ${HARNESS_MODEL}`])
    expect((await model.handle(mainFor(name)(convo(0)), name)).status).toBe(200)
  })

  it.each([
    ['webfetch-allowed', 'toolu_scripted_fetch', 'https://example.com/', 'Read the page.'],
    ['webfetch-refused', 'toolu_scripted_fetch_refused', 'https://10.0.0.1/', 'The page could not be read.'],
  ])('%s: turn 0 makes one WebFetch to the literal URL; turn 1 answers only a request carrying its result', async (name, id, url, answer) => {
    const model = createScriptedModel(SCENARIOS)
    const first = (await (await model.handle(webReq(convo(0)), name)).json()) as { content: { type: string; name?: string; input?: unknown }[] }
    expect(first.content).toEqual([expect.objectContaining({ type: 'tool_use', name: 'WebFetch', input: { url, prompt: name === 'webfetch-allowed' ? 'Summarise the page (scenario:webfetch-allowed)' : 'Summarise the page' } })])
    const asked: Msg = { role: 'assistant', content: SCENARIOS[name]!.turns[0]!.content }
    expect((await model.handle(webReq([{ role: 'user', content: 'q' }, asked, { role: 'user', content: 'go on' }]), name)).status).toBe(400)
    const res = await model.handle(webReq([{ role: 'user', content: 'q' }, asked, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...(name === 'webfetch-refused' ? { is_error: true } : {}) }] }]), name)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { content: { text: string }[] }).content[0]!.text).toBe(answer)
  })

  it('memory-save: turn 0 saves the literal person fact; turn 1 answers only a request carrying the save\'s result', async () => {
    const model = createScriptedModel(SCENARIOS)
    const first = (await (await model.handle(memoryReq(convo(0)), 'memory-save')).json()) as { content: { type: string; name?: string; input?: unknown }[] }
    expect(first.content).toEqual([expect.objectContaining({ type: 'tool_use', name: 'mcp__inhouse__memory_save', input: { scope: 'person', text: 'Likes the weekly stock report as a table.' } })])
    const asked: Msg = { role: 'assistant', content: SCENARIOS['memory-save']!.turns[0]!.content }
    expect((await model.handle(memoryReq([{ role: 'user', content: 'q' }, asked, { role: 'user', content: 'go on' }]), 'memory-save')).status).toBe(400)
    expect((await model.handle(memoryReq([{ role: 'user', content: 'q' }, asked, toolResult('toolu_scripted_memory')]), 'memory-save')).status).toBe(200)
  })

  it.each([
    ['webfetch-allowed', 'toolu_scripted_fetch', true],
    ['webfetch-refused', 'toolu_scripted_fetch_refused', false],
  ])('%s: a result whose is_error is the other way round is a miss (the turn fails loud)', async (name, id, wrongError) => {
    const model = createScriptedModel(SCENARIOS)
    const asked: Msg = { role: 'assistant', content: SCENARIOS[name]!.turns[0]!.content }
    const wrong: Msg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...(wrongError ? { is_error: true } : { is_error: false }) }] }
    expect((await model.handle(webReq([{ role: 'user', content: 'q' }, asked, wrong]), name)).status).toBe(400)
    expect(model.misses.at(-1)!.reason).toBe(`the request does not match the turn: the result for ${id} has is_error ${wrongError}, not ${!wrongError}; it says: "x"`)
    const right: Msg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...(wrongError ? {} : { is_error: true }) }] }
    expect((await model.handle(webReq([{ role: 'user', content: 'q' }, asked, right]), name)).status).toBe(200)
  })

  it('slow-bash: turn 0 is a text and one Bash call that sleeps 20 seconds (literal); turn 1 answers only a request carrying its result', async () => {
    const model = createScriptedModel(SCENARIOS)
    const first = (await (await model.handle(mainReq(convo(0)), 'slow-bash')).json()) as { content: { type: string; name?: string; text?: string; input?: { command: string } }[] }
    expect(first.content.map((b) => b.text ?? b.name)).toEqual(['Waiting a while.', 'Bash'])
    expect(first.content[1]!.input!.command).toBe('sleep 20 && echo waited')
    const asked: Msg = { role: 'assistant', content: SCENARIOS['slow-bash']!.turns[0]!.content }
    expect((await model.handle(mainReq([{ role: 'user', content: 'q' }, asked, { role: 'user', content: 'go on' }]), 'slow-bash')).status).toBe(400)
    const res = await model.handle(mainReq([{ role: 'user', content: 'q' }, asked, toolResult('toolu_scripted_slow')]), 'slow-bash')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { content: { text: string }[] }).content[0]!.text).toBe('Done waiting.')
  })

  it('memory-save-team: turn 0 saves the literal team fact (scope brand); turn 1 answers only a request carrying the save\'s result', async () => {
    const model = createScriptedModel(SCENARIOS)
    const first = (await (await model.handle(memoryReq(convo(0)), 'memory-save-team')).json()) as { content: { type: string; name?: string; input?: unknown }[] }
    expect(first.content).toEqual([expect.objectContaining({ type: 'tool_use', name: 'mcp__inhouse__memory_save', input: { scope: 'brand', text: 'We restock on Fridays.' } })])
    const asked: Msg = { role: 'assistant', content: SCENARIOS['memory-save-team']!.turns[0]!.content }
    expect((await model.handle(memoryReq([{ role: 'user', content: 'q' }, asked, { role: 'user', content: 'go on' }]), 'memory-save-team')).status).toBe(400)
    const res = await model.handle(memoryReq([{ role: 'user', content: 'q' }, asked, toolResult('toolu_scripted_memory_team')]), 'memory-save-team')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { content: { text: string }[] }).content[0]!.text).toBe('Saved for the team.')
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

// Branches (revision 5, item 6d): parallel subagents each start their own conversation at turn 0. Ways it could fail:
// a subagent's request takes the main thread's turn (or another subagent's); a request two branches match gets an
// answer; a branch's own `match` that throws is a 500; today's scenarios (no branches) change; the four held answers
// aren't all asked for at once, or one goes before the hold opens.
describe('branches', () => {
  const sub = (i: number, assistants = 0) => [{ role: 'user' as const, content: `${subagentMarker(i)} Check part ${i} and report.` }, ...Array.from({ length: assistants }, () => [{ role: 'assistant' as const, content: 'a' }, { role: 'user' as const, content: 'r' }]).flat()]
  const text = async (r: Response) => ((await r.json()) as { content: { type: string; text?: string; id?: string }[] }).content

  it('a request a branch matches takes that branch, by its own position; others are the main thread', async () => {
    const model = createScriptedModel({
      s: {
        turns: [turn(0), turn(1)],
        branches: {
          a: { match: (r) => JSON.stringify(r.messages[0]).includes('[A]'), turns: [{ content: [{ type: 'text', text: 'a0' }] }, { content: [{ type: 'text', text: 'a1' }] }] },
          b: { match: (r) => JSON.stringify(r.messages[0]).includes('[B]'), turns: [{ content: [{ type: 'text', text: 'b0' }] }] },
        },
      },
    })
    expect((await text(await model.handle(req([{ role: 'user', content: '[A] go' }]), 's')))[0]!.text).toBe('a0')
    expect((await text(await model.handle(req([{ role: 'user', content: '[B] go' }]), 's')))[0]!.text).toBe('b0')
    expect((await text(await model.handle(req(convo(0)), 's')))[0]!.text).toBe('turn 0')
    expect((await text(await model.handle(req([{ role: 'user', content: '[A] go' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }]), 's')))[0]!.text).toBe('a1')
    expect((await text(await model.handle(req(convo(1)), 's')))[0]!.text).toBe('turn 1')
    expect(model.misses).toEqual([])
    expect(model.log.map((l) => l.branch ?? 'main')).toEqual(['a', 'b', 'main', 'a', 'main'])
  })

  it.each<[string, Record<string, ScriptedBranch>]>([
    ['two branches match', { x: { match: () => true, turns: [turn(0)] }, y: { match: () => true, turns: [turn(0)] } }],
    ['a match throws', { x: { match: (): boolean => { throw new Error('boom') }, turns: [turn(0)] } }],
  ])('%s: a miss (a 400 the CLI does not retry), recorded', async (_, branches) => {
    const model = createScriptedModel({ s: { turns: [turn(0)], branches } })
    const r = await model.handle(req(convo(0)), 's')
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: { type: 'invalid_request_error' } })
    expect(model.misses).toHaveLength(1)
  })

  it('a branch past its own turns is a miss that names the branch', async () => {
    const model = createScriptedModel({ s: { turns: [turn(0)], branches: { a: { match: (r) => JSON.stringify(r.messages[0]).includes('[A]'), turns: [turn(0)] } } } })
    const r = await model.handle(req([{ role: 'user', content: '[A]' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }]), 's')
    expect(r.status).toBe(400)
    expect(model.misses[0]!.reason).toContain('branch "a"')
  })

  it('parallel-4: four Agent calls in one turn; the four subagent answers are all asked for and held together, then go', async () => {
    let open!: () => void
    const held = new Promise<void>((r) => (open = r))
    const model = createScriptedModel({ p: parallelSubagents(() => held) })
    const first = await text(await model.handle(mainReq(convo(0)), 'p'))
    expect(first.map((b) => [b.type, b.id])).toEqual([0, 1, 2, 3].map((i) => ['tool_use', `toolu_scripted_sub_${i}`]))
    let answered = 0
    const pending = [0, 1, 2, 3].map((i) => model.handle(mainReq(sub(i)), 'p').then(async (r) => (answered++, text(r))))
    // All four asked for (logged) while none has answered: four calls in flight at once.
    for (let k = 0; k < 50 && model.log.length < 5; k++) await new Promise((r) => setImmediate(r))
    expect(model.log.slice(1).map((l) => l.branch).sort()).toEqual(['subagent-0', 'subagent-1', 'subagent-2', 'subagent-3'])
    expect(answered).toBe(0)
    open()
    const answers = await Promise.all(pending)
    expect(answers.map((a) => a[0]!.text)).toEqual([0, 1, 2, 3].map((i) => `Subagent ${i} found nothing to add.`))
    // The main thread's next turn needs all four results.
    const results = [0, 1, 2, 3].map((i) => ({ type: 'tool_result', tool_use_id: `toolu_scripted_sub_${i}`, content: 'ok' }))
    const partial = await model.handle(mainReq([{ role: 'user', content: 'q' }, { role: 'assistant', content: first }, { role: 'user', content: results.slice(0, 3) }]), 'p')
    expect(partial.status).toBe(400)
    const done = await text(await model.handle(mainReq([{ role: 'user', content: 'q' }, { role: 'assistant', content: first }, { role: 'user', content: results }]), 'p'))
    expect(done[0]!.text).toBe('All four parts checked.')
  })

  it('the harness copy of parallel-4 holds until openParallelHold()', async () => {
    const model = createScriptedModel(SCENARIOS)
    let answered = false
    const p = model.handle(mainReq(sub(2)), 'parallel-4').then(() => (answered = true))
    for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r))
    expect(answered).toBe(false)
    openParallelHold()
    await p
    expect(answered).toBe(true)
  })
})

// The structured scenarios (R3 follow-up): `structured` answers with StructuredOutput matching STRUCTURED_SCHEMA;
// `structured-retries` answers it with input that never matches, at every position, so the SDK gives up first.
describe('structured scenarios', () => {
  it('structured: turn 0 calls StructuredOutput with the answer, which matches the schema by hand', async () => {
    const model = createScriptedModel(SCENARIOS)
    // A request without the StructuredOutput tool (a run not asked for structured output) gets no answer.
    expect((await model.handle(mainReq(convo(0)), 'structured')).status).toBe(400)
    const r = await model.handle(structuredReq(convo(0)), 'structured')
    const body = (await r.json()) as { content: { type: string; name?: string; input?: unknown }[] }
    expect(body.content).toEqual([{ type: 'tool_use', id: 'toolu_scripted_structured', name: 'StructuredOutput', input: { late_orders: 3, summary: 'Three orders shipped late.' } }])
    expect(STRUCTURED_SCHEMA.required).toEqual(['late_orders', 'summary'])
  })

  it('structured-retries: every position answers StructuredOutput with a string where the schema wants an integer', async () => {
    const model = createScriptedModel(SCENARIOS)
    for (let n = 0; n < STRUCTURED_BAD_TURNS; n++) {
      const body = (await (await model.handle(structuredReq(convo(n)), 'structured-retries')).json()) as { content: { name: string; input: { late_orders: unknown } }[] }
      expect(body.content[0]!.name).toBe('StructuredOutput')
      expect(typeof body.content[0]!.input.late_orders).toBe('string')
    }
    expect(model.misses).toEqual([])
  })
})

// The requests the real CLI sent (fixtures/cli-requests.json: SDK 0.3.328, the runner's tool list, captured over
// loopback). Each must take its scripted turn on the first try: a miss there is a 400 the CLI's step-down retries
// (Q2 saw 3 refused calls before turn 0, and turn 1 never matching).
describe("the real CLI's requests", () => {
  const captured = JSON.parse(readFileSync(new URL('../../../test/scripted-model/fixtures/cli-requests.json', import.meta.url), 'utf8')) as Record<string, Record<string, MessagesRequest>>
  const post = (body: MessagesRequest) => new Request('http://proxy/model/v1/messages?beta=true', { method: 'POST', body: JSON.stringify({ ...body, stream: false }) })
  const answer = async (model: ReturnType<typeof createScriptedModel>, body: MessagesRequest, scenario: string) => {
    const res = await model.handle(post(body), scenario)
    return { status: res.status, content: ((await res.json()) as { content?: { type: string; text?: string; name?: string }[] }).content?.map((b) => b.text ?? b.name) }
  }

  it('the CLI leaves deferred tools out of its list: WebFetch is not listed, a defer_loading placeholder is', () => {
    const tools = captured['webfetch-allowed']!.turn0!.tools!
    expect(tools.some((t) => t.name === 'WebFetch')).toBe(false)
    expect(tools.filter((t) => t.defer_loading === true).map((t) => t.name)).toEqual(['DeferredToolPlaceholder'])
  })

  it.each([
    ['webfetch-allowed', ['WebFetch'], ['Read the page.']],
    ['webfetch-refused', ['WebFetch'], ['The page could not be read.']],
    ['write-output', ['Writing the table.', 'Bash'], ['Saved outputs/table.csv.']],
    ['memory-save', ['mcp__inhouse__memory_save'], ['Saved.']],
  ])('%s: turn 0 and turn 1 answer the captured requests on the first try', async (name, turn0, turn1) => {
    const model = createScriptedModel(SCENARIOS)
    expect(await answer(model, captured[name]!.turn0!, name)).toEqual({ status: 200, content: turn0 })
    expect(await answer(model, captured[name]!.turn1!, name)).toEqual({ status: 200, content: turn1 })
    expect(model.misses).toEqual([])
  })

  it("slow-bash: the real CLI's write-output requests (the same text-plus-Bash shape), with the call id renamed, get its two answers on the first try", async () => {
    const model = createScriptedModel(SCENARIOS)
    const turn1 = JSON.parse(JSON.stringify(captured['write-output']!.turn1!).replaceAll('toolu_scripted_write', 'toolu_scripted_slow')) as MessagesRequest
    expect(await answer(model, captured['write-output']!.turn0!, 'slow-bash')).toEqual({ status: 200, content: ['Waiting a while.', 'Bash'] })
    expect(await answer(model, turn1, 'slow-bash')).toEqual({ status: 200, content: ['Done waiting.'] })
    expect(model.misses).toEqual([])
  })

  it("webfetch-allowed: WebFetch's page summary (its own side request, the prompt's marker in it) gets an answer", async () => {
    const summary = captured['webfetch-allowed']!['page-summary']!
    expect(JSON.stringify(summary.messages)).toContain('scenario:webfetch-allowed')
    const model = createScriptedModel(SCENARIOS)
    expect(await answer(model, summary, 'webfetch-allowed')).toEqual({ status: 200, content: ['A page kept for documentation examples.'] })
    expect(model.log.at(-1)).toMatchObject({ branch: 'page-summary', turn: 0, missed: false })
  })

  // Q2 on fleet 7a6ce90: every runner run sets maxBudgetUsd, so the CLI ends turn 1 with its budget line as a `system`
  // message after the tool's result; the result must still be found there, and a missing one must still miss.
  it.each([
    ['webfetch-allowed', ['WebFetch'], ['Read the page.']],
    ['webfetch-refused', ['WebFetch'], ['The page could not be read.']],
    ['write-output', ['Writing the table.', 'Bash'], ['Saved outputs/table.csv.']],
    ['memory-save', ['mcp__inhouse__memory_save'], ['Saved.']],
  ])('%s: turn 1 with the trailing budget line still finds the result', async (name, turn0, turn1) => {
    const budget = captured[name]!['turn1-budget']!
    expect(budget.messages.at(-1)).toMatchObject({ role: 'system', content: [{ type: 'text', text: expect.stringMatching(/^USD budget: /) }] })
    const model = createScriptedModel(SCENARIOS)
    expect(await answer(model, captured[name]!.turn0!, name)).toEqual({ status: 200, content: turn0 })
    expect(await answer(model, budget, name)).toEqual({ status: 200, content: turn1 })
    expect(model.misses).toEqual([])
  })

  it('a turn 1 whose result is missing still misses, past the trailing budget line or a text-only message', async () => {
    const budget = captured['write-output']!['turn1-budget']!
    const noResult = { ...budget, messages: budget.messages.filter((_, i) => i !== budget.messages.length - 2) }
    const textAfter = { ...noResult, messages: [...noResult.messages.slice(0, -1), { role: 'user' as const, content: [{ type: 'text', text: 'go on' }] }, noResult.messages.at(-1)!] }
    const model = createScriptedModel(SCENARIOS)
    expect((await answer(model, noResult, 'write-output')).status).toBe(400)
    expect((await answer(model, textAfter, 'write-output')).status).toBe(400)
    expect(model.misses.map((m) => m.reason)).toEqual([
      'the request does not match the turn: no result for toolu_scripted_write: the last message is system (text)',
      'the request does not match the turn: no result for toolu_scripted_write: the last message is system (text)',
    ])
  })

  it('the look-back stops at the last assistant message: an older turn\'s result does not count', () => {
    const budget = captured['write-output']!['turn1-budget']!
    const later = { ...budget, messages: [...budget.messages.slice(0, -1), { role: 'assistant' as const, content: [{ type: 'text', text: 'Saved outputs/table.csv.' }] }, budget.messages.at(-1)!] }
    expect(resultOf('toolu_scripted_write')(budget)).toBe(true)
    expect(resultOf('toolu_scripted_write')(later)).toBe('no result for toolu_scripted_write: the last message is system (text)')
  })

  it('webfetch-refused: the trailing budget line does not hide an is_error the other way round', async () => {
    const budget = captured['webfetch-refused']!['turn1-budget']!
    const at = budget.messages.length - 2
    const flipped = { ...budget, messages: budget.messages.map((m, i) => (i === at ? { ...m, content: (m.content as Record<string, unknown>[]).map((b) => ({ ...b, is_error: false })) } : m)) }
    const model = createScriptedModel(SCENARIOS)
    expect((await answer(model, flipped, 'webfetch-refused')).status).toBe(400)
    expect(model.misses.map((m) => m.reason)).toEqual(['the request does not match the turn: the result for toolu_scripted_fetch_refused has is_error false, not true; it says: "refused by the egress"'])
  })

  // Q2 (fleet 9390b3c): webfetch-allowed's turn 1 saw is_error true, and the side request's own miss sat only in the
  // tool_result, which nobody could read. The miss now quotes the result (capped), so the visible error carries it.
  it("webfetch-allowed: an errored fetch's miss quotes what the result says, capped", async () => {
    const turn1 = captured['webfetch-allowed']!['turn1-budget']!
    const at = turn1.messages.findIndex((m) => JSON.stringify(m.content).includes('"tool_result"'))
    const withResult = (content: unknown) => ({ ...turn1, messages: turn1.messages.map((m, i) => (i === at ? { ...m, content: [{ type: 'tool_result', tool_use_id: 'toolu_scripted_fetch', content, is_error: true }] } : m)) })
    const sideMiss = 'API Error: 400 scripted model miss: scenario "hello", turn 0: the request does not match the turn: no tool list (a side request)'
    const model = createScriptedModel(SCENARIOS)
    expect((await answer(model, withResult(sideMiss), 'webfetch-allowed')).status).toBe(400)
    expect((await answer(model, withResult([{ type: 'text', text: 'a'.repeat(450) }]), 'webfetch-allowed')).status).toBe(400)
    expect(model.misses.map((m) => m.reason)).toEqual([
      `the request does not match the turn: the result for toolu_scripted_fetch has is_error true, not false; it says: "${sideMiss}"`,
      `the request does not match the turn: the result for toolu_scripted_fetch has is_error true, not false; it says: "${'a'.repeat(400)}"`,
    ])
  })

  it('the placeholder stands in only for a tool the runner gives the agent: an unknown tool is still a miss', () => {
    const turn0 = captured['webfetch-allowed']!.turn0!
    expect(mainLoop('WebFetch')(turn0)).toBe(true)
    expect(mainLoop('mcp__inhouse__routine_create')(turn0)).toBe(true)
    expect(mainLoop('NoSuchTool')(turn0)).toBe("the tool list doesn't offer NoSuchTool")
  })

  it.each([
    ['the marker without page content', (r: MessagesRequest) => ({ ...r, messages: [{ role: 'user' as const, content: [{ type: 'text', text: 'Summarise the page (scenario:webfetch-allowed)' }] }] })],
    ['page content with a tool list', (r: MessagesRequest) => ({ ...r, tools: [{ name: 'Bash' }] })],
    ['two messages', (r: MessagesRequest) => ({ ...r, messages: [...r.messages, { role: 'user' as const, content: 'again' }] })],
  ])('webfetch-allowed: a request like the page summary but with %s is a miss, not the branch', async (_, change) => {
    const model = createScriptedModel(SCENARIOS)
    expect((await answer(model, change(captured['webfetch-allowed']!['page-summary']!), 'webfetch-allowed')).status).toBe(400)
    expect(model.misses).toHaveLength(1)
    expect(model.log.some((l) => l.branch === 'page-summary')).toBe(false)
  })

  it('webfetch-refused: the captured turn 1 with is_error flipped is still a miss that says so', async () => {
    const turn1 = captured['webfetch-refused']!.turn1!
    const flipped = { ...turn1, messages: turn1.messages.map((m, i) => (i === turn1.messages.length - 1 ? { ...m, content: (m.content as Record<string, unknown>[]).map((b) => ({ ...b, is_error: false })) } : m)) }
    const model = createScriptedModel(SCENARIOS)
    expect((await answer(model, flipped, 'webfetch-refused')).status).toBe(400)
    expect(model.misses.map((m) => m.reason)).toEqual(['the request does not match the turn: the result for toolu_scripted_fetch_refused has is_error false, not true; it says: "refused by the egress"'])
  })
})
