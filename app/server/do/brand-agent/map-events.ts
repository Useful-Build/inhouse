// What a runner event becomes in the chat (p3-design 2 "SDK mapping" and 4.5): pure functions, no storage. An
// `assistant` message's text blocks become `part`s, its `tool_use` blocks `step`s (labels below); a subagent's own
// messages (`parent_tool_use_id` set) give steps only, never parts of the answer; `result` and every other SDK message
// type are ignored. The outcome map turns a `finished` or `failed` event into the turn's outcome.
import type { TurnFailure } from '../../../shared/contract/runs.ts'
import type { RunEventBody } from '../../../shared/protocol/index.ts'

export type MappedBlock = { kind: 'text'; text: string } | { kind: 'step'; label: string; tool: string }

/** Tool names (the SDK's built-ins and the `inhouse` server's) to the work row's label. Anything else: `Using a tool`. */
export const STEP_LABELS: Readonly<Record<string, string>> = {
  WebFetch: 'Reading a web page',
  WebSearch: 'Searching the web',
  Read: 'Reading a file',
  Write: 'Writing a file',
  Edit: 'Editing a file',
  Glob: 'Looking for files',
  Grep: 'Searching files',
  Bash: 'Running a command',
  Task: 'Asking a helper',
  Agent: 'Asking a helper',
  TodoWrite: 'Planning the steps',
  ToolSearch: 'Finding a tool',
}
const MCP_PREFIX = 'mcp__inhouse__'
const MCP_LABELS: Readonly<Record<string, string>> = {
  memory_search: 'Searching memory',
  memory_list: 'Reading memory',
  memory_save: 'Saving to memory',
  memory_update: 'Updating memory',
  memory_forget: 'Forgetting a memory',
  history_search: 'Searching past chats',
  history_read: 'Reading a past chat',
}

export function stepLabel(tool: string): string {
  if (Object.hasOwn(STEP_LABELS, tool)) return STEP_LABELS[tool]
  if (tool.startsWith(MCP_PREFIX)) {
    const name = tool.slice(MCP_PREFIX.length)
    if (Object.hasOwn(MCP_LABELS, name)) return MCP_LABELS[name]
  }
  return 'Using a tool'
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The blocks of one SDK message the chat shows, in order; empty for anything that isn't an assistant message. */
export function mapSdkMessage(message: Record<string, unknown>, truncated: boolean): MappedBlock[] {
  if (truncated || message.type !== 'assistant') return []
  const inner = message.message
  if (!isRecord(inner) || !Array.isArray(inner.content)) return []
  const subagent = typeof message.parent_tool_use_id === 'string'
  const out: MappedBlock[] = []
  for (const block of inner.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '' && !subagent) out.push({ kind: 'text', text: block.text })
    if (block.type === 'tool_use' && typeof block.name === 'string') out.push({ kind: 'step', label: stepLabel(block.name), tool: block.name })
  }
  return out
}

export type TurnOutcome =
  | { outcome: 'done' | 'interrupted' | 'stopped' }
  | { outcome: 'failed'; reason: TurnFailure }

type Terminal = Extract<RunEventBody, { type: 'finished' | 'failed' }>

/**
 * 4.5: `success` → done (interrupted when the BrandAgent asked for the interrupt); `error_max_turns` → max_turns;
 * `error_max_budget_usd` → turn_budget; `error_during_execution` → interrupted when we asked, else sdk_error; any other
 * error → sdk_error. A `failed` keeps its reason; `interrupted` counts
 * only when the BrandAgent asked for it (else `unknown`), `stopped` is the stopped outcome.
 */
export function outcomeOf(ev: Terminal, interruptAsked: boolean): TurnOutcome {
  if (ev.type === 'finished') {
    if (!ev.isError && ev.subtype === 'success') return { outcome: interruptAsked ? 'interrupted' : 'done' }
    if (ev.subtype === 'error_max_turns') return { outcome: 'failed', reason: 'max_turns' }
    if (ev.subtype === 'error_max_budget_usd') return { outcome: 'failed', reason: 'turn_budget' }
    // An interrupted query ends `error_during_execution` (the SDK's abort): ours when we asked for it.
    if (interruptAsked && ev.subtype === 'error_during_execution') return { outcome: 'interrupted' }
    return { outcome: 'failed', reason: 'sdk_error' }
  }
  if (ev.reason === 'interrupted') return interruptAsked ? { outcome: 'interrupted' } : { outcome: 'failed', reason: 'unknown' }
  if (ev.reason === 'stopped') return { outcome: 'stopped' }
  // `structured_output` (R3 #151) has no TurnFailure value until PR 5 adds it: an SDK-side failure until then.
  if (ev.reason === 'structured_output') return { outcome: 'failed', reason: 'sdk_error' }
  return { outcome: 'failed', reason: ev.reason }
}
