// Stage 1 M2-Q (N16): the scripted model's question scenarios. `question` asks one question with `question_ask` as the
// only call in its reply, so the runner defers it and the run ends waiting; once the person answers, the run resumes
// with `""`, the SDK runs the call again, and turn 1 answers with what the call returned (the option chosen).
// `question-beside` asks beside another call first: nothing is deferred, the tool says to ask on its own, and turn 1
// asks again alone. The specs: e2e/api/questions.spec.ts (on the sandbox deploy, `needsContainer()`).
import type { MessagesRequest, Scenario, ScriptedTurn } from '../index.ts'

type Check = NonNullable<ScriptedTurn['expect']>

export const QUESTION_TOOL = 'mcp__inhouse__question_ask'
export const QUESTION_ASKED = { question: 'Restock the blue mugs on Friday?', options: ['Yes, on Friday', 'No, wait a week'] }
/** What the turn after the resume says: this, then the call's result text. */
export const QUESTION_REPLY = 'Going with your answer. The question tool said:'

/**
 * The text of the newest tool result for call `id`, or a miss. Searched from the newest message back: the CLI can end a
 * request with a `system` message of its own (the budget line) after the tool result.
 */
function resultTextOf(r: MessagesRequest, id: string): string {
  for (let i = r.messages.length - 1; i >= 0; i--) {
    const content = r.messages[i]!.content
    const blocks = Array.isArray(content) ? (content as { type?: string; tool_use_id?: string; content?: unknown }[]) : []
    const block = blocks.find(b => b.type === 'tool_result' && b.tool_use_id === id)
    if (block === undefined) continue
    const c = block.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(p => (p as { text?: unknown }).text).filter(t => typeof t === 'string').join(' ')
    return ''
  }
  throw new Error(`no result for ${id}`)
}

export function questionScenarios(mainLoop: (tool?: string) => Check, resultIs: (id: string, error: boolean) => Check): Record<string, Scenario> {
  const both = (...checks: Check[]): Check => r => {
    for (const c of checks) {
      const v = c(r)
      if (v !== true) return v
    }
    return true
  }
  const answer = (id: string): ScriptedTurn => ({
    content: [{ type: 'text', text: QUESTION_REPLY }],
    contentFor: r => [{ type: 'text', text: `${QUESTION_REPLY} ${resultTextOf(r, id).slice(0, 300)}` }],
    expect: both(mainLoop(QUESTION_TOOL), resultIs(id, false)),
  })
  const ask = (id: string, after?: string): ScriptedTurn => ({
    content: [{ type: 'tool_use', id, name: QUESTION_TOOL, input: QUESTION_ASKED }],
    expect: after === undefined ? mainLoop(QUESTION_TOOL) : both(mainLoop(QUESTION_TOOL), resultIs(after, true)),
  })
  return {
    question: { turns: [ask('toolu_question_1'), answer('toolu_question_1')] },
    'question-beside': {
      turns: [
        {
          content: [
            { type: 'tool_use', id: 'toolu_question_b1', name: QUESTION_TOOL, input: QUESTION_ASKED },
            { type: 'tool_use', id: 'toolu_question_b2', name: 'mcp__inhouse__memory_search', input: { query: 'blue mugs' } },
          ],
          expect: mainLoop(QUESTION_TOOL),
        },
        ask('toolu_question_b3', 'toolu_question_b1'),
        answer('toolu_question_b3'),
      ],
    },
  }
}
