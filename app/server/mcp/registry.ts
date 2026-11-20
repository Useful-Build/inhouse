// The `inhouse` MCP server's tool list (P3, p3-design section 10): the 20 tools of the approved tool list (agent-tools,
// approved 2026-11-14), their names, categories and the descriptions the model reads, and the six always loaded. The
// other 14 stay deferred until the agent finds them through tool search. Orchestrator only; each tool's input schema and
// handler are its owner's (W6 for memory and history; the rest answer `not_available_yet` until their phase builds them).
// The server marks an always-loaded tool with `_meta: { "anthropic/alwaysLoad": true }` in `tools/list` (the MCP docs'
// "Mark a tool to load upfront or stay deferred", https://code.claude.com/docs/en/mcp, read 2026-11-14 for the tool list).

/** The `_meta` key that keeps a tool loaded on every turn. */
export const ALWAYS_LOAD_META_KEY = 'anthropic/alwaysLoad'

export type ToolCategory = 'memory' | 'approvals' | 'questions' | 'routines' | 'history' | 'notifications' | 'inhouse_team'

export interface InhouseTool {
  /** `resource_action`, lower snake case; inside the engine `mcp__inhouse__<name>`. */
  readonly name: string
  readonly category: ToolCategory
  /** What the model reads: what it does, when to use it, when not to. Search words first. */
  readonly description: string
  /** In context on every turn (the six); the rest are found through tool search. */
  readonly alwaysLoad: boolean
  /** MCP tool annotations: reads can run in parallel; forget, delete and withdraw are destructive. */
  readonly annotations: { readonly readOnlyHint?: true; readonly destructiveHint?: true }
}

const read = { readOnlyHint: true } as const
const destructive = { destructiveHint: true } as const

export const INHOUSE_TOOLS: readonly InhouseTool[] = [
  // 1. Memory (5)
  { name: 'memory_search', category: 'memory', alwaysLoad: true, annotations: read, description: "Search what you remember about this brand and the person you're helping, by keywords. Use it when the answer could depend on saved context: suppliers, policies, people's preferences or past decisions. Returns matching facts with their scope and `memory_id`." },
  { name: 'memory_save', category: 'memory', alwaysLoad: true, annotations: {}, description: 'Save one new lasting fact, in one sentence. `scope: "brand"` for facts the whole team shares (waits for an admin\'s OK), `"person"` for one person\'s preference. Don\'t save one-off details, secrets or customer personal data. To correct a fact, use `memory_update`.' },
  { name: 'memory_update', category: 'memory', alwaysLoad: false, annotations: {}, description: 'Correct or reword a saved fact by `memory_id`. Use it instead of saving a second, conflicting fact.' },
  { name: 'memory_forget', category: 'memory', alwaysLoad: false, annotations: destructive, description: 'Delete a saved fact by `memory_id`, when a person asks or the fact is wrong or stale.' },
  { name: 'memory_list', category: 'memory', alwaysLoad: false, annotations: read, description: 'List saved facts page by page, for review or tidying. To find something specific, use `memory_search`.' },
  // 2. Approvals (4)
  { name: 'approval_request', category: 'approvals', alwaysLoad: true, annotations: {}, description: "Put a drafted action in Approvals for a person to approve. Include what it does, who it goes to, the money involved and whether it can be undone. Nothing goes out until it's approved. Returns `approval_id`." },
  { name: 'approval_get', category: 'approvals', alwaysLoad: false, annotations: read, description: 'Check one approval by `approval_id`: waiting, approved, changed, declined or sent.' },
  { name: 'approval_list', category: 'approvals', alwaysLoad: false, annotations: read, description: "List approvals, filtered by status, so you don't draft the same thing twice." },
  { name: 'approval_withdraw', category: 'approvals', alwaysLoad: false, annotations: destructive, description: "Take back a draft that's no longer needed (for example, the stock arrived), by `approval_id`, with a reason." },
  // 3. Questions (1)
  { name: 'question_ask', category: 'questions', alwaysLoad: true, annotations: {}, description: "Ask a person a question with 2 to 4 options when you can't decide alone. Works in chat and in routines: when nobody is in the chat, the question goes to Approvals and notifies them. Use it for a real choice, not to confirm an action (that's `approval_request`)." },
  // 4. Routines (5)
  { name: 'routine_create', category: 'routines', alwaysLoad: false, annotations: {}, description: 'Schedule a job that runs by itself, such as "every weekday at 06:00, check stock". Write the instruction so it works with no chat history. Set what happens to a run missed while the system was off.' },
  { name: 'routine_list', category: 'routines', alwaysLoad: false, annotations: read, description: 'List routines with their schedule, last run and result.' },
  { name: 'routine_update', category: 'routines', alwaysLoad: false, annotations: {}, description: "Change a routine's instruction or schedule, or pause and resume it, by `routine_id`." },
  { name: 'routine_delete', category: 'routines', alwaysLoad: false, annotations: destructive, description: 'Delete a routine by `routine_id` when a person asks.' },
  { name: 'routine_run_now', category: 'routines', alwaysLoad: false, annotations: {}, description: 'Run a routine once now, to test it or catch up.' },
  // 5. History (2)
  { name: 'history_search', category: 'history', alwaysLoad: true, annotations: read, description: 'Search past chats, routine runs and activity by keywords and date, such as "what did we decide about returns last month". Returns short matches with links.' },
  { name: 'history_read', category: 'history', alwaysLoad: false, annotations: read, description: 'Read one past chat or run in full, by the id `history_search` returned.' },
  // 6. Notifications (1)
  { name: 'notification_send', category: 'notifications', alwaysLoad: true, annotations: {}, description: 'Send a message to people on the brand\'s team or a Slack channel of the brand, in the app, by email or in Slack, following each person\'s settings. `format: "message"` for a short note, `"report"` for a formatted report. Never to customers.' },
  // 7. Inhouse team (2)
  { name: 'team_request_create', category: 'inhouse_team', alwaysLoad: false, annotations: {}, description: "Ask the Inhouse team (the people who run this agent) for something you can't do: connect a new tool, fix a broken connection, build a skill." },
  { name: 'team_request_list', category: 'inhouse_team', alwaysLoad: false, annotations: read, description: 'List requests to the Inhouse team and their status.' },
]
