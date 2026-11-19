// The scripted model (app/test/scripted-model/). Ways it could fail, written first:
// - a request it has no turn for gets an answer anyway (the agent improvises and the test passes on a guess), or gets a
//   status the CLI retries for minutes instead of failing;
// - a turn is picked by request count, not conversation position, so a resume or a side request shifts every answer;
// - its stream doesn't add up to the message (a tool call's input lost or garbled).
// The real CLI against it is in test/store/eager.test.ts.
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { createScriptedModel, type ScriptedTurn } from '../../../test/scripted-model/index.ts'
import { SCENARIOS } from '../../../test/scripted-model/scenarios.ts'

const req = (messages: { role: 'user' | 'assistant'; content: unknown }[], stream = false) =>
  new Request('http://proxy/model/v1/messages?beta=true', { method: 'POST', body: JSON.stringify({ model: 'm', messages, stream }) })
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
    const text = await (await model.handle(req(convo(0), true), 'write-output')).text()
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
})
