// The helpers (Stage 1, N6): src/guards/agents.ts. Ways it could fail, written first:
// - a helper's list holds Agent, an `actions` tool, an `inhouse` tool that writes or asks, or WebSearch with it off;
//   or the lists aren't exactly the decided ones (a change here is a product decision);
// - `mcp__apps__*` lets in another server whose name starts with `apps` (`mcp__appsx__...`), or the bare server name;
// - a call made inside a helper runs a tool off that helper's list, or a call from an agent type that isn't ours runs;
// - the main agent starts anything but `researcher` or `analyst` (a fork, web-fetch, a built-in, none named), or starts
//   one with no helpers on the turn;
// - a `model` (or `run_in_background`, `isolation`, `name`) the agent passes reaches the engine; or a call with only
//   the kept keys is rewritten anyway; or the rewrite carries a permission decision (which would skip the rules);
// - `researcher` doesn't run on the subagent model, `analyst` doesn't inherit, a helper runs in the background, or the
//   server's words don't reach the definition as sent;
// - a deny isn't recorded before it goes back (the trace couldn't mark the call); an allowed call is.
import { fc, it } from '@fast-check/vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, vi } from 'vitest'
import type { HelperAgents } from '../../../shared/protocol/index.ts'
import {
  AGENT_CALL_KEYS,
  DENIED_AGENT_TYPES,
  HELPER_ENV,
  RESEARCHER_INHOUSE_TOOLS,
  helperDecision,
  helperDefinitions,
  helperHook,
  helperMayUse,
  helperTools,
} from '../../src/guards/agents.ts'
import { BUILT_IN_TOOLS } from '../../src/guards/lists.ts'

const AGENTS: HelperAgents = {
  researcher: { description: 'Finds facts in the brand data and on the web.', prompt: 'You research.' },
  analyst: { description: 'Works the numbers.', prompt: 'You analyse.' },
}
const helper = fc.constantFrom('researcher' as const, 'analyst' as const)
/** The `inhouse` tools (server/mcp/registry.test.ts's list) and the skill tool. */
const INHOUSE_ALL = [
  'memory_search', 'memory_save', 'memory_update', 'memory_forget', 'memory_list', 'approval_request', 'approval_get', 'approval_list',
  'approval_withdraw', 'question_ask', 'routine_create', 'routine_list', 'routine_update', 'routine_delete', 'routine_run_now',
  'history_search', 'history_read', 'notification_send', 'member_find', 'team_request_create', 'team_request_list', 'skill_save',
]
/** Tool names a call could carry: the built-ins, ours, other servers', look-alikes and junk. */
const toolName = fc.oneof(
  fc.constantFrom(...BUILT_IN_TOOLS, 'Task', 'NotebookEdit', 'Monitor', 'StructuredOutput', 'mcp__apps', 'mcp__apps__', 'mcp__appsx__read', 'mcp__actions__order_refund', 'mcp__actions'),
  fc.constantFrom(...INHOUSE_ALL).map((t) => `mcp__inhouse__${t}`),
  fc.stringMatching(/^[a-z_]{1,20}$/).map((t) => `mcp__apps__${t}`),
  fc.string({ maxLength: 30 }),
)
const pre = (tool: string, input: unknown, from?: { id: string; type: string }) =>
  ({
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: input,
    tool_use_id: 'u1',
    session_id: 's',
    transcript_path: '',
    cwd: '/work/a',
    ...(from ? { agent_id: from.id, agent_type: from.type } : {}),
  }) as HookInput & { hook_event_name: 'PreToolUse' }
const denied = (d: ReturnType<typeof helperDecision>) => d.hookSpecificOutput?.permissionDecision === 'deny'

describe('the helpers\' tool lists', () => {
  it('are exactly the decided ones (N6)', () => {
    expect(helperTools('researcher', false)).toEqual(['Read', 'Grep', 'Glob', 'WebFetch', 'ToolSearch', 'mcp__apps__*', 'mcp__inhouse__memory_search', 'mcp__inhouse__history_search', 'mcp__inhouse__history_read'])
    expect(helperTools('researcher', true)).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'ToolSearch', 'mcp__apps__*', 'mcp__inhouse__memory_search', 'mcp__inhouse__history_search', 'mcp__inhouse__history_read'])
    expect(helperTools('analyst', true)).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'Skill'])
    expect(helperTools('analyst', false)).toEqual(helperTools('analyst', true))
  })

  it.prop([helper, fc.boolean()])('hold no Agent, no actions tool and no inhouse tool that writes or asks; WebSearch only when on', (name, webSearch) => {
    const tools = helperTools(name, webSearch)
    expect(tools).not.toContain('Agent')
    expect(tools).not.toContain('Task')
    expect(tools.some((t) => t.startsWith('mcp__actions'))).toBe(false)
    for (const t of tools.filter((t) => t.startsWith('mcp__inhouse__'))) expect(RESEARCHER_INHOUSE_TOOLS).toContain(t.slice('mcp__inhouse__'.length))
    if (!webSearch) expect(tools).not.toContain('WebSearch')
  })

  it.prop([helper, toolName, fc.boolean()])('a tool is usable exactly when the list names it, or names its own server with __*', (name, tool, webSearch) => {
    const tools = helperTools(name, webSearch)
    const want = tools.includes(tool) || (tools.includes('mcp__apps__*') && /^mcp__apps__.+/.test(tool))
    expect(helperMayUse(name, tool, webSearch)).toBe(want)
  })
})

describe('the helper hook\'s decision', () => {
  it.prop([toolName, fc.jsonValue(), helper, fc.stringMatching(/^[a-z0-9]{1,16}$/), fc.boolean()])(
    'a call inside a helper runs only if its tool is on that helper\'s list',
    (tool, input, type, id, webSearch) => {
      const d = helperDecision(pre(tool, input, { id, type }), AGENTS, webSearch)
      expect(denied(d)).toBe(!helperMayUse(type, tool, webSearch))
      // Never a rewrite inside a helper.
      expect(d.hookSpecificOutput?.updatedInput).toBeUndefined()
    },
  )

  it.prop([toolName, fc.jsonValue(), fc.string({ maxLength: 20 }).filter((t) => t !== 'researcher' && t !== 'analyst')])(
    'a call from an agent type that isn\'t ours, or from any agent on a turn without helpers, is refused',
    (tool, input, type) => {
      expect(denied(helperDecision(pre(tool, input, { id: 'a1', type }), AGENTS, true))).toBe(true)
      expect(denied(helperDecision(pre(tool, input, { id: 'a1', type: 'researcher' }), undefined, true))).toBe(true)
    },
  )

  it.prop([toolName.filter((t) => t !== 'Agent' && t !== 'Task'), fc.jsonValue(), fc.option(fc.constant(AGENTS), { nil: undefined })])(
    'the main agent\'s other calls go on to the other guards untouched',
    (tool, input, agents) => {
      expect(helperDecision(pre(tool, input), agents, false)).toEqual({})
    },
  )

  const otherKeys = fc.dictionary(
    fc.constantFrom('model', 'run_in_background', 'isolation', 'name', 'effort', 'mode', 'team_name', 'extra'),
    fc.oneof(fc.constantFrom('opus', 'fable', 'haiku', 'worktree', 'remote'), fc.boolean()),
    { minKeys: 0, maxKeys: 4 },
  )
  it.prop([fc.constantFrom('Agent', 'Task'), helper, fc.string(), fc.string(), otherKeys])(
    'the main agent starts a helper with only description, prompt and subagent_type; a model it passes never gets through',
    (tool, type, description, prompt, extra) => {
      const input = { description, prompt, subagent_type: type, ...extra }
      const d = helperDecision(pre(tool, input), AGENTS, false)
      if (Object.keys(extra).length === 0) {
        expect(d).toEqual({})
        return
      }
      // A rewrite, never a permission decision: the allow rules (Agent(researcher), Agent(analyst)) still judge it.
      expect(d.hookSpecificOutput?.permissionDecision).toBeUndefined()
      expect(d.hookSpecificOutput?.updatedInput).toEqual({ description, prompt, subagent_type: type })
      expect(Object.keys(d.hookSpecificOutput!.updatedInput!).every((k) => (AGENT_CALL_KEYS as readonly string[]).includes(k))).toBe(true)
    },
  )

  it.prop([fc.constantFrom('Agent', 'Task'), fc.oneof(fc.constantFrom(...DENIED_AGENT_TYPES, undefined, null, 'Researcher', 'researcher ', 'statusline-setup'), fc.string()).filter((t) => t !== 'researcher' && t !== 'analyst'), otherKeys])(
    'the main agent can\'t start a fork, a built-in or anything else not ours, nor any agent without helpers',
    (tool, type, extra) => {
      const input = { description: 'd', prompt: 'p', ...(type === undefined ? {} : { subagent_type: type }), ...extra }
      expect(denied(helperDecision(pre(tool, input), AGENTS, true))).toBe(true)
      expect(denied(helperDecision(pre(tool, { description: 'd', prompt: 'p', subagent_type: 'researcher' }), undefined, true))).toBe(true)
    },
  )

  it('an Agent call whose input isn\'t an object is refused', () => {
    for (const input of [null, undefined, 'researcher', ['researcher'], 3]) expect(denied(helperDecision(pre('Agent', input), AGENTS, true))).toBe(true)
  })
})

describe('the helper hook', () => {
  it('records a refused call before the deny goes back, and nothing for one it lets go', async () => {
    const order: string[] = []
    const onDeny = vi.fn(async () => void order.push('recorded'))
    const m = helperHook(AGENTS, false, onDeny)
    expect(m.onFailure).toBe('block')
    expect(m.matcher).toBeUndefined()
    const run = (i: HookInput) => m.hooks[0]!(i, 'u1', { signal: new AbortController().signal })
    expect(await run(pre('Read', {}, { id: 'a', type: 'researcher' }))).toEqual({})
    expect(onDeny).not.toHaveBeenCalled()
    const out = await run(pre('Bash', { command: 'curl x' }, { id: 'a', type: 'researcher' })).then((o) => (order.push('returned'), o))
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'The researcher helper can\'t use Bash.' } })
    expect(order).toEqual(['recorded', 'returned'])
    // A deny that can't be recorded throws (and `onFailure: 'block'` blocks the call).
    const failing = helperHook(AGENTS, false, () => Promise.reject(new Error('the Worker has gone')))
    await expect(failing.hooks[0]!(pre('Agent', { subagent_type: 'fork' }), 'u1', { signal: new AbortController().signal })).rejects.toThrow(/the Worker has gone/)
    await expect(run({ hook_event_name: 'PostToolUse' } as never)).rejects.toThrow(/helper hook got PostToolUse/)
  })
})

describe('the definitions', () => {
  it.prop([fc.stringMatching(/^[A-Za-z0-9._:@/-]{1,128}$/), fc.boolean()])('researcher on the subagent model, analyst inherits; never in the background; the server\'s words as sent', (model, webSearch) => {
    const d = helperDefinitions(AGENTS, model, webSearch)
    expect(Object.keys(d)).toEqual(['researcher', 'analyst'])
    expect(d.researcher).toEqual({ ...AGENTS.researcher, tools: helperTools('researcher', webSearch), disallowedTools: ['Agent', 'mcp__actions'], model, background: false })
    expect(d.analyst).toEqual({ ...AGENTS.analyst, tools: helperTools('analyst', webSearch), disallowedTools: ['Agent', 'mcp__actions'], model: 'inherit', background: false })
  })
})

describe('the engine switches', () => {
  it('are the decided values (the env-vars page, read 2026-11-26)', () => {
    expect(HELPER_ENV).toEqual({
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4',
      CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
      CLAUDE_CODE_FORK_SUBAGENT: '0',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
      MCP_TOOL_TIMEOUT: '180000',
    })
  })
})
