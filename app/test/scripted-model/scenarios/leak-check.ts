// Scripted scenario for M1-G (fetch leak check). Turn 0 reads order #1001 through the hub (`order_get`, so the order
// the fetch then names is the one read; `orders_search` would answer the newest order instead). Turn 1 checks that read
// carried #1001, then fetches a control page on the listed host (`example.com`) with nothing private in it: it must go
// through, which proves the host is listed and reachable. Turn 2 fetches the same host with `#1001` in the query: the
// only difference from the control is the token, so a refusal there is the leak check's. Both fetches carry the
// scenario's marker in their prompt, so an allowed fetch gets its page summary answered and comes back as that summary:
// a leak fetch that went out fails turn 3's check (it is neither the refusal nor the CLI's 403 text).
import type { MessagesRequest, Scenario } from '../index.ts'

export const WEBFETCH_LEAK_REFUSED_ANSWER = 'WebFetch was refused by the leak check.'
/** The order the scenario reads and then tries to send out. */
export const LEAK_ORDER_NAME = '#1001'
export const LEAK_CONTROL_URL = 'https://example.com/?ref=leak-check-control'
export const LEAK_URL = `https://example.com/?order=${encodeURIComponent(LEAK_ORDER_NAME)}`

const HARNESS_MODEL = 'claude-sonnet-5-5'
/** Brings each fetch's page-summary side request to this scenario (see `webfetch-allowed` in scenarios.ts). */
const FETCH_PROMPT = 'Summarise the page (scenario:webfetch-leak)'

export const isMainLoop = (r: MessagesRequest): true | string => {
  if (r.model !== HARNESS_MODEL) return `model ${String(r.model)}, not ${HARNESS_MODEL}`
  if (!Array.isArray(r.tools) || r.tools.length === 0) return 'no tool list (a side request)'
  return true
}

const firstUserText = (r: MessagesRequest): string => {
  const c = r.messages.find(m => m.role === 'user')?.content
  if (typeof c === 'string') return c
  return Array.isArray(c) ? c.map(b => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : ''
}

/** WebFetch's side request: no tools, one user message with the fetched page and the fetch's prompt (`prompt`). */
export const pageSummaryOf = (prompt: string) => (r: MessagesRequest): boolean =>
  Array.isArray(r.tools) && r.tools.length === 0 && r.messages.length === 1 && firstUserText(r).includes('Web page content:') && firstUserText(r).includes(prompt)
const pageSummary = pageSummaryOf(FETCH_PROMPT)

/** A message that only adds text after a tool's result (the CLI's budget line, say): looked past, as in scenarios.ts. */
const textOnly = (m: MessagesRequest['messages'][number]): boolean =>
  m.role === 'system' ||
  (m.role === 'user' && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.every(b => (b as { type?: unknown })?.type === 'text'))))

export const resultBlock = (r: MessagesRequest, id: string): { is_error?: unknown; content?: unknown } | undefined => {
  for (let i = r.messages.length - 1; i >= 0; i--) {
    const m = r.messages[i]!
    if (textOnly(m)) continue
    if (m.role !== 'user' || !Array.isArray(m.content)) return undefined
    const hit = m.content.find(
      b => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result' && (b as { tool_use_id?: unknown }).tool_use_id === id,
    )
    if (hit) return hit as { is_error?: unknown; content?: unknown }
  }
  return undefined
}

export const resultText = (block: { content?: unknown }): string =>
  typeof block.content === 'string' ? block.content
  : Array.isArray(block.content) ? block.content.map(b => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join(' ')
  : ''

/** The result of call `id` is (or isn't) an error and, when `holds` is given, its text holds it. */
export const resultIs = (id: string, wantError: boolean, holds?: string) => (r: MessagesRequest): true | string => {
  const m = isMainLoop(r)
  if (m !== true) return m
  const b = resultBlock(r, id)
  if (!b) return `no result for ${id}`
  if ((b.is_error === true) !== wantError) return `result for ${id} has is_error=${String(b.is_error)}, expected ${String(wantError)}: "${resultText(b).slice(0, 300)}"`
  if (holds !== undefined && !resultText(b).includes(holds)) return `result for ${id} doesn't hold ${holds}: "${resultText(b).slice(0, 300)}"`
  return true
}

/**
 * The real CLI 2.1.328's WebFetch result for a 403 (M1-P's sandbox run, 2026-11-26): a plain result, not an error. Found
 * anywhere in the result, its whitespace folded: on the sandbox the same words didn't match an anchored, single-spaced
 * pattern (a miss's quote is folded to one line, so the real result may break lines or start with more). A page's
 * summary never says it.
 */
const CLI_403 = 'The server returned HTTP 403 Forbidden. The response body was not retrieved.'

/**
 * The leak fetch's result is the egress's `leak` refusal: an error that says `WebFetch refused: leak` when the CLI
 * passes the egress's body through. If the CLI shows only the status, that 403 is all it can say: as an error
 * (`Request failed with status code 403`), or, as CLI 2.1.328 does, as a plain result that says the server returned
 * HTTP 403 and that the body wasn't read. With the control fetch to the same host allowed one turn earlier, the token is
 * the only difference, so a 403 there is the leak check's. Any other refusal marker, another status, or a page fails.
 */
export const refusedAsLeak = (id: string) => (r: MessagesRequest): true | string => {
  const m = isMainLoop(r)
  if (m !== true) return m
  const b = resultBlock(r, id)
  if (!b) return `no result for ${id}`
  const text = resultText(b)
  if (b.is_error !== true) return text.replace(/\s+/g, ' ').includes(CLI_403) ? true : `result for ${id} is not an error and not the CLI's 403: "${text.slice(0, 300)}"`
  if (text.includes('WebFetch refused: leak')) return true
  if (/WebFetch refused: /.test(text)) return `result for ${id} is another refusal: "${text.slice(0, 300)}"`
  if (/status code 403\b/.test(text)) return true
  return `result for ${id} is an error but not the leak refusal: "${text.slice(0, 300)}"`
}

export const LEAK_CHECK_SCENARIOS: Record<string, Scenario> = {
  'webfetch-leak': {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_leak_read', name: 'mcp__apps__order_get', input: { name: LEAK_ORDER_NAME } }], expect: isMainLoop },
      {
        content: [{ type: 'tool_use', id: 'toolu_scripted_leak_control', name: 'WebFetch', input: { url: LEAK_CONTROL_URL, prompt: FETCH_PROMPT } }],
        expect: resultIs('toolu_scripted_leak_read', false, `"${LEAK_ORDER_NAME}"`),
      },
      {
        content: [{ type: 'tool_use', id: 'toolu_scripted_leak_fetch', name: 'WebFetch', input: { url: LEAK_URL, prompt: FETCH_PROMPT } }],
        expect: resultIs('toolu_scripted_leak_control', false),
      },
      { content: [{ type: 'text', text: WEBFETCH_LEAK_REFUSED_ANSWER }], expect: refusedAsLeak('toolu_scripted_leak_fetch') },
    ],
    branches: {
      'page-summary': { match: pageSummary, turns: [{ content: [{ type: 'text', text: 'A page kept for documentation examples.' }] }] },
    },
  },
}
