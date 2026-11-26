// What a runner event becomes in the chat (p3-design 2 "SDK mapping" and 4.5): pure functions, no storage. An
// `assistant` message's text blocks become `part`s, its `tool_use` blocks `step`s (labels below); a subagent's own
// messages (`parent_tool_use_id` set) give steps only, never parts of the answer; `result` and every other SDK message
// type are ignored. The outcome map turns a `finished` or `failed` event into the turn's outcome.
import type { TurnFailure } from '../../../shared/contract/runs.ts'
import type { RunEventBody } from '../../../shared/protocol/index.ts'

/** A step's `toolUseId`: its tool_use block's id, when it's a string (the eval trace keys a call's kept input by it). */
export type MappedBlock = { kind: 'text'; text: string } | { kind: 'step'; label: string; tool: string; toolUseId?: string }

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
/** The tool the Agent SDK adds when a run asks for structured output (structured-outputs docs, read 2026-11-20). */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput'
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
    // The SDK's own `StructuredOutput` tool carries the run's answer (up to 256 KiB in this message), never a work row
    // or a trace step (PR 5, ask C): the value is kept once, from the terminal event, capped at 64 KiB.
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name !== STRUCTURED_OUTPUT_TOOL) {
      out.push({ kind: 'step', label: stepLabel(block.name), tool: block.name, ...(typeof block.id === 'string' ? { toolUseId: block.id } : {}) })
    }
  }
  return out
}

export type TurnOutcome =
  | { outcome: 'done' | 'interrupted' | 'stopped' }
  | { outcome: 'failed'; reason: TurnFailure }

type Terminal = Extract<RunEventBody, { type: 'finished' | 'failed' }>

/**
 * 4.5: `success` → done (interrupted when the BrandAgent asked for the interrupt); `error_max_turns` → max_turns;
 * `error_max_budget_usd` → turn_budget; `error_max_structured_output_retries` → structured_output;
 * `error_during_execution` → interrupted when we asked, else sdk_error; any other error → sdk_error. A `failed` keeps
 * its reason; `interrupted` counts only when the BrandAgent asked for it (else `unknown`), `stopped` is the stopped
 * outcome.
 */
export function outcomeOf(ev: Terminal, interruptAsked: boolean): TurnOutcome {
  if (ev.type === 'finished') {
    if (!ev.isError && ev.subtype === 'success') return { outcome: interruptAsked ? 'interrupted' : 'done' }
    if (ev.subtype === 'error_max_turns') return { outcome: 'failed', reason: 'max_turns' }
    if (ev.subtype === 'error_max_budget_usd') return { outcome: 'failed', reason: 'turn_budget' }
    // The runner maps it to `failed structured_output` (R3 #151); a `finished` that carries it means the same.
    if (ev.subtype === 'error_max_structured_output_retries') return { outcome: 'failed', reason: 'structured_output' }
    // An interrupted query ends `error_during_execution` (the SDK's abort): ours when we asked for it.
    if (interruptAsked && ev.subtype === 'error_during_execution') return { outcome: 'interrupted' }
    return { outcome: 'failed', reason: 'sdk_error' }
  }
  if (ev.reason === 'interrupted') return interruptAsked ? { outcome: 'interrupted' } : { outcome: 'failed', reason: 'unknown' }
  if (ev.reason === 'stopped') return { outcome: 'stopped' }
  return { outcome: 'failed', reason: ev.reason }
}

/**
 * A background task's life as the SDK reports it (Stage 1 M1-B, N3's progress): `task_started`, `task_progress` and
 * `task_notification` system messages. `helper`: a subagent (`local_agent`), the only kind the job's helper count
 * counts. The label is the server's own words, never the task's description (model text). Ambient tasks (the SDK says
 * hosts should leave them out of activity) and anything else map to null.
 */
export type TaskEvent =
  | { kind: 'started'; taskId: string; helper: boolean; label: string }
  | { kind: 'progress'; taskId: string; label: string }
  | { kind: 'ended'; taskId: string; label: string }

const ENDED_LABELS: Readonly<Record<string, string>> = { completed: 'A helper finished', failed: 'A helper failed', stopped: 'A helper stopped' }

export function mapTaskMessage(message: Record<string, unknown>, truncated: boolean): TaskEvent | null {
  if (truncated || message.type !== 'system' || typeof message.task_id !== 'string' || message.task_id === '') return null
  if (message.ambient === true || message.skip_transcript === true) return null
  const taskId = message.task_id
  switch (message.subtype) {
    case 'task_started': {
      const helper = message.task_type === 'local_agent' || typeof message.subagent_type === 'string'
      return { kind: 'started', taskId, helper, label: helper ? stepLabel('Agent') : 'Working in the background' }
    }
    case 'task_progress':
      return { kind: 'progress', taskId, label: typeof message.last_tool_name === 'string' ? stepLabel(message.last_tool_name) : 'Working' }
    case 'task_notification': {
      const status = typeof message.status === 'string' && Object.hasOwn(ENDED_LABELS, message.status) ? message.status : 'stopped'
      return { kind: 'ended', taskId, label: ENDED_LABELS[status] }
    }
    default: return null
  }
}
