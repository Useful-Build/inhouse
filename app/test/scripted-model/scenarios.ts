// The scripted scenarios the harness serves (app/runner/harness/). A run names its scenario; each turn answers the
// request with that many assistant messages before it. Tests that need their own script build one with
// `createScriptedModel` directly.
import type { MessagesRequest, Scenario } from './index.ts'

/** The model every harness run asks for (the harness's `RunStart`). */
export const HARNESS_MODEL = 'claude-sonnet-5-5'

/**
 * A main-loop request: the run's model and a tool list (naming `tool` when given). A side request the CLI makes on its
 * own (a title, a summary) carries no tool list, so it can't take a scripted turn by accident: it's a loud miss.
 */
const mainLoop =
  (tool?: string) =>
  (r: MessagesRequest): boolean =>
    r.model === HARNESS_MODEL && Array.isArray(r.tools) && r.tools.length > 0 && (tool === undefined || r.tools.some((t) => t.name === tool))

/** The last user message carries the result of tool call `id`. */
const resultOf = (id: string) => (r: MessagesRequest) => {
  const last = r.messages.at(-1)
  return last?.role === 'user' && JSON.stringify(last.content).includes(`"tool_use_id":"${id}"`)
}

const both =
  (...checks: ((r: MessagesRequest) => boolean)[]) =>
  (r: MessagesRequest) =>
    checks.every((c) => c(r))

export const SCENARIOS: Record<string, Scenario> = {
  /** One answer, no tools. */
  hello: { turns: [{ content: [{ type: 'text', text: 'Hello from the scripted model.' }], expect: mainLoop() }] },

  /** Writes a file into outputs/ with Bash, then answers: the files save path, under the sandbox. */
  'write-output': {
    turns: [
      {
        content: [
          { type: 'text', text: 'Writing the table.' },
          { type: 'tool_use', id: 'toolu_scripted_write', name: 'Bash', input: { command: "printf 'sku,qty\\nA1,3\\n' > outputs/table.csv", description: 'Write the table' } },
        ],
        expect: mainLoop('Bash'),
      },
      { content: [{ type: 'text', text: 'Saved outputs/table.csv.' }], expect: both(mainLoop('Bash'), resultOf('toolu_scripted_write')) },
    ],
  },

  /**
   * Asks the person with `question_ask` (deferred by the hook), then answers once resumed with `""`. Turn 1 is the
   * resumed turn: its last user message holds the call's result with the person's answer. If the CLI adds an assistant
   * message of its own on that resume (as it does after a cut turn), the resume lands on turn 2 and is a loud miss: the
   * container check confirms which.
   */
  ask: {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_ask', name: 'mcp__inhouse__question_ask', input: { question: 'Restock on Friday?' } }], expect: mainLoop('mcp__inhouse__question_ask') },
      { content: [{ type: 'text', text: 'Noted, thanks.' }], expect: both(mainLoop('mcp__inhouse__question_ask'), resultOf('toolu_scripted_ask')) },
    ],
  },
}
