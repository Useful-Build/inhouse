// A session process for the probes that need a variant of the guarded options (run.ts starts it as a pool user, in a
// session folder the real host prepared). It builds R1's base options and the real guards exactly as production does,
// then applies one test-only variant, here and nowhere else: the product config never sees these switches.
//
// Input: PROBE_DIRECT (JSON, below). Output: one JSON line per thing seen on stdout (init, permission asks, the result).
import type { CanUseTool, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQueryGuards } from '../../src/guards/options.ts'
import { hostAddresses } from '../../src/proxy/proc-net.ts'
import { baseOptions, cliEnv } from '../../src/session/core.ts'
import { mcpServers } from '../../src/session/mcp-servers.ts'
import type { RunConfig } from '../../src/protocol/local.ts'
import type { RunContext } from '../../src/session/seam.ts'
import { EXTRA_PLUGIN, HOME_SKILL, PROBE_MODEL } from './lib.ts'

export type DirectVariant =
  /** The guarded options as production builds them: an agent run without the root (run.ts's fallback path). */
  | 'plain'
  /** canUseTool and a stub inhouse MCP server (one tool, one resource): which of the four tools register. */
  | 'four-tools'
  /** The audit transport refuses every entry: the call must be blocked. */
  | 'audit-refused'
  /** The same, with the audit hook taken out (test-only): the call goes through, so the probe can see a leak. */
  | 'audit-hook-removed'
  /** An IP literal in allowedDomains, and the same one in deniedDomains (`deny`) or not (`allow`). */
  | 'ip-allow'
  | 'ip-deny'
  /** strictAllowlist on or off, with a canUseTool that allows (and records) every ask. */
  | 'strict-on'
  | 'strict-off'
  /** The bundled skills not turned off, built-in agents back on (test-only): a typed /code-review must then expand. */
  | 'skills-not-off'
  /** The same, and the `skills` allowlist taken out too (test-only): nothing of ours stands between /code-review and the CLI. */
  | 'skills-open'
  /**
   * Seed a user skill before query(): with the production skill guards; with both layers off (`open`); or with one
   * layer off and the other kept: `sources-open` reads user settings (`settingSources: ['user']`) with the `skills`
   * allowlist kept, `skills-open` takes the allowlist out with `settingSources: []` kept.
   */
  | 'home-skill-guarded'
  | 'home-skill-open'
  | 'home-skill-sources-open'
  | 'home-skill-skills-open'
  /** One permission rule (or one family of them) taken out of the deny list (test-only): the Read tool's other walls alone. */
  | 'tmp-rule-off'
  | 'proc-rule-off'
  | 'users-rule-off'
  /** The built-in plugins not turned off, and a plugin we don't ship added (test-only): init must list more than ours. */
  | 'plugins-not-off'

/** `mcpProxyUrl`: the origin standing in for the root's proxy (the probe egress); the server is built at its `/mcp/`. */
export type DirectInput = { variant: DirectVariant; prompt: string; webFetchDomains: string[]; ip?: string; mcpProxyUrl?: string }

const say = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`)

process.umask(0o077)
;(process.report as typeof process.report & { excludeNetwork: boolean }).excludeNetwork = true

const input = JSON.parse(process.env.PROBE_DIRECT ?? 'null') as DirectInput
const { query } = await import('@anthropic-ai/claude-agent-sdk')

const config = {
  runId: 'probe',
  chatId: 'probe',
  sessionId: crypto.randomUUID(),
  resume: false,
  prompt: input.prompt,
  model: PROBE_MODEL,
  sideModel: PROBE_MODEL,
  systemPrompt: '',
  attachments: [],
  expect: null,
  effort: 'low',
  maxTurns: 20,
  maxBudgetUsd: 1,
  webFetchDomains: input.webFetchDomains,
  fileCaps: { maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 1, allowedTypes: [] },
} satisfies RunConfig

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PROBE_DIRECT')) as NodeJS.ProcessEnv
const base = baseOptions(config, process.cwd(), cliEnv(env), new AbortController())
// The stub egress stands in for the proxy: the session's env and its `inhouse` server both point at it, built by the
// session's own mcpServers() (the guards accept a server only at the proxy's route for it). The `apps` server is left
// out: the stub serves no `/hub/`, and this probe looks at the inhouse stub's tools.
if (input.variant === 'four-tools' && input.mcpProxyUrl) {
  base.env = { ...base.env, INHOUSE_PROXY_URL: input.mcpProxyUrl }
  base.mcpServers = { inhouse: mcpServers(input.mcpProxyUrl)!.inhouse! }
}
const run: RunContext = {
  loneToolCall: async () => false,
  audit: input.variant === 'audit-refused' || input.variant === 'audit-hook-removed' ? async () => Promise.reject(new Error('probe: refused')) : async () => {},
}
const options: Options = createQueryGuards({ hostAddresses }).apply(base, config, run)

const asks: { tool: string; input: unknown }[] = []
const allowAll: CanUseTool = async (tool, toolInput) => {
  asks.push({ tool, input: toolInput })
  say({ type: 'ask', tool, input: toolInput })
  return { behavior: 'allow', updatedInput: toolInput }
}
const net = options.sandbox!.network!
switch (input.variant) {
  case 'four-tools':
    options.canUseTool = allowAll
    break
  case 'audit-hook-removed':
    // The audit hook is the one PreToolUse matcher with no `matcher` (it covers every tool).
    options.hooks = { ...options.hooks, PreToolUse: (options.hooks?.PreToolUse ?? []).filter((m) => m.matcher !== undefined) }
    break
  case 'ip-allow':
  case 'ip-deny':
    net.allowedDomains = [input.ip!]
    if (input.variant === 'ip-deny') net.deniedDomains = [...(net.deniedDomains ?? []), input.ip!]
    break
  case 'strict-on':
  case 'strict-off':
    net.strictAllowlist = input.variant === 'strict-on'
    options.permissionMode = 'default'
    options.canUseTool = allowAll
    break
  // /code-review runs as a forked skill, which needs a built-in agent: with built-in agents off (Stage 1, HELPER_ENV) it
  // ends "No agent available for forked execution" whatever the skill guards say. The control is for the skill guards
  // alone, so these test-only variants put the built-ins back (CLI 2.1.328; PR #430).
  case 'skills-not-off':
    delete (options.settings as { skillOverrides?: unknown }).skillOverrides
    options.env = { ...options.env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '0' }
    break
  case 'skills-open':
    delete (options.settings as { skillOverrides?: unknown }).skillOverrides
    delete options.skills
    options.env = { ...options.env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '0' }
    break
  case 'tmp-rule-off':
  case 'proc-rule-off':
  case 'users-rule-off': {
    const drop = { 'tmp-rule-off': 'Read(//tmp/**)', 'proc-rule-off': 'Read(//proc/**)', 'users-rule-off': 'Read(//users/' }[input.variant]
    const permissions = (options.settings as { permissions: { deny: string[] } }).permissions
    const kept = permissions.deny.filter((r) => !r.startsWith(drop))
    if (kept.length === permissions.deny.length) throw new Error(`no deny rule starts with ${drop}`)
    permissions.deny = kept
    break
  }
  case 'home-skill-guarded':
  case 'home-skill-open':
  case 'home-skill-sources-open':
  case 'home-skill-skills-open': {
    // Both runs start with the same discoverable fixture in their own HOME. The positive control changes only
    // skill discovery/filtering. In particular the sandbox stays on.
    const skill = join(env.HOME!, '.claude', 'skills', HOME_SKILL)
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), `---\nname: ${HOME_SKILL}\ndescription: A probe-only skill.\n---\nSay hello.\n`, { flag: 'wx' })
    if (input.variant === 'home-skill-open' || input.variant === 'home-skill-sources-open') options.settingSources = ['user']
    if (input.variant === 'home-skill-open' || input.variant === 'home-skill-skills-open') options.skills = 'all'
    break
  }
  case 'plugins-not-off': {
    delete (options.settings as { enabledPlugins?: unknown }).enabledPlugins
    // In the session user's own temp folder (emptied at release).
    const extra = mkdtempSync(join(tmpdir(), 'probe-plugin-'))
    mkdirSync(join(extra, '.claude-plugin'))
    writeFileSync(join(extra, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: EXTRA_PLUGIN, version: '0.0.0', description: 'Probe only' }))
    options.plugins = [...(options.plugins ?? []), { type: 'local', path: extra }]
    break
  }
}

try {
  for await (const m of query({ prompt: input.prompt, options }) as AsyncIterable<SDKMessage>) {
    if (m.type === 'system' && m.subtype === 'init') say({ type: 'init', tools: m.tools, skills: m.skills, plugins: m.plugins.map((p) => p.name), slash_commands: m.slash_commands, mcp_servers: m.mcp_servers })
    if (m.type === 'result') say({ type: 'result', subtype: m.subtype, isError: m.is_error, text: 'result' in m ? String(m.result).slice(0, 500) : '' })
  }
} catch (e) {
  say({ type: 'error', message: String(e instanceof Error ? e.message : e).slice(0, 1000) })
}
say({ type: 'asks', asks: asks.map((a) => a.tool) })
process.exit(0)
