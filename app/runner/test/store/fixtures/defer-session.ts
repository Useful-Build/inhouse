// A session for the deferral test: the real SDK and CLI, the runner's own store adapter and prompts
// (src/session/core.ts `streamingPrompt`, `resumePrompt`), the scripted model, and a PreToolUse hook on TOOL that
// defers it on the first run (DEFER=1) and lets it run on the resume. With MCP_URL, an `inhouse` MCP server over HTTP.
// Prints one JSON line per hook call and one per result.
// Env: as eager-session.ts, plus DEFER, TOOL, MCP_URL, and PLAIN ('1': a resume's `""` as the plain string, the control).
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createStoreAdapter } from '../../../src/store/adapter.ts'
import { resumePrompt, streamingPrompt } from '../../../src/session/core.ts'
import { HELPER_ENV } from '../../../src/guards/agents.ts'
;(process.report as typeof process.report & { excludeNetwork: boolean }).excludeNetwork = true

const env = process.env as Record<string, string>
const adapter = createStoreAdapter({ fetch, proxyUrl: env.STORE_URL! })
const cliEnv: Record<string, string> = { ...HELPER_ENV, MCP_CONNECTION_NONBLOCKING: '0', MCP_CONNECT_TIMEOUT_MS: '15000' }
for (const k of ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'DISABLE_AUTOUPDATER']) {
  if (env[k] !== undefined) cliEnv[k] = env[k]
}
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`)

let endInput!: () => void
const inputDone = new Promise<void>((r) => (endInput = r))
const prompt = env.PROMPT !== '' ? streamingPrompt(env.PROMPT!, inputDone) : env.PLAIN === '1' ? '' : resumePrompt(inputDone)
const q = query({
  prompt,
  options: {
    cwd: env.WORK_DIR!,
    env: cliEnv,
    model: 'claude-sonnet-5-5',
    settingSources: [],
    permissionMode: 'dontAsk',
    allowedTools: ['Read', 'mcp__inhouse'],
    ...(env.MCP_URL ? { mcpServers: { inhouse: { type: 'http' as const, url: env.MCP_URL } } } : {}),
    includePartialMessages: true,
    sessionStore: adapter.store,
    sessionStoreFlush: 'eager',
    hooks: {
      PreToolUse: [{
        matcher: env.TOOL!,
        hooks: [async (input) => {
          out({ hook: (input as { tool_use_id?: string }).tool_use_id, defer: env.DEFER === '1' })
          return env.DEFER === '1' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } } : {}
        }],
      }],
    },
    ...(env.RESUME === '1' ? { resume: env.SESSION_ID! } : { sessionId: env.SESSION_ID! }),
  },
})
for await (const m of q) {
  if (m.type === 'result') {
    // As the runner does (src/session/core.ts): the turn is over, the input ends.
    endInput()
    out({ result: m.subtype === 'success' ? m.result : m.subtype, stop: (m as { stop_reason?: unknown }).stop_reason, deferred: (m as { deferred_tool_use?: { id?: unknown } }).deferred_tool_use?.id ?? null })
  }
}
