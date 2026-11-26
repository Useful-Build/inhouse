// M1-P's helper scenario (N6, N19): the main agent starts the `researcher` helper once, the helper answers from its own
// conversation (a branch, found by the marker in its prompt), and the main agent answers with the helper's report. The
// helper's one model call reports a large, exact usage, so its spend stands out on the turn's trace and the month's
// ledger (e2e/api/helpers.spec.ts). A miss, and so no answer, if the helper isn't one of ours: its request must carry the
// server's researcher words as its system prompt and no Agent tool (one layer of helpers).
import type { MessagesRequest, Scenario, ScriptedTurn } from '../index.ts'
import { HELPER_AGENTS } from '../../../server/prompt/agents.ts'

type Check = NonNullable<ScriptedTurn['expect']>

/** The marker in the researcher's prompt, so its branch can find the helper's own requests. */
export const HELPER_MARKER = '[inhouse-helper-research]'
/** The helper's one model call's usage: 100,000 input tokens on Sonnet 5.5 is $0.20 (20 cents) on the ledger. */
export const HELPER_USAGE = { input_tokens: 100_000, output_tokens: 7 }
export const HELPER_REPORT = 'Researcher report: Norda ships in 5 days; nothing else found.'
export const HELPER_ANSWER = 'From the researcher: Norda ships in 5 days.'
const CALL_ID = 'toolu_helper_research_1'

/** The first words of the researcher's prompt, which reach the engine only through `RunStart.agents`. */
const RESEARCHER_OPENING = HELPER_AGENTS.researcher.prompt.split('\n')[0]!

/**
 * The text of the request's user messages before the first assistant message: the helper's prompt, wherever the CLI puts
 * it (it may send its own context as an earlier user message). Never a later message, so the main thread's tool result
 * that quotes the report can't match.
 */
const openingUserText = (r: MessagesRequest): string => {
  const end = r.messages.findIndex((m) => m.role === 'assistant')
  return r.messages.slice(0, end === -1 ? undefined : end).filter((m) => m.role === 'user').map((m) => {
    const c = m.content
    if (typeof c === 'string') return c
    return Array.isArray(c) ? c.map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : ''
  }).join('\n')
}

/** The helper's request: the server's researcher words as its system prompt, and no Agent tool to start a helper of its own. */
const researcherRequest: Check = (r) => {
  if (!JSON.stringify(r.system ?? '').includes(RESEARCHER_OPENING.slice(0, 60))) return "the helper's system prompt is not the server's researcher prompt"
  if ((r.tools ?? []).some((t) => t.name === 'Agent' || t.name === 'Task')) return 'the helper was offered the Agent tool'
  return true
}

/**
 * The researcher's report reached the main thread as the Agent call's result. Otherwise a miss that quotes what the result
 * said, so a helper request the branch refused (its own miss comes back as the helper's text, not as an error) shows in
 * the turn's answer instead of passing as a report.
 */
const reportReturned: Check = (r) => {
  const blocks = r.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type?: unknown; tool_use_id?: unknown; content?: unknown }[]) : []))
  const result = blocks.find((b) => typeof b === 'object' && b !== null && b.type === 'tool_result' && b.tool_use_id === CALL_ID)
  if (result === undefined) return `no result for ${CALL_ID}`
  const c = result.content
  const said = (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : '')
    .replace(/\s+/g, ' ')
  // The CLI frames a helper's report ("[Subagent hand-back] ...", every line indented), so the report's own words are at
  // the end; the miss quotes only the end, as the egress caps an error's message.
  return said.includes(HELPER_REPORT) ? true : `the helper's result is not its report; it ends: ${said.slice(-200)}`
}

export function subagentScenarios(mainLoop: (tool?: string) => Check, resultIs: (id: string, error: boolean) => Check): Record<string, Scenario> {
  return {
    /** Start with `scenario:helper-research`: one researcher, then the answer from its report. */
    'helper-research': {
      turns: [
        {
          content: [{
            type: 'tool_use', id: CALL_ID, name: 'Agent',
            input: { description: 'Check supplier lead time', prompt: `${HELPER_MARKER} How many days does Norda take to ship? Report in one line.`, subagent_type: 'researcher' },
          }],
          expect: mainLoop(),
        },
        {
          content: [{ type: 'text', text: HELPER_ANSWER }],
          expect: (r) => { const ok = resultIs(CALL_ID, false)(r); return ok === true ? reportReturned(r) : ok },
        },
      ],
      branches: {
        researcher: {
          match: (r) => openingUserText(r).includes(HELPER_MARKER),
          turns: [{ content: [{ type: 'text', text: HELPER_REPORT }], usage: HELPER_USAGE, expect: researcherRequest }],
        },
      },
    },
  }
}
