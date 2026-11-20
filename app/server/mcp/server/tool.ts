// What a tool handler of the `inhouse` MCP server is (p3-design section 10): its input schema and its call. The call
// runs as the run's person only (`memberId` from the run token's grant, never from the arguments).
import type { z } from 'zod'

/** Who and what a call runs for: the run token's grant (the egress), plus this call's clock and request id. */
export interface ToolScope {
  memberId: string
  chatId: string
  runId: string
  turnId: string
  nowMs: number
  /** Stamped on the rows a write changes (`req_id`). */
  requestId: string
}

/** An MCP `CallToolResult` (2025-11-25): text the model reads, the same data as `structuredContent`, `isError` on a refusal. */
export interface ToolResult {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: true
}

export interface ToolImpl<S extends z.ZodType = z.ZodType> {
  input: S
  call(args: z.output<S>, scope: ToolScope): Promise<ToolResult>
}

/** A tool's answer: readable text first, the data after it as JSON (MCP: structured content also goes in a text block). */
export function answer(text: string, data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(data) }], structuredContent: data }
}

/** A refusal the agent can act on: what went wrong and how to fix the call. `error` is a stable code. */
export function refusal(error: string, text: string): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { error }, isError: true }
}

export const tool = <S extends z.ZodType>(t: ToolImpl<S>): ToolImpl => t as unknown as ToolImpl
