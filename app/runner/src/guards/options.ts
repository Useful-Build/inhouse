// The options builder: the session's `query()` options with every guard on. Runs inside the session process, around
// the base options R1 builds (src/session/core.ts). Whatever the base carries, the guarded fields below are ours: a
// base that tries to set one of them is refused (thrown), never merged.
import { isIP } from 'node:net'
import { basename, join } from 'node:path'
import type { HookCallbackMatcher, HookEvent, Options } from '@anthropic-ai/claude-agent-sdk'
import type { RunConfig } from '../protocol/local.ts'
import { APPS_SERVER, mcpServerUrls } from '../session/mcp-servers.ts'
import type { QueryGuards, RunContext } from '../session/seam.ts'
import { auditHook, deniedEntry, recordToolCall } from './audit.ts'
import { ALLOWED_SKILLS, BUILT_IN_PLUGINS_OFF, BUILT_IN_TOOLS, BUNDLED_SKILLS_OFF, INHOUSE_MCP_SERVER } from './lists.ts'
import { CLI_WRAPPER, PLUGIN_DIR, RUNNER_DIR, USERS_ROOT, WORK_ROOT, userPaths, validSessionKey, type UserPaths } from './paths.ts'
import { POOL_SIZE, poolUserName } from './users.ts'
import { webFetchAllowRules, webFetchHook } from './webfetch.ts'

type Settings = Exclude<Options['settings'], string | undefined>

/** The tool the SDK adds for structured output (Agent SDK structured outputs docs, read 2026-11-20). */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput'

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
  'agents',
  // A settings key, so `settings` being ours already covers it; listed in case a base spreads it at the top level.
  'disableBundledSkills',
] as const

export class GuardConfigError extends Error {}

export type QueryGuardDeps = {
  /** The container's own addresses, denied to sandboxed commands (src/proxy/proc-net.ts's `hostAddresses`). */
  hostAddresses: () => string[]
  workRoot?: string
  usersRoot?: string
  pluginDir?: string
  /** The CLI the SDK starts (the wrapper that sets the session's process limit). */
  cliPath?: string
  auditTimeoutMs?: number
}

/** Names that always mean this container, whatever its interfaces say. */
export const LOCAL_NAMES = ['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']
/**
 * Suffixes of names that never mean the public web: the reserved local ones, the private ones RFC 6762 (appendix G)
 * lists as in common use inside networks, `.localdomain` (the default domain many resolvers and DHCP servers hand out)
 * and a cluster's service names (`*.svc`; `*.cluster.local` ends in `.local`).
 * A public-looking name that resolves to a private address is the sandbox proxy's to stop (PR B's probe).
 */
export const LOCAL_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.home.arpa', '.lan', '.intranet', '.private', '.corp', '.home', '.svc']

/**
 * A WebFetch domain must be a public DNS name, written as the URL parser writes it: never an IP literal (in any form
 * the parser reads as one, `1.2` or `0x7f.1` included), a local name or one of this container's own addresses.
 */
export function assertFetchDomain(domain: string, hostAddresses: readonly string[]): void {
  let host: string
  try {
    host = new URL(`http://${domain}/`).hostname
  } catch {
    throw new GuardConfigError(`webFetchDomains: "${domain}" is not a host name`)
  }
  if (host !== domain || host.endsWith('.')) throw new GuardConfigError(`webFetchDomains: "${domain}" must be written as "${host.replace(/\.$/, '')}"`)
  const why = fetchHostRefusal(host, hostAddresses)
  if (why !== null) throw new GuardConfigError(`webFetchDomains: "${domain}" ${why}`)
}

/**
 * Why a host (as the URL parser writes it) is never one WebFetch may reach, or null when it may: an IP literal (in any
 * form the parser reads as one), a local name, one of this container's own addresses, or a reserved label. The same
 * rule for a listed domain and, with WebFetch open to any public host, for every URL's host.
 */
export function fetchHostRefusal(host: string, hostAddresses: readonly string[]): string | null {
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare) !== 0) return 'is an IP address'
  if (!host.includes('.') || LOCAL_NAMES.includes(host) || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return 'is a local name'
  if (hostAddresses.includes(host)) return 'is this container'
  // Labels with `--` in the third and fourth places are reserved (RFC 5891), and whether the URL parser accepts an
  // invalid `xn--` one (`xn--a`) differs between Node versions, so the guard refuses them all itself rather than depend
  // on the parser. A host with non-ASCII letters (punycode) isn't reachable for now.
  if (host.split('.').some((label) => label.slice(2, 4) === '--')) return 'has a reserved label (`--` in the third and fourth places)'
  return null
}

export function createQueryGuards(deps: QueryGuardDeps): QueryGuards {
  const workRoot = deps.workRoot ?? WORK_ROOT
  const usersRoot = deps.usersRoot ?? USERS_ROOT
  const pluginDir = deps.pluginDir ?? PLUGIN_DIR
  const cliPath = deps.cliPath ?? CLI_WRAPPER
  return {
    kind: 'production',
    apply: (base, config, run) => guardedOptions(base, config, run, { ...deps, workRoot, usersRoot, pluginDir, cliPath }),
  }
}

export function guardedOptions(
  base: Options,
  config: Pick<RunConfig, 'webFetchDomains' | 'webSearch' | 'outputFormat'>,
  run: RunContext,
  deps: QueryGuardDeps & { workRoot: string; usersRoot: string; pluginDir: string; cliPath: string },
): Options {
  for (const key of GUARDED_OPTIONS) {
    if (Object.hasOwn(base, key) && (base as Record<string, unknown>)[key] !== undefined) {
      throw new GuardConfigError(`the base options set "${key}", which only the guards set`)
    }
  }
  // Structured output only as the run config asks: the base's outputFormat must be the config's, or absent with it.
  if (JSON.stringify(base.outputFormat ?? null) !== JSON.stringify(config.outputFormat ?? null)) {
    throw new GuardConfigError("the base options' outputFormat isn't the run config's")
  }
  if (!Array.isArray(base.settingSources) || base.settingSources.length !== 0) {
    throw new GuardConfigError('settingSources must be [] (no settings file is read)')
  }
  const cwd = base.cwd
  // Exactly <workRoot>/<key>: no trailing slash, no doubled one, nothing that only normalises to a session folder.
  if (typeof cwd !== 'string' || !validSessionKey(basename(cwd)) || cwd !== join(deps.workRoot, basename(cwd))) {
    throw new GuardConfigError('cwd must be a session folder under the work root')
  }
  // HOME and TMPDIR: the session user's own folders, outside the session folder (src/guards/host.ts makes them).
  let own: UserPaths
  try {
    own = userPaths(base.env?.USER, deps.usersRoot)
  } catch {
    throw new GuardConfigError('USER must be a plain user name')
  }
  const home = own.home
  if (base.env?.HOME !== home) throw new GuardConfigError("HOME must be the session user's own home")
  if (base.env?.TMPDIR !== own.tmp) throw new GuardConfigError("TMPDIR must be the session user's own temp folder")
  const servers = Object.keys(base.mcpServers ?? {})
  if (servers.some((s) => s !== INHOUSE_MCP_SERVER && s !== APPS_SERVER)) throw new GuardConfigError(`only the "${INHOUSE_MCP_SERVER}" and "${APPS_SERVER}" MCP servers are allowed`)
  // Ours are the root's proxy over http, each at its own route (`/mcp/`, `/hub/`): never a program to run, never
  // another host or route.
  for (const name of servers as (typeof INHOUSE_MCP_SERVER | typeof APPS_SERVER)[]) {
    const server = base.mcpServers![name]!
    if (server.type !== 'http') throw new GuardConfigError(`the "${name}" MCP server must be an http server`)
    const proxy = base.env?.INHOUSE_PROXY_URL
    if (!proxy || server.url !== mcpServerUrls(proxy)[name]) throw new GuardConfigError(`the "${name}" MCP server must be the proxy's own route for it`)
  }

  // WebSearch only when the run config turns it on (P8a S: the brand's `t:websearch`, off by default); absent is off.
  const builtIns = BUILT_IN_TOOLS.filter((t) => t !== 'WebSearch' || config.webSearch === true)
  const hostAddresses = deps.hostAddresses()
  // null: WebFetch to any public host (the hook refuses local, IP and own hosts per URL); a list: only those.
  const domains = config.webFetchDomains === null ? null : [...config.webFetchDomains]
  for (const d of domains ?? []) assertFetchDomain(d, hostAddresses)
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
        // Read, Glob and Grep run in-process, unsandboxed, as the session's uid: no other process's /proc entries
        // (their command lines), and none of the shared tmp folders (the session's TMPDIR is its user's own folder).
        'Read(//proc/**)',
        'Read(//tmp/**)',
        'Read(//var/tmp/**)',
        'Read(//dev/shm/**)',
        'Read(//dev/mqueue/**)',
        // Every other pool user's home and temp folder, by name: their modes are the owner's to change (a session can
        // chmod its own temp folder open), so the walls between sessions can't rest on modes alone. Its own stay
        // readable.
        ...Array.from({ length: POOL_SIZE }, (_, i) => poolUserName(i))
          .filter((u) => u !== base.env?.USER)
          .map((u) => `Read(${abs(join(deps.usersRoot, u))}/**)`),
      ],
    },
    skillOverrides: Object.fromEntries(BUNDLED_SKILLS_OFF.map((s) => [s, 'off' as const])),
    enabledPlugins: Object.fromEntries(BUILT_IN_PLUGINS_OFF.map((p) => [p, false])),
  }

  const ours: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
    PreToolUse: preToolUseHooks(domains, hostAddresses, run, deps.auditTimeoutMs),
  }
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...base.hooks }
  for (const [event, matchers] of Object.entries(ours) as [HookEvent, HookCallbackMatcher[]][]) {
    hooks[event] = [...matchers, ...(base.hooks?.[event] ?? [])]
  }

  return {
    ...base,
    // The SDK's StructuredOutput tool only with structured output asked for (outputFormat); never otherwise.
    tools: [...builtIns, ...(config.outputFormat ? [STRUCTURED_OUTPUT_TOOL] : [])],
    // Pre-approved; `dontAsk` refuses everything else. Edits only inside the session folder (the deny rules above
    // carve out .claude/ and .mcp.json, and name the home); WebFetch to the listed domains, or any (null: the hook decides).
    allowedTools: [
      ...builtIns.filter((t) => t !== 'Edit' && t !== 'Write' && t !== 'WebFetch'),
      `Edit(${abs(cwd)}/**)`,
      ...webFetchAllowRules(domains),
      `mcp__${INHOUSE_MCP_SERVER}`,
      `mcp__${APPS_SERVER}`,
      ...(config.outputFormat ? [STRUCTURED_OUTPUT_TOOL] : []),
    ],
    permissionMode: 'dontAsk',
    strictMcpConfig: true,
    settings,
    skills: [...ALLOWED_SKILLS],
    plugins: [{ type: 'local', path: deps.pluginDir, skipMcpDiscovery: true }],
    // The wrapper caps the session's processes (RLIMIT_NPROC) before it runs the SDK's CLI: a fork bomb can't starve
    // the release's kill and wipe and so quarantine the uid.
    pathToClaudeCodeExecutable: deps.cliPath,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: {
        // Bash reaches the listed WebFetch domains and nothing else; never this container or its root's ports. With
        // WebFetch open to any public host (null), Bash still reaches none: the open reach is WebFetch's alone.
        allowedDomains: domains ?? [],
        strictAllowlist: true,
        deniedDomains: [...new Set([...LOCAL_NAMES, ...hostAddresses])],
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      },
      filesystem: {
        // Out of Bash's view: every other session's folder and every other user's home and temp folder. Its own come
        // back. The temp folder is also Bash's to write: its own `$TMPDIR` is a folder in it, and the sandbox's bridge
        // sockets sit in it (hidden with the rest of the users root unless it's given back whole). The home is read
        // only, as for any sandboxed command.
        denyRead: [deps.workRoot, deps.usersRoot, '/home', RUNNER_DIR, '/root'],
        allowRead: [cwd, home, own.tmp],
        allowWrite: [own.tmp],
      },
    },
    hooks,
  }
}

/**
 * Our PreToolUse hooks, in order: the WebFetch hook (which records a 'deny' audit entry for a call it refuses, so the
 * trace can mark that call: p3-eval-observability rev 2 rec 6), then the blocking audit hook for every call.
 */
export function preToolUseHooks(domains: readonly string[] | null, hostAddresses: readonly string[], run: RunContext, auditTimeoutMs?: number): HookCallbackMatcher[] {
  return [
    webFetchHook(domains, hostAddresses, undefined, (input) => recordToolCall(run, deniedEntry(input), auditTimeoutMs)),
    auditHook(run, auditTimeoutMs),
  ]
}
