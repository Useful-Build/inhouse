// The scripted M2-D scenarios (test/scripted-model/scenarios/actions.ts) the container spec relies on
// (e2e/api/actions-container.spec.ts). They only run in a container on the deployed test build, so how turn 1 reads the
// write tool's result is proved here, against the scripted model itself. Ways they could fail, written first:
//  - the real CLI (2.1.328) hands the model a tool's `structuredContent` as JSON in place of its text, and turn 1 reads
//    only the words (the sandbox run for PR #444 missed on `{"approval_id":"ac_…","status":"sent"}`);
//  - turn 1 answers a result that names no action, a malformed id, or an error.
import { describe, expect, test } from 'vitest'
import { createScriptedModel } from '../../test/scripted-model/index.ts'
import { HARNESS_MODEL, SCENARIOS } from '../../test/scripted-model/scenarios.ts'
import { ACTION_DONE, ACTION_ORDER_ID, ACTION_TAG, ACTION_TOOL, APPROVAL_ASKED, APPROVAL_REQUEST_TOOL } from '../../test/scripted-model/scenarios/actions.ts'

const ID = 'ac_A0Sns-4QCFycYDEaeOQNfA'
type Block = { type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string }

/** A main-loop request after one call to `tool`, answered with `content` (and `is_error` when `error`). */
function request(scenario: string, tool: string, id: string, input: Record<string, unknown>, content: unknown, error = false) {
  const messages = [
    { role: 'user', content: `scenario:${scenario} do it` },
    { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(error ? { is_error: true } : {}) }] },
  ]
  return new Request('http://scripted.invalid/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: HARNESS_MODEL, tools: [{ name: tool }], messages }),
  })
}
const answer = async (res: Response): Promise<{ status: number; content: Block[]; miss: string }> =>
  res.status === 200 ? { status: 200, content: ((await res.json()) as { content: Block[] }).content, miss: '' } : { status: res.status, content: [], miss: await res.text() }

const CASES = [
  { scenario: 'action-tag-add', tool: ACTION_TOOL, done: ACTION_DONE },
  { scenario: 'action-approval-request', tool: APPROVAL_REQUEST_TOOL, done: APPROVAL_ASKED },
] as const

describe('the M2-D action scenarios', () => {
  for (const { scenario, tool, done } of CASES) {
    test(`${scenario}: turn 0 calls ${tool}; turn 1 answers a result naming the action, as JSON or as words`, async () => {
      const model = createScriptedModel(SCENARIOS)
      const opening = new Request('http://scripted.invalid/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: HARNESS_MODEL, tools: [{ name: tool }], messages: [{ role: 'user', content: `scenario:${scenario} do it` }] }),
      })
      const call = (await answer(await model.handle(opening, scenario))).content.find(b => b.type === 'tool_use')!
      expect(call.name).toBe(tool)
      const args = scenario === 'action-tag-add' ? call.input : (call.input as { args: unknown }).args
      expect(args).toEqual({ orderIds: [ACTION_ORDER_ID], tags: [ACTION_TAG] })

      const words = `Done. It went out: ${ACTION_TAG}. (approval_id: ${ID})`
      const results: unknown[] = [
        // What CLI 2.1.328 sent on the sandbox: the structured content, as JSON text.
        JSON.stringify({ approval_id: ID, status: 'sent' }),
        [{ type: 'text', text: JSON.stringify({ approval_id: ID, status: 'waiting' }) }],
        // A client that passes the words on.
        words,
        [{ type: 'text', text: words }],
      ]
      for (const content of results) {
        const r = await answer(await model.handle(request(scenario, tool, call.id!, call.input!, content), scenario))
        expect(r, JSON.stringify(content)).toMatchObject({ status: 200, content: [{ type: 'text', text: done }] })
      }
    })

    test(`${scenario}: turn 1 misses on a result with no action, a malformed id, or an error`, async () => {
      const model = createScriptedModel(SCENARIOS)
      const id = scenario === 'action-tag-add' ? 'toolu_scripted_action_tag' : 'toolu_scripted_action_ask'
      for (const [content, error] of [
        [JSON.stringify({ status: 'sent' }), false],
        [JSON.stringify({ approval_id: 'ac_short', status: 'sent' }), false],
        [JSON.stringify({ approval_id: `${ID}x`, status: 'sent' }), false],
        ['Done. It went out.', false],
        [`Done. (approval_id: ac_short)`, false],
        [JSON.stringify({ approval_id: ID, status: 'sent' }), true],
      ] as const) {
        const r = await answer(await model.handle(request(scenario, tool, id, {}, content, error), scenario))
        expect(r.status, content).toBe(400)
        expect(r.miss).toMatch(error ? /is an error/ : /names no action/)
      }
    })
  }
})
