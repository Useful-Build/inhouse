// M1-P's helper scenario (N6, N19): the main agent starts the `researcher` helper once, the helper answers from its own
// conversation (a branch; its task carries the scenario's marker), and the main agent answers with the helper's report. The
// helper's one model call reports a large, exact usage, so its spend stands out on the turn's trace and the month's
// ledger (e2e/api/helpers.spec.ts). The helper's requests are the ones whose system prompt carries the server's researcher
// words, so a helper that isn't ours never gets the report, and the main thread's last turn misses without it. A
// researcher request offered the Agent tool misses too (one layer of helpers).
import type { MessagesRequest, Scenario, ScriptedTurn } from '../index.ts'
import { HELPER_AGENTS } from '../../../server/prompt/agents.ts'

type Check = NonNullable<ScriptedTurn['expect']>

/**
 * The scenario's marker in the task the main agent gives the researcher: the helper's requests are a conversation of
 * their own, and the test build's gateway plays a request's scenario from the newest user message with a `scenario:`
 * marker (egress/gateway.ts `scenarioStart`), so without it the helper would play the default `hello`.
 */
export const HELPER_MARKER = 'scenario:helper-research'
/** The helper's one model call's usage: 100,000 input tokens on Sonnet 5.5 is $0.20 (20 cents) on the ledger. */
export const HELPER_USAGE = { input_tokens: 100_000, output_tokens: 7 }
export const HELPER_REPORT = 'Researcher report: Norda ships in 5 days; nothing else found.'
export const HELPER_ANSWER = 'From the researcher: Norda ships in 5 days.'
const CALL_ID = 'toolu_helper_research_1'

/** The first words of the researcher's prompt, which reach the engine only through `RunStart.agents`. */
const RESEARCHER_OPENING = HELPER_AGENTS.researcher.prompt.split('\n')[0]!

/**
 * A researcher's request: the server's researcher words in its system prompt (the definition's `prompt` is the helper's
 * system prompt; the runner's container probe finds its helpers the same way, `runner/image/probes/lib.ts`).
 */
const isResearcher = (r: MessagesRequest): boolean => JSON.stringify(r.system ?? '').includes(RESEARCHER_OPENING.slice(0, 60))

/** The researcher's request offers no Agent tool, so it can't start a helper of its own. */
const researcherRequest: Check = (r) =>
  (r.tools ?? []).some((t) => t.name === 'Agent' || t.name === 'Task') ? 'the helper was offered the Agent tool' : true

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
          match: isResearcher,
          turns: [{ content: [{ type: 'text', text: HELPER_REPORT }], usage: HELPER_USAGE, expect: researcherRequest }],
        },
      },
    },
  }
}
