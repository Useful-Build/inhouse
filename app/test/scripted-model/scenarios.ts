// The scripted scenarios the harness serves (app/runner/harness/). A run names its scenario; each turn answers the
// request with that many assistant messages before it. Tests that need their own script build one with
// `createScriptedModel` directly.
import type { MessagesRequest, Scenario, ScriptedBranch } from './index.ts'

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

/**
 * The last user message carries the result of tool call `id`, and its `is_error` is what the scenario expects: `error: true`
 * wants a refusal, `error: false` wants a call that went through (absent counts as false). A mismatch is a loud miss, so a
 * WebFetch the egress refused can't pass as an allowed one, nor the other way round.
 */
const resultIs = (id: string, error: boolean) => (r: MessagesRequest) => {
  const last = r.messages.at(-1)
  if (last?.role !== 'user' || !Array.isArray(last.content)) return false
  const block = last.content.find((b) => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result' && (b as { tool_use_id?: unknown }).tool_use_id === id) as { is_error?: unknown } | undefined
  return block !== undefined && (block.is_error === true) === error
}

const both =
  (...checks: ((r: MessagesRequest) => boolean)[]) =>
  (r: MessagesRequest) =>
    checks.every((c) => c(r))

/** The marker the parallel scenario puts in each subagent's prompt, so its branch can find the subagent's requests. */
export const subagentMarker = (i: number) => `[inhouse-subagent-${i}]`
/** The text of a request's first user message (string content or its text blocks). */
const firstUserText = (r: MessagesRequest): string => {
  const c = r.messages.find((m) => m.role === 'user')?.content
  if (typeof c === 'string') return c
  return Array.isArray(c) ? c.map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : ''
}
export const PARALLEL_SUBAGENTS = 4

/**
 * Four subagents at once (Wasim, item 21(c): up to 4 model calls in flight per turn). The main thread's turn 0 calls
 * the Agent tool four times in one message; each subagent's own conversation is a branch, found by the marker in its
 * prompt (its first user message), and its one answer waits for `hold` (so a test can interrupt with 4 calls in
 * flight). The main thread's turn 1 needs all four results. W1's and W3's interrupt-with-4-in-flight cases replay it.
 */
export function parallelSubagents(hold?: () => Promise<void>): Scenario {
  const ids = Array.from({ length: PARALLEL_SUBAGENTS }, (_, i) => `toolu_scripted_sub_${i}`)
  const branches: Record<string, ScriptedBranch> = {}
  for (let i = 0; i < PARALLEL_SUBAGENTS; i++) {
    branches[`subagent-${i}`] = {
      match: (r) => firstUserText(r).includes(subagentMarker(i)),
      turns: [{ content: [{ type: 'text', text: `Subagent ${i} found nothing to add.` }], ...(hold ? { hold } : {}) }],
    }
  }
  return {
    turns: [
      {
        content: ids.map((id, i) => ({
          type: 'tool_use' as const,
          id,
          name: 'Agent',
          input: { description: `Check part ${i}`, prompt: `${subagentMarker(i)} Check part ${i} and report.`, subagent_type: 'general-purpose' },
        })),
        expect: mainLoop(),
      },
      { content: [{ type: 'text', text: 'All four parts checked.' }], expect: both(mainLoop(), ...ids.map(resultOf)) },
    ],
    branches,
  }
}

/** The harness's copy holds every subagent's answer until `openParallelHold()`. */
let parallelGate: { promise: Promise<void>; open: () => void } = newGate()
function newGate() {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}
/** Lets the held subagent answers of the `parallel-4` scenario go, and arms a fresh hold for the next run. */
export function openParallelHold() {
  parallelGate.open()
  parallelGate = newGate()
}

/**
 * The schema the structured scenarios answer to (the run's `outputFormat.schema`): a count and a summary, both required.
 * `structured` answers it on the first try; `structured-retries` never does, so the SDK runs out of retries.
 */
export const STRUCTURED_SCHEMA = {
  type: 'object',
  properties: { late_orders: { type: 'integer' }, summary: { type: 'string' } },
  required: ['late_orders', 'summary'],
  additionalProperties: false,
}
export const STRUCTURED_ANSWER = { late_orders: 3, summary: 'Three orders shipped late.' }
/** How many invalid answers `structured-retries` gives: more than the SDK's retries, so it gives up first. */
export const STRUCTURED_BAD_TURNS = 12

/** The pages the WebFetch scenarios ask for: a public https page, and a private address the runner hook and the egress both refuse. */
export const WEBFETCH_ALLOWED_URL = 'https://example.com/'
export const WEBFETCH_REFUSED_URL = 'https://10.0.0.1/'

/** The fact the `memory-save` scenario saves (a person's own, active at once). */
export const MEMORY_SAVE_TEXT = 'Likes the weekly stock report as a table.'

export const SCENARIOS: Record<string, Scenario> = {
  /** Answers with the SDK's StructuredOutput tool, matching STRUCTURED_SCHEMA (run it with that outputFormat). */
  structured: {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_structured', name: 'StructuredOutput', input: STRUCTURED_ANSWER }], expect: mainLoop('StructuredOutput') },
      // Should the CLI ask once more after the tool's result (the docs say the turn ends on it), a plain close.
      { content: [{ type: 'text', text: 'Done.' }], expect: both(mainLoop('StructuredOutput'), resultOf('toolu_scripted_structured')) },
    ],
  },

  /** Answers StructuredOutput with input that never matches STRUCTURED_SCHEMA: the SDK runs out of retries. */
  'structured-retries': {
    turns: Array.from({ length: STRUCTURED_BAD_TURNS }, (_, i) => ({
      content: [{ type: 'tool_use' as const, id: `toolu_scripted_bad_${i}`, name: 'StructuredOutput', input: { late_orders: 'many' } }],
      expect: mainLoop('StructuredOutput'),
    })),
  },

  /** Saves one fact for the person with memory_save, then answers: a chat turn makes a memory line through the API alone (the contract suite's forgetMemory). */
  'memory-save': {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_memory', name: 'mcp__inhouse__memory_save', input: { scope: 'person', text: MEMORY_SAVE_TEXT } }], expect: mainLoop('mcp__inhouse__memory_save') },
      { content: [{ type: 'text', text: 'Saved.' }], expect: both(mainLoop('mcp__inhouse__memory_save'), resultOf('toolu_scripted_memory')) },
    ],
  },

  /** One WebFetch to an allowed public page, then an answer: a test drives a WebFetch through the sandbox (Q2's check). */
  'webfetch-allowed': {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_fetch', name: 'WebFetch', input: { url: WEBFETCH_ALLOWED_URL, prompt: 'Summarise the page' } }], expect: mainLoop('WebFetch') },
      { content: [{ type: 'text', text: 'Read the page.' }], expect: both(mainLoop('WebFetch'), resultIs('toolu_scripted_fetch', false)) },
    ],
  },

  /** The refused twin: one WebFetch to a private address (never reachable, whatever the brand lists), then an answer. */
  'webfetch-refused': {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_fetch_refused', name: 'WebFetch', input: { url: WEBFETCH_REFUSED_URL, prompt: 'Summarise the page' } }], expect: mainLoop('WebFetch') },
      { content: [{ type: 'text', text: 'The page could not be read.' }], expect: both(mainLoop('WebFetch'), resultIs('toolu_scripted_fetch_refused', true)) },
    ],
  },

  /** Four subagents in flight at once, each answer held until `openParallelHold()`. */
  'parallel-4': parallelSubagents(() => parallelGate.promise),

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
   * Asks the person with `question_ask`, then answers its result. On fleet/agent-chat today nothing defers the call:
   * `question_ask` is still a stub (server/mcp/tools/stubs/, P5 builds it) and the runner's PreToolUse hooks only audit,
   * so the CLI gets the stub's `not_available_yet` refusal at once and turn 1 answers that result in the same run. Once
   * P5 defers the call, turn 1 becomes the resumed turn (the run resumed with `""`, the last user message holding the
   * person's answer); if the CLI adds an assistant message of its own on that resume (as it does after a cut turn), the
   * resume lands on turn 2 and is a loud miss.
   */
  ask: {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_ask', name: 'mcp__inhouse__question_ask', input: { question: 'Restock on Friday?' } }], expect: mainLoop('mcp__inhouse__question_ask') },
      { content: [{ type: 'text', text: 'Noted, thanks.' }], expect: both(mainLoop('mcp__inhouse__question_ask'), resultOf('toolu_scripted_ask')) },
    ],
  },
}
