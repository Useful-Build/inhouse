// The options builder: the session's `query()` options with every guard on. Runs inside the session process, around
// the base options R1 builds (src/session/core.ts). Whatever the base carries, the guarded fields below are ours: a
// base that tries to set one of them is refused (thrown), never merged.
import { basename, dirname, join } from 'node:path'
import type { HookCallbackMatcher, HookEvent, Options } from '@anthropic-ai/claude-agent-sdk'
import type { RunConfig } from '../protocol/local.ts'
import type { QueryGuards } from '../session/seam.ts'
import { auditHook, type AuditChannel } from './audit.ts'
import { ALLOWED_SKILLS, BUILT_IN_PLUGINS_OFF, BUILT_IN_TOOLS, BUNDLED_SKILLS_OFF, INHOUSE_MCP_SERVER } from './lists.ts'
import { HOME, PLUGIN_DIR, RUNNER_DIR, WORK_ROOT, validSessionKey } from './paths.ts'
import { webFetchAllowRules, webFetchHook } from './webfetch.ts'

type Settings = Exclude<Options['settings'], string | undefined>

/** Options only the guards set. A base that carries any of them is refused. */
export const GUARDED_OPTIONS = [
  'tools',
  'allowedTools',
  'disallowedTools',
  'permissionMode',
  'allowDangerouslySkipPermissions',
  'canUseTool',
  'permissionPromptToolName',
  'sandbox',
  'settings',
  'skills',
  'plugins',
  'strictMcpConfig',
  'additionalDirectories',
  'extraArgs',
  'executable',
  'executableArgs',
  'pathToClaudeCodeExecutable',
  'spawnClaudeCodeProcess',
] as const

export class GuardConfigError extends Error {}

export type QueryGuardDeps = {
  audit: AuditChannel
  /** The container's own addresses, denied to sandboxed commands (src/proxy/proc-net.ts's `hostAddresses`). */
  hostAddresses: () => string[]
  workRoot?: string
  pluginDir?: string
  auditTimeoutMs?: number
}

/** Names that always mean this container, whatever its interfaces say. */
export const LOCAL_NAMES = ['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']

export function createQueryGuards(deps: QueryGuardDeps): QueryGuards {
  const workRoot = deps.workRoot ?? WORK_ROOT
  const pluginDir = deps.pluginDir ?? PLUGIN_DIR
  return {
    kind: 'production',
    apply: (base, config) => guardedOptions(base, config, { ...deps, workRoot, pluginDir }),
  }
}

export function guardedOptions(
  base: Options,
  config: Pick<RunConfig, 'webFetchDomains'>,
  deps: QueryGuardDeps & { workRoot: string; pluginDir: string },
): Options {
  for (const key of GUARDED_OPTIONS) {
    if (Object.hasOwn(base, key) && (base as Record<string, unknown>)[key] !== undefined) {
      throw new GuardConfigError(`the base options set "${key}", which only the guards set`)
    }
  }
  if (!Array.isArray(base.settingSources) || base.settingSources.length !== 0) {
    throw new GuardConfigError('settingSources must be [] (no settings file is read)')
  }
  const cwd = base.cwd
  if (typeof cwd !== 'string' || dirname(cwd) !== deps.workRoot || !validSessionKey(basename(cwd))) {
    throw new GuardConfigError('cwd must be a session folder under the work root')
  }
  const home = join(cwd, HOME)
  if (base.env?.HOME !== home) throw new GuardConfigError("HOME must be the session folder's home")
  const servers = Object.keys(base.mcpServers ?? {})
  if (servers.some((s) => s !== INHOUSE_MCP_SERVER)) throw new GuardConfigError(`only the "${INHOUSE_MCP_SERVER}" MCP server is allowed`)

  const domains = [...config.webFetchDomains]
  // A permission rule's absolute path starts with `//`.
  const abs = (p: string) => `/${p}`
  const settings: Settings = {
    permissions: {
      deny: [
        `Edit(${abs(cwd)}/.claude)`,
        `Edit(${abs(cwd)}/.claude/**)`,
        `Edit(${abs(cwd)}/.mcp.json)`,
        `Edit(${abs(home)})`,
        `Edit(${abs(home)}/**)`,
        'Edit(//opt/**)',
        `Read(${abs(RUNNER_DIR)}/**)`,
        'Read(//root/**)',
        'Read(//home/**)',
      ],
    },
    skillOverrides: Object.fromEntries(BUNDLED_SKILLS_OFF.map((s) => [s, 'off' as const])),
    enabledPlugins: Object.fromEntries(BUILT_IN_PLUGINS_OFF.map((p) => [p, false])),
  }

  const ours: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
    PreToolUse: [webFetchHook(domains), auditHook(deps.audit, deps.auditTimeoutMs)],
  }
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...base.hooks }
  for (const [event, matchers] of Object.entries(ours) as [HookEvent, HookCallbackMatcher[]][]) {
    hooks[event] = [...matchers, ...(base.hooks?.[event] ?? [])]
  }

  return {
    ...base,
    tools: [...BUILT_IN_TOOLS],
    // Pre-approved; `dontAsk` refuses everything else. Edits only inside the session folder (the deny rules above
    // carve out .claude/, .mcp.json and the home); WebFetch only to the listed domains.
    allowedTools: [
      ...BUILT_IN_TOOLS.filter((t) => t !== 'Edit' && t !== 'Write' && t !== 'WebFetch'),
      `Edit(${abs(cwd)}/**)`,
      ...webFetchAllowRules(domains),
      `mcp__${INHOUSE_MCP_SERVER}`,
    ],
    permissionMode: 'dontAsk',
    strictMcpConfig: true,
    settings,
    skills: [...ALLOWED_SKILLS],
    plugins: [{ type: 'local', path: deps.pluginDir, skipMcpDiscovery: true }],
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: {
        // Bash reaches the listed WebFetch domains and nothing else; never this container or its root's ports.
        allowedDomains: domains,
        strictAllowlist: true,
        deniedDomains: [...new Set([...LOCAL_NAMES, ...deps.hostAddresses()])],
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      },
      filesystem: {
        denyRead: [deps.workRoot, '/home', RUNNER_DIR, '/root'],
        allowRead: [cwd],
      },
    },
    hooks,
  }
}
