// A session for the hard-kill test: the real SDK and CLI, the runner's own store adapter, the scripted model. Bundled
// by the test (zod resolved from the runner's node_modules, the SDK external), then run in its own process group so
// the test can SIGKILL the whole group mid-turn, as a container's hard stop would.
// Env: STORE_URL (the test's store server, the proxy's stand-in), FLUSH ('eager' | 'batched'), PROMPT, SESSION_ID,
// RESUME ('1' to resume SESSION_ID from the store), WORK_DIR, and the CLI's own env (HOME, CLAUDE_CONFIG_DIR,
// ANTHROPIC_BASE_URL, ...). Prints one JSON line on stdout: the result text and the checkpoint.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createStoreAdapter } from '../../../src/store/adapter.ts'
;(process.report as typeof process.report & { excludeNetwork: boolean }).excludeNetwork = true

const env = process.env as Record<string, string>
const adapter = createStoreAdapter({ fetch, proxyUrl: env.STORE_URL! })
const cliEnv: Record<string, string> = {}
for (const k of ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'DISABLE_AUTOUPDATER']) {
  if (env[k] !== undefined) cliEnv[k] = env[k]
}

const q = query({
  prompt: env.PROMPT!,
  options: {
    cwd: env.WORK_DIR!,
    env: cliEnv,
    model: 'claude-sonnet-5-5',
    settingSources: [],
    sessionStore: adapter.store,
    sessionStoreFlush: env.FLUSH as 'eager' | 'batched',
    ...(env.RESUME === '1' ? { resume: env.SESSION_ID! } : { sessionId: env.SESSION_ID! }),
  },
})
for await (const m of q) {
  if (m.type === 'result') {
    const checkpoint = await adapter.checkpoint()
    process.stdout.write(`${JSON.stringify({ result: m.subtype === 'success' ? m.result : m.subtype, checkpoint })}\n`)
  }
}
