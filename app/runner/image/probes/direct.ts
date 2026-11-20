// A session process for the probes that need a variant of the guarded options (run.ts starts it as a pool user, in a
// session folder the real host prepared). It builds R1's base options and the real guards exactly as production does,
// then applies one test-only variant, here and nowhere else: the product config never sees these switches.
//
// Input: PROBE_DIRECT (JSON, below). Output: one JSON line per thing seen on stdout (init, permission asks, the result).
import type { CanUseTool, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { createQueryGuards } from '../../src/guards/options.ts'
import { hostAddresses } from '../../src/proxy/proc-net.ts'
import { baseOptions, cliEnv } from '../../src/session/core.ts'
import type { RunConfig } from '../../src/protocol/local.ts'
import type { RunContext } from '../../src/session/seam.ts'
import { PROBE_MODEL } from './lib.ts'

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
  /** The bundled skills not turned off (test-only): a typed /code-review must then expand. */
  | 'skills-not-off'

export type DirectInput = { variant: DirectVariant; prompt: string; webFetchDomains: string[]; ip?: string; mcpUrl?: string }

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
  effort: 'low',
  maxTurns: 8,
  maxBudgetUsd: 1,
  webFetchDomains: input.webFetchDomains,
  fileCaps: { maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 1, allowedTypes: [] },
} satisfies RunConfig

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PROBE_DIRECT')) as NodeJS.ProcessEnv
const base = baseOptions(config, process.cwd(), cliEnv(env), new AbortController())
if (input.variant === 'four-tools' && input.mcpUrl) base.mcpServers = { inhouse: { type: 'http', url: input.mcpUrl } }
const run: RunContext = {
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
  case 'skills-not-off':
    delete (options.settings as { skillOverrides?: unknown }).skillOverrides
    break
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
