// What a tool handler of the `inhouse` MCP server is (p3-design section 10): its input schema and its call. The call
// runs as the run's person only (`memberId` from the run token's grant, never from the arguments).
import type { z } from 'zod'
import type { NotifyDeps } from '../tools/notifications/deps.ts'
import type { ApprovalsWiring } from '../tools/approvals/index.ts'

/** Who and what a call runs for: the run token's grant (the egress), plus this call's clock and request id. */
export interface ToolScope {
  memberId: string
  chatId: string
  runId: string
  turnId: string
  nowMs: number
  /** Stamped on the rows a write changes (`req_id`). */
  requestId: string
  /**
   * The model's tool call this is (Stage 1 M2-Q): Claude Code's `_meta["claudecode/toolUseId"]` on `tools/call`, which
   * the CLI sets, not the model. Absent when the request carries none.
   */
  toolUseId?: string
}

/** An MCP `CallToolResult` (2025-11-25): text the model reads, the same data as `structuredContent`, `isError` on a refusal. */
export interface ToolResult {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: true
}

/** The 22 tool names of the registry (agent-tools, plus P6a's `skill_save` and M3-T's `member_find`); `tools/index.ts` checks at load that they equal the registry's. */
export const INHOUSE_TOOL_NAMES = [
  'memory_search', 'memory_save', 'memory_update', 'memory_forget', 'memory_list',
  'approval_request', 'approval_get', 'approval_list', 'approval_withdraw',
  'question_ask',
  'routine_create', 'routine_list', 'routine_update', 'routine_delete', 'routine_run_now',
  'history_search', 'history_read',
  'notification_send', 'member_find',
  'team_request_create', 'team_request_list',
  'skill_save',
] as const
export type InhouseToolName = (typeof INHOUSE_TOOL_NAMES)[number]

/** What a handler gets besides its arguments: the Worker's bindings it reads through (each area opens its own store). */
export interface ToolDeps {
  db: D1Database
  // P5 (p5-w4): notification_send's hub delivery, opaque here (B2, 2026-11-21). Absent: Slack answers slack_unavailable.
  notify?: NotifyDeps
  // Stage 1 M2-D: approval_request's wiring from the egress (the hub's accounts, N14's admission). Absent: refused.
  approvals?: ApprovalsWiring
}

/**
 * One tool's handler: its input schema (zod; `tools/list` shows it as JSON Schema, `tools/call` parses the arguments
 * with it) and its call. Each area folder exports `handlers: Partial<Record<InhouseToolName, ToolHandler>>` from its
 * `index.ts`; `tools/index.ts` composes them.
 */
export interface ToolHandler<S extends z.ZodType = z.ZodType> {
  input: S
  call(args: z.output<S>, scope: ToolScope, deps: ToolDeps): Promise<ToolResult>
}

/**
 * A tool's answer: readable text first, the data after it as JSON (MCP: structured content also goes in a text block).
 * The CLI (2.1.328) hands the model a tool's `structuredContent` in place of its text when both are given (#444's
 * re-check), so the words go in it too, as `message` (Stage 1 M2-G): what the real model reads is the server's words
 * and the data. A data field named `message` would hide them: refused loud.
 */
export function answer(text: string, data: Record<string, unknown>): ToolResult {
  if (Object.hasOwn(data, 'message')) throw new Error('tool answer: the data has its own `message`, which would hide the words')
  return { content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(data) }], structuredContent: { message: text, ...data } }
}

/** A refusal the agent can act on: what went wrong and how to fix the call. `error` is a stable code; `message` its words (as answer's). */
export function refusal(error: string, text: string): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { error, message: text }, isError: true }
}

/** Types a handler's call from its own schema, then widens it for the area's map. */
export const tool = <S extends z.ZodType>(t: ToolHandler<S>): ToolHandler => t as unknown as ToolHandler
