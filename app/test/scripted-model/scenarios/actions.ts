// Scripted scenarios for M2-D (N14, asks in the agent's flow), for a container run on the sandbox deploy with an
// operation turned on through the test-fakes hook (N2, N19). `action-tag-add`: turn 0 calls the `actions` server's
// `shopify_order_tag_add` (the write tool, waited on by the egress); turn 1 answers once that call's result is back, and
// it must be the egress's own answer (its words, or the structured JSON the real CLI passes on) with the action's id
// (never connector output). `action-approval-request`: the same through `approval_request` on the `inhouse` server (a
// card only, never a wait). The person answers the card through the real route while the first call waits; either way
// the result reaches the chat through the tool call or a resume.
import type { MessagesRequest, Scenario } from '../index.ts'

const HARNESS_MODEL = 'claude-sonnet-5-5'
export const ACTION_ORDER_ID = 'gid://shopify/Order/9001'
export const ACTION_TAG = 'm2d-scripted'
export const ACTION_TOOL = 'mcp__actions__shopify_order_tag_add'
export const APPROVAL_REQUEST_TOOL = 'mcp__inhouse__approval_request'
export const ACTION_DONE = 'The tag action has its answer.'
export const APPROVAL_ASKED = 'The approval is in Approvals.'

/** A main-loop request (the run's model and a tool list). The write tools are deferred like the others, so not checked by name. */
const isMainLoop = (r: MessagesRequest): true | string => {
  if (r.model !== HARNESS_MODEL) return `model ${String(r.model)}, not ${HARNESS_MODEL}`
  if (!Array.isArray(r.tools) || r.tools.length === 0) return 'no tool list (a side request)'
  return true
}

const textOnly = (m: MessagesRequest['messages'][number]): boolean =>
  m.role === 'system' ||
  (m.role === 'user' && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.every(b => (b as { type?: unknown })?.type === 'text'))))

const resultBlock = (r: MessagesRequest, id: string): { is_error?: unknown; content?: unknown } | undefined => {
  for (let i = r.messages.length - 1; i >= 0; i--) {
    const m = r.messages[i]!
    if (textOnly(m)) continue
    if (m.role !== 'user' || !Array.isArray(m.content)) return undefined
    const hit = m.content.find(b => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result' && (b as { tool_use_id?: unknown }).tool_use_id === id)
    if (hit) return hit as { is_error?: unknown; content?: unknown }
  }
  return undefined
}

const resultText = (block: { content?: unknown }): string =>
  typeof block.content === 'string' ? block.content
  : Array.isArray(block.content) ? block.content.map(b => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join(' ')
  : ''

const ACTION_ID = /^ac_[A-Za-z0-9_-]{22}$/

/**
 * The action's id as the result names it. The real CLI (2.1.328) hands the model a tool's `structuredContent` as JSON
 * (`{"approval_id":"ac_…","status":"sent"}`) in place of its text when the tool gives both, as the egress and the
 * `inhouse` server do; a client that passes the text on shows the words' `(approval_id: ac_…)`. Either way, the id.
 */
const actionIdIn = (text: string): string | undefined => {
  try {
    const data: unknown = JSON.parse(text)
    const id = typeof data === 'object' && data !== null ? (data as { approval_id?: unknown }).approval_id : undefined
    if (typeof id === 'string') return ACTION_ID.test(id) ? id : undefined
  } catch {
    // Not JSON: the words, below.
  }
  return /\(approval_id: (ac_[A-Za-z0-9_-]{22})\)/.exec(text)?.[1]
}

/** The call's result is back, not an error, and names the action by its id (the egress's and the tool's own answer). */
const answeredWithAction = (id: string) => (r: MessagesRequest): true | string => {
  const m = isMainLoop(r)
  if (m !== true) return m
  const b = resultBlock(r, id)
  if (!b) return `no result for ${id}`
  const text = resultText(b)
  if (b.is_error === true) return `result for ${id} is an error: "${text.slice(0, 300)}"`
  if (actionIdIn(text) === undefined) return `result for ${id} names no action: "${text.slice(0, 300)}"`
  return true
}

const args = { orderId: ACTION_ORDER_ID, tags: [ACTION_TAG] }

export const ACTIONS_SCENARIOS: Record<string, Scenario> = {
  'action-tag-add': {
    turns: [
      { content: [{ type: 'text', text: 'Adding the tag.' }, { type: 'tool_use', id: 'toolu_scripted_action_tag', name: ACTION_TOOL, input: args }], expect: isMainLoop },
      { content: [{ type: 'text', text: ACTION_DONE }], expect: answeredWithAction('toolu_scripted_action_tag') },
    ],
  },
  'action-approval-request': {
    turns: [
      {
        content: [{ type: 'tool_use', id: 'toolu_scripted_action_ask', name: APPROVAL_REQUEST_TOOL, input: { operation: 'shopify_order_tag_add', args } }],
        expect: isMainLoop,
      },
      { content: [{ type: 'text', text: APPROVAL_ASKED }], expect: answeredWithAction('toolu_scripted_action_ask') },
    ],
  },
}
