// The defer hook (Stage 1, N16): defers a `question_ask` call only when it is the main agent's only tool call in its
// turn, so the run ends waiting for the person's answer and the SDK runs the call again on the resume.
//
// M1-E landed the seam (the hook's signature, its registration in options.ts before the audit hook, the run's
// `loneToolCall` in src/session/core.ts); M2-Q fills the body. The hook waits (at most `DEFER_SEEN_WITHIN_MS`) for
// `run.loneToolCall(tool_use_id)` and defers only on true: the run loop has seen this call as the only one of its
// turn, in a model message that is complete (its `message_stop` stream event; src/session/core.ts turns stream events
// on for this and keeps them off the wire). Anything else lets the call run: beside another call, not seen in time, a
// helper's call (it never has the tool), or the deferred call run again on the resume (its message isn't streamed
// again, so it is never seen). The server's `question_ask` answers a call that wasn't deferred. The run loop's own
// one-call check after a deferral stays as the backstop.
import type { HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import type { RunContext } from '../session/seam.ts'
import { INHOUSE_MCP_SERVER } from './lists.ts'

/** The one tool the hook may defer. */
export const DEFERRED_TOOL = `mcp__${INHOUSE_MCP_SERVER}__question_ask`
/** How long the hook waits for the run loop to have seen the call before it gives up and lets it run. */
export const DEFER_SEEN_WITHIN_MS = 2_000

/** The hook's answer that ends the turn on this call (hooks page, "Defer a tool call for later", read 2026-11-26). */
export const DEFER: HookJSONOutput = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } }

/** The PreToolUse matcher for `question_ask`, blocking on failure: defers a lone main-agent call, else lets it run. */
export function deferHook(run: RunContext, withinMs = DEFER_SEEN_WITHIN_MS): HookCallbackMatcher {
  return {
    matcher: DEFERRED_TOOL,
    onFailure: 'block',
    hooks: [
      async (input: HookInput) => {
        if (input.hook_event_name !== 'PreToolUse') throw new Error(`defer hook got ${input.hook_event_name}`)
        // The matcher is the CLI's; the name is checked again so nothing else is ever deferred.
        if (input.tool_name !== DEFERRED_TOOL) return {}
        // A helper's call is never deferred: only the main agent's turn ends waiting (N16).
        if (input.agent_id !== undefined && input.agent_id !== null) return {}
        if (typeof input.tool_use_id !== 'string' || input.tool_use_id === '') return {}
        return (await run.loneToolCall(input.tool_use_id, withinMs)) ? DEFER : {}
      },
    ],
  }
}
