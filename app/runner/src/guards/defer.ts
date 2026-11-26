// The defer hook (Stage 1, N16): defers a `question_ask` call only when it is the main agent's only tool call in its
// turn, so the run ends waiting for the person's answer and the SDK runs the call again on the resume.
//
// M1-E lands the seam only: the hook's final signature, its registration (options.ts, before the audit hook) and the
// run's `loneToolCall` (src/session/core.ts). The body is a no-op that never defers, so every call goes on as today.
// M2-Q fills the body: wait (at most `DEFER_SEEN_WITHIN_MS`) for `run.loneToolCall(tool_use_id)`, and defer only on
// true. The run loop's own one-call check after a deferral stays as the backstop.
import type { HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk'
import type { RunContext } from '../session/seam.ts'
import { INHOUSE_MCP_SERVER } from './lists.ts'

/** The one tool the hook may defer. */
export const DEFERRED_TOOL = `mcp__${INHOUSE_MCP_SERVER}__question_ask`
/** How long the hook waits for the run loop to have seen the call before it gives up and lets it run. */
export const DEFER_SEEN_WITHIN_MS = 2_000

/** The PreToolUse matcher for `question_ask`, blocking on failure. Never defers yet (M2-Q). */
export function deferHook(run: RunContext): HookCallbackMatcher {
  void run
  return {
    matcher: DEFERRED_TOOL,
    onFailure: 'block',
    hooks: [
      async (input: HookInput) => {
        if (input.hook_event_name !== 'PreToolUse') throw new Error(`defer hook got ${input.hook_event_name}`)
        return {}
      },
    ],
  }
}
