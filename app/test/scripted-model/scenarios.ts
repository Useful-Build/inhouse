// The scripted scenarios the harness serves (app/runner/harness/). A run names its scenario; each turn answers the
// request with that many assistant messages before it. Tests that need their own script build one with
// `createScriptedModel` directly.
import type { Scenario } from './index.ts'

export const SCENARIOS: Record<string, Scenario> = {
  /** One answer, no tools. */
  hello: { turns: [{ content: [{ type: 'text', text: 'Hello from the scripted model.' }] }] },

  /** Writes a file into outputs/ with Bash, then answers: the files save path, under the sandbox. */
  'write-output': {
    turns: [
      {
        content: [
          { type: 'text', text: 'Writing the table.' },
          { type: 'tool_use', id: 'toolu_scripted_write', name: 'Bash', input: { command: "printf 'sku,qty\\nA1,3\\n' > outputs/table.csv", description: 'Write the table' } },
        ],
      },
      { content: [{ type: 'text', text: 'Saved outputs/table.csv.' }] },
    ],
  },

  /**
   * Asks the person with `question_ask` (deferred by the hook), then answers once resumed with `""`. Turn 1 is the
   * resumed turn: the call's result comes back with the person's answer.
   */
  ask: {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_ask', name: 'mcp__inhouse__question_ask', input: { question: 'Restock on Friday?' } }] },
      { content: [{ type: 'text', text: 'Noted, thanks.' }] },
    ],
  },
}
