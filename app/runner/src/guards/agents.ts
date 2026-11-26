// The helpers (Stage 1, N6): the two subagents a turn may start, `researcher` and `analyst`, and the caps on them.
//
// The server sends each helper's words only (`RunStart.agents`); everything that decides what a helper can do lives
// here, so the server can't widen it: each helper's tool list (positive lists only), its model, and a PreToolUse hook
// that checks every call at run time, not only the lists the engine was given:
// - a call made inside a helper (the hook input carries `agent_id`) runs only if its tool is on that helper's list;
// - the main agent's Agent call starts only `researcher` or `analyst`, and keeps only `description`, `prompt` and
//   `subagent_type`: a `model` it passes would outrank the helper's definition (the subagents page's model order, read
//   2026-11-26), and `run_in_background`, `isolation`, `name` and the rest are dropped with it.
// The engine's own switches (`HELPER_ENV`, set in the session env): one layer of helpers, four at once, no built-in
// agents, no forks, nothing moved to the background. And the permission rules (options.ts): only `Agent(researcher)`
// and `Agent(analyst)` are allowed, `Agent(fork)` and the built-ins we know of are denied by name.
// Checked against the Claude Code docs (env-vars, sub-agents, permissions, hooks; read 2026-11-26) for the pinned CLI
// 2.1.328 (agent SDK 0.3.328).
import type { AgentDefinition, HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import { HELPER_NAMES, type HelperAgents, type HelperName } from '../../../shared/protocol/index.ts'
import { INHOUSE_MCP_SERVER } from './lists.ts'

/** The hub's read tools' server (`mcp__apps__<tool>`); the name is mcp-servers.ts's `APPS_SERVER`. */
const APPS = 'apps'
/** The write tools' server (`mcp__actions__<tool>`); the name is mcp-servers.ts's `ACTIONS_SERVER`. */
const ACTIONS = 'actions'

/** The Agent tool. The engine still reports it as `Task` in places (init), so both names count. */
export const AGENT_TOOL_NAMES: readonly string[] = ['Agent', 'Task']

/**
 * The engine's helper switches, the same for every run (env-vars page, read 2026-11-26). Each is a positive whole
 * number or `0`/`1` as the page says; the guards refuse a base env without exactly these values.
 */
export const HELPER_ENV = {
  // One layer of helpers: a helper gets no Agent tool, so it can't start one of its own.
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
  // Four helpers running at once; the fifth Agent call fails. Separate from the Worker gate's four model calls in flight.
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4',
  // No built-in agents (Explore, Plan, general-purpose, ...): only the ones in `agents`. An Agent call without a
  // `subagent_type` then fails rather than starting general-purpose.
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
  // Fork mode off (on by default since CLI 2.1.302): Claude can't start a fork, a copy of the whole conversation that
  // keeps the main agent's tools. `Agent(fork)` is also denied by rule (options.ts).
  CLAUDE_CODE_FORK_SUBAGENT: '0',
  // Nothing runs in the background: no `run_in_background` on Bash or Agent, and no helper, long MCP call or slow
  // command is moved there on its own, so a turn can't end with a helper still running.
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  // An MCP call still running at 2 minutes is not moved to the background (default 120000): the write tools wait inline.
  CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
  // An MCP tool call may take 3 minutes (N14: the egress waits up to 120 s for an answer, then 30 s more); this also
  // lifts the HTTP transport's own 60 s per-request limit. The proxy's own limit is 10 minutes.
  MCP_TOOL_TIMEOUT: '180000',
} as const

/** The `inhouse` tools `researcher` may use: reads only. No tool that writes or asks (`memory_save`, `skill_save`, ...). */
export const RESEARCHER_INHOUSE_TOOLS = ['memory_search', 'history_search', 'history_read'] as const

/**
 * Each helper's tools, a positive list. Neither gets `Agent`, an `actions` tool or an `inhouse` tool that writes or asks.
 * WebSearch only when the run has it on. A `mcp__<server>__*` entry is every tool of that one server.
 */
export function helperTools(name: HelperName, webSearch: boolean): string[] {
  if (name === 'researcher') {
    return [
      'Read',
      'Grep',
      'Glob',
      ...(webSearch ? ['WebSearch'] : []),
      'WebFetch',
      'ToolSearch',
      `mcp__${APPS}__*`,
      ...RESEARCHER_INHOUSE_TOOLS.map((t) => `mcp__${INHOUSE_MCP_SERVER}__${t}`),
    ]
  }
  return ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'Skill']
}

/** Whether a tool name is on a helper's list (a `mcp__<server>__*` entry takes that server's tools, never another's). */
export function helperMayUse(name: HelperName, tool: string, webSearch: boolean): boolean {
  return helperTools(name, webSearch).some((t) => (t.endsWith('__*') ? tool.startsWith(t.slice(0, -1)) && tool.length > t.length - 1 : t === tool))
}

export const isHelperName = (v: unknown): v is HelperName => typeof v === 'string' && (HELPER_NAMES as readonly string[]).includes(v)

/**
 * The engine's agent definitions for a run's helpers. `researcher` runs on `subagentModel`; `analyst` inherits the
 * turn's model. Never in the background. `disallowedTools` repeats what the lists already leave out, so a change to a
 * list can't hand a helper the Agent tool or a write tool by accident.
 */
export function helperDefinitions(agents: HelperAgents, subagentModel: string, webSearch: boolean): Record<HelperName, AgentDefinition> {
  const def = (name: HelperName, model: string): AgentDefinition => ({
    description: agents[name].description,
    prompt: agents[name].prompt,
    tools: helperTools(name, webSearch),
    disallowedTools: ['Agent', `mcp__${ACTIONS}`],
    model,
    background: false,
  })
  return { researcher: def('researcher', subagentModel), analyst: def('analyst', 'inherit') }
}

/** The Agent tool's input keys a main-agent call keeps; the rest (`model` first) are dropped. */
export const AGENT_CALL_KEYS = ['description', 'prompt', 'subagent_type'] as const

/** Agent types denied by permission rule too (options.ts): forks, and the built-ins a CLI could still offer. */
export const DENIED_AGENT_TYPES = ['fork', 'web-fetch', 'general-purpose', 'Explore', 'Plan'] as const

export const HELPER_DENY = {
  noHelpers: 'No helpers can be started on this turn.',
  notAHelper: (type: string) => `Only the researcher and analyst helpers can be started, not "${type}".`,
  unknownCaller: (type: string) => `Tool calls inside "${type}" are refused: it isn't one of our helpers.`,
  notOnList: (name: HelperName, tool: string) => `The ${name} helper can't use ${tool}.`,
} as const

type Decision = HookJSONOutput & { hookSpecificOutput?: { hookEventName: 'PreToolUse'; permissionDecision?: 'deny'; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } }
const deny = (why: string): Decision => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } })

/**
 * The decision for one PreToolUse call: `{}` lets it go on to the other guards, a deny refuses it, and `updatedInput`
 * (with no permission decision, so the permission rules still judge the call) is a main-agent Agent call cut to
 * `AGENT_CALL_KEYS`. `agents` absent: no helper exists, so no call can come from one and no Agent call is let through.
 */
export function helperDecision(input: HookInput & { hook_event_name: 'PreToolUse' }, agents: HelperAgents | undefined, webSearch: boolean): Decision {
  if (input.agent_id !== undefined) {
    const type = String(input.agent_type ?? '')
    if (agents === undefined || !isHelperName(type)) return deny(HELPER_DENY.unknownCaller(type.slice(0, 64)))
    return helperMayUse(type, input.tool_name, webSearch) ? {} : deny(HELPER_DENY.notOnList(type, input.tool_name))
  }
  if (!AGENT_TOOL_NAMES.includes(input.tool_name)) return {}
  if (agents === undefined) return deny(HELPER_DENY.noHelpers)
  const call = input.tool_input
  const given = typeof call === 'object' && call !== null && !Array.isArray(call) ? (call as Record<string, unknown>) : {}
  if (!isHelperName(given.subagent_type)) return deny(HELPER_DENY.notAHelper(String(given.subagent_type ?? '(none)').slice(0, 64)))
  if (Object.keys(given).every((k) => (AGENT_CALL_KEYS as readonly string[]).includes(k))) return {}
  const kept = Object.fromEntries(AGENT_CALL_KEYS.filter((k) => Object.hasOwn(given, k)).map((k) => [k, given[k]]))
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: kept } }
}

/**
 * The helper hook: every tool (no matcher), blocking on failure. `onDeny` records the refused call (an audit entry
 * with `decision: 'deny'`, as the WebFetch hook does) before the deny goes back.
 */
export function helperHook(agents: HelperAgents | undefined, webSearch: boolean, onDeny?: (input: HookInput & { hook_event_name: 'PreToolUse' }) => Promise<void>): HookCallbackMatcher {
  return {
    onFailure: 'block',
    hooks: [
      async (input: HookInput) => {
        if (input.hook_event_name !== 'PreToolUse') throw new Error(`helper hook got ${input.hook_event_name}`)
        const out = helperDecision(input, agents, webSearch)
        if (out.hookSpecificOutput?.permissionDecision === 'deny' && onDeny) await onDeny(input)
        return out
      },
    ],
  }
}
