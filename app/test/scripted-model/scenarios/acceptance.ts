// Stage 1 M2-J (M2 acceptance): the scripted model's scenarios for the sandbox specs (e2e/api/actions-flow.spec.ts and
// e2e/api/questions.spec.ts, `needsContainer()`), with an operation turned on only through the test-fakes hook (N2, N19).
//  - `action-late-answer`: turn 0 calls the `actions` server's `shopify_order_tag_add` and nobody answers, so the egress's
//    2-minute wait ends and the call returns "waiting" (N14 step 4); turn 1 says so. The person answers after the turn
//    ended: the send goes out and the server sends one resume turn into the chat (`report = 'later'`, `source: 'action'`,
//    M2-G's action texts); turn 2 answers that note, and only a note from Inhouse that names the card and says it went out.
//  - `routine-create-question`: one `routine_create` whose instruction plays `routine-question`, so the routine's own run
//    asks its creator a question and waits (N16); the answer lets it finish. The routine's name comes from the person's message
//    (`routine-name:<name>`), so each run of the spec finds its own routine.
import type { MessagesRequest, Scenario, ScriptedTurn } from '../index.ts'

type Check = NonNullable<ScriptedTurn['expect']>

export const LATE_TOOL = 'mcp__actions__shopify_order_tag_add'
export const LATE_ORDER_ID = 'gid://shopify/Order/9001'
/** The tag the late answer's write carries; the spec counts the fake store's writes with it before and after. */
export const LATE_TAG = 'm2j-late-answer'
/** The card's title for that write, as the operation table words it (server/outbox/operations/shopify-order-tag-add.ts). */
export const LATE_TITLE = 'Add a tag to order 9001'
export const LATE_STARTED = 'Asking to add the tag.'
export const LATE_WAITING = 'The tag is waiting for your OK in Approvals.'
export const LATE_DONE = 'The tag went out after you allowed it.'

/**
 * What the routine made by `routine-create-question` runs: `routine-question`, asked of its creator. Not the chat's
 * `question` scenario: a routine's turn runs on the brand's default model, not the harness's chat model that scenario
 * checks for.
 */
export const QUESTION_ROUTINE_INSTRUCTION = 'scenario:routine-question Check the blue mugs stock and ask before restocking.'
export const ROUTINE_QUESTION_TOOL = 'mcp__inhouse__question_ask'
export const ROUTINE_QUESTION = { question: 'Restock the blue mugs this week?', options: ['Yes, this week', 'No, next month'] }
export const ROUTINE_QUESTION_REPLY = 'Going with your answer for the routine.'
export const QUESTION_ROUTINE_CREATED = 'The question routine was created.'
const ROUTINE_NAME = /routine-name:([A-Za-z0-9-]{1,40})/

const TOOL_USE_ID = 'toolu_scripted_late_tag'
/**
 * How a turn the server writes itself starts (N20: it says it is an automatic note from Inhouse, not the person). Written
 * out here, not imported from server/prompt/: the scenario is the oracle, and the prompt module's types need the Workers'.
 */
export const NOTE_PREFIX = '[Automatic note from Inhouse, not a message from the person]'

/** A user message's prompt text: its string, or its text blocks joined; empty for a tool result. */
function promptText(m: MessagesRequest['messages'][number]): string {
  if (m.role !== 'user') return ''
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  const blocks = m.content as { type?: unknown; text?: unknown }[]
  if (blocks.some(b => b?.type === 'tool_result')) return ''
  return blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}

/** The text of the result of call `id`, newest first; undefined when there is none. */
function resultTextOf(r: MessagesRequest, id: string): string | undefined {
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
  return undefined
}

/**
 * The call came back still waiting, naming its action: the structured answer the real CLI passes on
 * (`{"approval_id":"ac_…","status":"waiting",…}`), or the words a client that passes the text on shows.
 */
const cameBackWaiting = (r: MessagesRequest): true | string => {
  const text = resultTextOf(r, TOOL_USE_ID)
  if (text === undefined) return `no result for ${TOOL_USE_ID}`
  try {
    const data = JSON.parse(text) as { approval_id?: unknown; status?: unknown }
    if (typeof data.approval_id === 'string' && data.status === 'waiting') return true
  } catch {
    // Not JSON: the words, below.
  }
  if (/It's in Approvals\..*\(approval_id: ac_[A-Za-z0-9_-]{22}\)/.test(text)) return true
  return `the result for ${TOOL_USE_ID} isn't the waiting answer: "${text.slice(0, 300)}"`
}

/** The newest user prompt is the server's resume note: from Inhouse, naming the card, saying it went out. */
const resumeNote = (r: MessagesRequest): true | string => {
  const last = [...r.messages].reverse().find(m => promptText(m) !== '')
  const text = last ? promptText(last) : ''
  if (!text.startsWith(NOTE_PREFIX)) return `the newest prompt isn't a note from Inhouse: "${text.slice(0, 300)}"`
  if (!text.includes(`"${LATE_TITLE}"`) || !text.includes('went out')) return `the note doesn't say "${LATE_TITLE}" went out: "${text.slice(0, 300)}"`
  return true
}

/**
 * A routine's main-loop request: a Claude model (whichever the brand's default is) with a tool list that offers
 * `question_ask`.
 */
const routineLoop = (r: MessagesRequest): true | string => {
  if (typeof r.model !== 'string' || !r.model.startsWith('claude-')) return `model ${String(r.model)}`
  if (!Array.isArray(r.tools) || r.tools.length === 0) return 'no tool list (a side request)'
  // Listed by name, or left to tool search behind the CLI's `defer_loading` placeholder (scenarios.ts `offers`).
  return r.tools.some(t => t.name === ROUTINE_QUESTION_TOOL || t.defer_loading === true) ? true : `the tool list doesn't offer ${ROUTINE_QUESTION_TOOL}`
}

export function acceptanceScenarios(mainLoop: (tool?: string) => Check, resultIs: (id: string, error: boolean) => Check): Record<string, Scenario> {
  const both = (...checks: Check[]): Check => r => {
    for (const c of checks) {
      const v = c(r)
      if (v !== true) return v
    }
    return true
  }
  const loop = mainLoop()
  const routineCall = 'toolu_scripted_routine_question'
  const routineAsk = 'toolu_scripted_routine_ask'
  return {
    // The routine's own run: one lone `question_ask` (so the runner defers it and the run waits on the creator), then, once
    // the call has run again with the answer, a closing line.
    'routine-question': {
      turns: [
        { content: [{ type: 'tool_use', id: routineAsk, name: ROUTINE_QUESTION_TOOL, input: ROUTINE_QUESTION }], expect: routineLoop },
        { content: [{ type: 'text', text: ROUTINE_QUESTION_REPLY }], expect: both(routineLoop, resultIs(routineAsk, false)) },
      ],
    },
    'action-late-answer': {
      turns: [
        { content: [{ type: 'text', text: LATE_STARTED }, { type: 'tool_use', id: TOOL_USE_ID, name: LATE_TOOL, input: { orderId: LATE_ORDER_ID, tags: [LATE_TAG] } }], expect: loop },
        { content: [{ type: 'text', text: LATE_WAITING }], expect: both(loop, resultIs(TOOL_USE_ID, false), cameBackWaiting) },
        { content: [{ type: 'text', text: LATE_DONE }], expect: both(loop, resumeNote) },
      ],
    },
    'routine-create-question': {
      turns: [
        {
          content: [{ type: 'tool_use', id: routineCall, name: 'mcp__inhouse__routine_create', input: { name: 'routine-name', instruction: QUESTION_ROUTINE_INSTRUCTION, days: 'daily', time: '06:00' } }],
          contentFor: r => {
            const name = ROUTINE_NAME.exec(r.messages.map(promptText).join('\n'))?.[1]
            if (name === undefined) throw new Error('the message names no routine-name:<name>')
            return [{ type: 'tool_use', id: routineCall, name: 'mcp__inhouse__routine_create', input: { name, instruction: QUESTION_ROUTINE_INSTRUCTION, days: 'daily', time: '06:00' } }]
          },
          expect: loop,
        },
        { content: [{ type: 'text', text: QUESTION_ROUTINE_CREATED }], expect: both(loop, resultIs(routineCall, false)) },
      ],
    },
  }
}
