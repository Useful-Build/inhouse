// The scripted scenarios the harness serves (app/runner/harness/). A run names its scenario; each turn answers the
// request with that many assistant messages before it. Tests that need their own script build one with
// `createScriptedModel` directly.
import type { MessagesRequest, Scenario, ScriptedBranch, ScriptedTurn } from './index.ts'
import { BUILT_IN_TOOLS, INHOUSE_MCP_SERVER } from '../../runner/src/guards/lists.ts'

/** The model every harness run asks for (the harness's `RunStart`). */
export const HARNESS_MODEL = 'claude-sonnet-5-5'

/** A turn's check: `true`, or why the request isn't the one the turn answers (the miss names it). */
type Check = (r: MessagesRequest) => true | string

/**
 * A main-loop request: the run's model and a tool list (offering `tool` when given). A side request the CLI makes on its
 * own (a title, a summary) carries no tool list, so it can't take a scripted turn by accident: it's a loud miss.
 */
export const mainLoop =
  (tool?: string): Check =>
  (r) => {
    if (r.model !== HARNESS_MODEL) return `model ${String(r.model)}, not ${HARNESS_MODEL}`
    if (!Array.isArray(r.tools) || r.tools.length === 0) return 'no tool list (a side request)'
    return tool === undefined || offers(r, tool) ? true : `the tool list doesn't offer ${tool}`
  }

/**
 * The request offers `tool`: listed, or left out because the CLI defers it. With deferred tool loading on, the real CLI
 * lists only the tools it loads up front plus a `defer_loading` placeholder (fixtures/cli-requests.json); the rest
 * (WebFetch, WebSearch, the Task tools, most `mcp__inhouse__*`) come only after a ToolSearch, yet a call to one still
 * runs. Matching only listed tools made a tool scenario's turn 0 miss until the CLI's 400 step-down inlined every tool.
 * The placeholder stands in only for a tool the runner gives the agent (its BUILT_IN_TOOLS or our MCP server's); a tool
 * taken off that allowlist is caught by runner/test/guards/lists.test.ts, which pins the list.
 */
const offers = (r: MessagesRequest, tool: string): boolean =>
  Array.isArray(r.tools) && r.tools.some((t) => t.name === tool || (t.defer_loading === true && deferrable(tool)))

const deferrable = (tool: string): boolean => (BUILT_IN_TOOLS as readonly string[]).includes(tool) || tool.startsWith(`mcp__${INHOUSE_MCP_SERVER}__`)

/** What the last message is, for a miss's reason. */
const lastShape = (r: MessagesRequest): string => {
  const last = r.messages.at(-1)
  if (!last) return 'no messages'
  const blocks = Array.isArray(last.content) ? last.content.map((b) => String((b as { type?: unknown })?.type)).join('+') : typeof last.content
  return `the last message is ${last.role} (${blocks})`
}

/** A message that only adds text after a tool's result: a `system` message, or a user message of text alone. */
const textOnly = (m: MessagesRequest['messages'][number]): boolean =>
  m.role === 'system' ||
  (m.role === 'user' && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.every((b) => (b as { type?: unknown })?.type === 'text'))))

/**
 * The tool_result block for call `id` in the newest message that carries tool results, looking back past trailing
 * text-only messages and never past the last assistant message. The real CLI can end a turn-1 request with a `system`
 * message after the result: the budget line ("USD budget: $… remaining") whenever the run sets `maxBudgetUsd`, as every
 * runner run does (fixtures/cli-requests.json, `write-output.turn1-budget`).
 */
const resultBlock = (r: MessagesRequest, id: string): { is_error?: unknown; content?: unknown } | undefined => {
  for (let i = r.messages.length - 1; i >= 0; i--) {
    const m = r.messages[i]!
    if (textOnly(m)) continue
    if (m.role !== 'user' || !Array.isArray(m.content)) return undefined
    return m.content.find((b) => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result' && (b as { tool_use_id?: unknown }).tool_use_id === id) as { is_error?: unknown; content?: unknown } | undefined
  }
  return undefined
}

/** The newest tool-result message (past trailing text-only messages) carries the result of tool call `id`. */
export const resultOf =
  (id: string): Check =>
  (r) =>
    resultBlock(r, id) !== undefined ? true : `no result for ${id}: ${lastShape(r)}`

/**
 * The newest tool-result message carries the result of tool call `id`, and its `is_error` is what the scenario expects: `error: true`
 * wants a refusal, `error: false` wants a call that went through (absent counts as false). A mismatch is a loud miss, so a
 * WebFetch the egress refused can't pass as an allowed one, nor the other way round.
 */
const resultIs =
  (id: string, error: boolean): Check =>
  (r) => {
    const block = resultBlock(r, id)
    if (block === undefined) return `no result for ${id}: ${lastShape(r)}`
    if ((block.is_error === true) === error) return true
    // What the result says (capped): a tool that failed on its own model call (WebFetch's page summary) carries that
    // call's own miss here, so the agent's visible error names it too. Scripted test data only.
    const said = resultText(block).replace(/\s+/g, ' ').slice(0, RESULT_EXCERPT_MAX)
    return `the result for ${id} has is_error ${block.is_error === true}, not ${error}; it says: "${said}"`
  }

/** How much of a mismatched result's text a miss quotes. */
export const RESULT_EXCERPT_MAX = 400

/** A tool_result's text: its string content, or its text blocks joined. */
const resultText = (block: { content?: unknown }): string =>
  typeof block.content === 'string' ? block.content
  : Array.isArray(block.content) ? block.content.map((b) => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join(' ')
  : ''

const both =
  (...checks: Check[]): Check =>
  (r) => {
    for (const c of checks) {
      const ok = c(r)
      if (ok !== true) return ok
    }
    return true
  }

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
/**
 * The allowed WebFetch's prompt; its marker brings WebFetch's own side request (the page summary) to the scenario. The
 * routing relies on the CLI echoing the prompt into that request; a fetched page that itself held `scenario:<other>`
 * would reroute it (example.com doesn't).
 */
const WEBFETCH_PROMPT = 'Summarise the page (scenario:webfetch-allowed)'
/** WebFetch's side request: no tools, and its one user message is the fetched page followed by the call's prompt. */
const pageSummary = (r: MessagesRequest): boolean =>
  Array.isArray(r.tools) && r.tools.length === 0 && r.messages.length === 1 && firstUserText(r).includes('Web page content:') && firstUserText(r).includes(WEBFETCH_PROMPT)

/** The fact the `memory-save-team` scenario saves (the team's, waiting for an admin). */
export const MEMORY_SAVE_TEAM_TEXT = 'We restock on Fridays.'

/**
 * Looks one fact up with memory_search and answers from what came back, so a test sees what the session actually received:
 * the answer says the fact (`From memory: <fact>`) only when the search result holds it, else `Nothing saved matches that.`
 * The two answers are two branches, picked by the result's content, so the scenario never says a fact it wasn't given.
 */
export const MEMORY_RECALL_NONE = 'Nothing saved matches that.'
export const memoryRecallAnswer = (fact: string): string => `From memory: ${fact}`
function memoryRecall(id: string, query: string, fact: string): Scenario {
  const ask = mainLoop('mcp__inhouse__memory_search')
  const answered = (found: boolean) => (r: MessagesRequest) => {
    const block = resultBlock(r, id)
    return block !== undefined && resultText(block).includes(fact) === found
  }
  const reply = (text: string): ScriptedTurn => ({ content: [{ type: 'text', text }], expect: both(ask, resultOf(id)) })
  return {
    turns: [{ content: [{ type: 'tool_use', id, name: 'mcp__inhouse__memory_search', input: { query } }], expect: ask }],
    branches: {
      found: { match: answered(true), turns: [null, reply(memoryRecallAnswer(fact))] },
      none: { match: answered(false), turns: [null, reply(MEMORY_RECALL_NONE)] },
    },
  }
}

/** How long the `slow-bash` scenario's one Bash call sleeps: long enough to act on the live turn, short enough to end on its own. */
export const SLOW_BASH_SECONDS = 20

/** The fact the `memory-save` scenario saves (a person's own, active at once). */
export const MEMORY_SAVE_TEXT = 'Likes the weekly stock report as a table.'

/** What the `routine-create` scenario sends and says (the refusal text is `server/mcp/tools/routines/index.ts`'s `STAGE_TEXT`, written out here so a change to it fails loudly). */
export const ROUTINE_STAGE_TEXT = 'Routines you set up need the Act stage. Ask an admin to move to Act.'
export const ROUTINE_CREATE_INPUT = { name: 'Stock check', instruction: 'scenario:hello Check stock and say what is low.', days: 'daily', time: '06:00' }
export const ROUTINE_REFUSED_ANSWER = 'The routine was refused.'
export const ROUTINE_CREATED_ANSWER = 'The routine was created.'
/** The `hub-write-refused` scenario's document and answers. */
export const HUB_MUTATION_DOCUMENT = 'mutation { orderCancel(orderId: "1") { job { id } } }'
export const HUB_WRITE_REFUSED_ANSWER = 'The hub refused the write: write_refused.'
export const HUB_WRITE_NOT_REFUSED_ANSWER = 'The hub did not refuse the write.'
/** The `morning-check` scenario's result: one item, every field the schema asks for. */
export const MORNING_CHECK_ANSWER = {
  coverage: 'complete',
  gaps: [],
  items: [
    {
      key: 'late-orders', sev: '#b97a14', area: 'Orders', title: 'Orders waiting to ship', sub: 'Unfulfilled for more than 3 days',
      cost: { minor: 13681, currency: 'USD' }, costNote: 'Value of the orders waiting', next: 'Ship the oldest orders today',
      found: [['Orders', '1']], sources: [{ n: '#1001', text: 'Lite Trekking Poles, unfulfilled' }], since: null,
    },
  ],
}

/** The `late-orders` scenario's answer (the P4 ship spec's S3): a table of at most LATE_ORDERS_BOUND rows, then the sources it read. */
export const LATE_ORDERS_BOUND = 3
export const LATE_ORDERS_ORDERS = ['#1001', '#1002', '#1003']
export const LATE_ORDERS_SOURCES = 'Sources: Shopify orders, the 3 oldest unfulfilled.'
export const LATE_ORDERS_TEXT = [
  'These orders are late (the 3 oldest, not all of them):',
  '',
  '| Order | Waiting | Why |',
  '| --- | --- | --- |',
  ...LATE_ORDERS_ORDERS.map((o, i) => `| ${o} | ${i + 4} days | Unfulfilled |`),
  '',
  LATE_ORDERS_SOURCES,
].join('\n')

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

  /** Searches memory for the weekly stock report preference and says what it found (the ship spec's S7: a new chat uses the saved fact). */
  'memory-recall': memoryRecall('toolu_scripted_recall', 'weekly stock report', MEMORY_SAVE_TEXT),

  /** The same for the team's Friday restock fact: it waits for an admin, so a search can't find it and the answer says nothing is saved. */
  'memory-recall-team': memoryRecall('toolu_scripted_recall_team', 'restock Fridays', MEMORY_SAVE_TEAM_TEXT),

  /** Saves one fact for the whole team: it waits for an admin's OK, so no page lists it yet (the ship spec's S7). */
  'memory-save-team': {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_memory_team', name: 'mcp__inhouse__memory_save', input: { scope: 'brand', text: MEMORY_SAVE_TEAM_TEXT } }], expect: mainLoop('mcp__inhouse__memory_save') },
      { content: [{ type: 'text', text: 'Saved for the team.' }], expect: both(mainLoop('mcp__inhouse__memory_save'), resultOf('toolu_scripted_memory_team')) },
    ],
  },

  /**
   * One WebFetch to an allowed public page, then an answer: a test drives a WebFetch through the sandbox (Q2's check).
   * WebFetch hands the page to the side model in a request of its own (no tools, the page and this prompt as its one user
   * message); the marker in the prompt brings that request here, where the `page-summary` branch answers it. Without
   * an answer the fetch comes back as an error and turn 1's `is_error: false` check misses.
   */
  'webfetch-allowed': {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_fetch', name: 'WebFetch', input: { url: WEBFETCH_ALLOWED_URL, prompt: WEBFETCH_PROMPT } }], expect: mainLoop('WebFetch') },
      { content: [{ type: 'text', text: 'Read the page.' }], expect: both(mainLoop('WebFetch'), resultIs('toolu_scripted_fetch', false)) },
    ],
    branches: {
      'page-summary': { match: pageSummary, turns: [{ content: [{ type: 'text', text: 'A page kept for documentation examples.' }] }] },
    },
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
   * Keeps a turn live: one Bash call that sleeps SLOW_BASH_SECONDS in the sandbox, then an answer. A test acts on the live
   * turn meanwhile (pause, interrupt, stop). The same request shapes as `write-output` (text plus one Bash call, then its
   * result): only the command differs. The sleep is bounded, so a turn nobody ends still finishes on its own.
   */
  'slow-bash': {
    turns: [
      {
        content: [
          { type: 'text', text: 'Waiting a while.' },
          { type: 'tool_use', id: 'toolu_scripted_slow', name: 'Bash', input: { command: `sleep ${SLOW_BASH_SECONDS} && echo waited`, description: 'Wait a while' } },
        ],
        expect: mainLoop('Bash'),
      },
      { content: [{ type: 'text', text: 'Done waiting.' }], expect: both(mainLoop('Bash'), resultOf('toolu_scripted_slow')) },
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

  // ---------- P4 W6 (the Watch API specs, e2e/api/{routines,hub}.spec.ts). Scenarios only. ----------

  /**
   * One `routine_create` call, then an answer that says which way it went (picked by the result's text, so the scenario never
   * says what it wasn't told): at Watch the call is refused with STAGE_TEXT, at Act it creates the routine.
   */
  'routine-create': scriptedBranchesOnResult(
    { id: 'toolu_scripted_routine_create', name: 'mcp__inhouse__routine_create', input: ROUTINE_CREATE_INPUT },
    ROUTINE_STAGE_TEXT,
    ROUTINE_REFUSED_ANSWER,
    ROUTINE_CREATED_ANSWER,
  ),

  /**
   * One read-only hub tool call with a GraphQL mutation document (`fixture_query`): the hub answers `write_refused` before any
   * upstream call, and the answer says whether the result held that code. The hub tools aren't listed up front (tool search),
   * so the turn checks only the main loop, not an offered tool.
   */
  'hub-write-refused': scriptedBranchesOnResult(
    { id: 'toolu_scripted_hub_write', name: 'mcp__apps__fixture_query', input: { document: HUB_MUTATION_DOCUMENT } },
    'write_refused',
    HUB_WRITE_REFUSED_ANSWER,
    HUB_WRITE_NOT_REFUSED_ANSWER,
  ),

  /** One bounded read of the orders through the hub, then a table of the late ones with its sources (the P4 ship spec's S3). */
  'late-orders': {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_late_read', name: 'mcp__apps__orders_search', input: { first: LATE_ORDERS_BOUND } }], expect: mainLoop() },
      { content: [{ type: 'text', text: LATE_ORDERS_TEXT }], expect: both(mainLoop(), resultOf('toolu_scripted_late_read')) },
    ],
  },

  /** Prints the runner's environment into a file the spec reads back through the Library (`outputs/env.txt`), then answers. */
  'env-to-file': {
    turns: [
      {
        content: [
          { type: 'text', text: 'Writing the environment.' },
          { type: 'tool_use', id: 'toolu_scripted_env', name: 'Bash', input: { command: 'env > outputs/env.txt', description: 'Write the environment' } },
        ],
        expect: mainLoop('Bash'),
      },
      { content: [{ type: 'text', text: 'Saved outputs/env.txt.' }], expect: both(mainLoop('Bash'), resultOf('toolu_scripted_env')) },
    ],
  },

  /**
   * The morning check's run on the recorded upstream: one read through the hub (orders), then the structured result with one
   * item (valid against `MorningCheckResultSchema`), so Today fills. The routine's prompt carries no `scenario:` marker, so
   * the orchestrator's test build names this scenario for the system routine (p4-w6 PR body, "Needs from the orchestrator").
   */
  'morning-check': {
    turns: [
      { content: [{ type: 'tool_use', id: 'toolu_scripted_mc_read', name: 'mcp__apps__orders_search', input: { first: 5 } }], expect: mainLoop() },
      { content: [{ type: 'tool_use', id: 'toolu_scripted_mc_result', name: 'StructuredOutput', input: MORNING_CHECK_ANSWER }], expect: both(mainLoop(), resultOf('toolu_scripted_mc_read')) },
      { content: [{ type: 'text', text: 'Done.' }], expect: both(mainLoop('StructuredOutput'), resultOf('toolu_scripted_mc_result')) },
    ],
  },
}

/**
 * One tool call, then one of two answers picked by whether the call's result text holds `needle`: a branch each, the way
 * `memoryRecall` does it, so the scenario never reports something the result didn't say.
 */
function scriptedBranchesOnResult(call: { id: string; name: string; input: Record<string, unknown> }, needle: string, hit: string, miss: string): Scenario {
  const loop = mainLoop()
  const said = (yes: boolean) => (r: MessagesRequest) => {
    const block = resultBlock(r, call.id)
    return block !== undefined && resultText(block).includes(needle) === yes
  }
  // The answer that says "refused" also needs the result flagged as an error, and the other needs it not to be one.
  const reply = (text: string, error: boolean): ScriptedTurn => ({ content: [{ type: 'text', text }], expect: both(loop, resultIs(call.id, error)) })
  return {
    turns: [{ content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }], expect: loop }],
    branches: {
      hit: { match: said(true), turns: [null, reply(hit, true)] },
      miss: { match: said(false), turns: [null, reply(miss, false)] },
    },
  }
}
