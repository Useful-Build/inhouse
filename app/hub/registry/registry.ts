// The tool registry. buildRegistry runs once per isolate over connectors/index.ts (and, in the test build only, the
// fixture connector) and throws at startup on any malformed module: loud, never half open. listTools and callTool are
// the ReadGateway's logic, kept here as plain functions so the Node project tests them without workerd.
import { z } from 'zod'
import type { CallerScope, HubResult, ToolInfo } from '../index/contract'
import { ACCOUNT_ID } from '../index/schemas'
import { err, isHubErrorCode, ok } from '../index/errors'

export type ShopifyReadClient = {
  graphql(document: string, variables?: Record<string, unknown>, apiVersion?: string): Promise<HubResult<{ data: unknown }>>
}

/** A text part of an MCP tool result. Other part types are dropped at the proxy and counted in its log line. */
export type McpToolResult = { content: { type: 'text'; text: string }[] }

/** An `oauth_mcp` account's proxy (P5 W1), built over its SignIn's `mcpCall`. Tool code never sees a token. */
export type McpClient = { call(upstream: string, args: Record<string, unknown>): Promise<HubResult<McpToolResult>> }

/** `mcp` is set for `oauth_mcp` tools by the ready gateway (P5 W1); H0's Shopify tools never read it. */
export type ToolContext = { shopify: ShopifyReadClient; scope: CallerScope; nowMs: number; mcp?: McpClient }

export type ToolDef<I> = {
  name: string
  description: string
  mode: 'read'
  input: z.ZodType<I>
  run(ctx: ToolContext, input: I): Promise<HubResult<unknown>>
}

/** H0's connector kind (client credentials). `kind` may be left out: it defaults to `client_credentials`. */
export type ConnectorModule = {
  kind?: 'client_credentials'
  id: string
  accountId: string
  apiVersion?: string
  scopes: { read: readonly string[]; required: readonly string[] }
  tools: readonly ToolDef<any>[]
}

// ---------- P5 (p5-w1): connectors that publish an official MCP server, reached through OAuth ----------

/** One reviewed allowlist entry. The hub's description and input, never the upstream's. */
export type McpToolEntry = {
  /** The hub's name, resource_action, unique across connectors. */
  name: string
  /** The server's tool name. */
  upstream: string
  description: string
  /** A strict z.object; it may narrow the upstream schema. */
  input: z.ZodType<Record<string, unknown>>
  /** Arguments the hub sets and the model can't: merged over the parsed input. */
  fixed?: Readonly<Record<string, unknown>>
  /** A policy that must be on for the tool to be listed or called. */
  policy?: string
  /** At most H0's 32 KiB. */
  maxResultBytes?: number
}

/** Per-deployment client settings, read from the hub's env by the connector. Null: the connector isn't configured. */
export type McpClientConfig = {
  /** Pre-registered clients; null for a dynamic client (its registration lives sealed in the SignIn record). */
  clientId: string | null
  clientSecret: string | null
  /** CONNECT_REDIRECT_URI. The hub never takes a redirect URI from a caller. */
  redirectUri: string
  /** Slack's workspace pin (`team`), checked at the callback. */
  teamId: string | null
  /** The policies turned on for this deployment (Slack: `privateSearch`). */
  policies: readonly string[]
}

export type McpConnectorModule = {
  kind: 'oauth_mcp'
  id: string
  accountId: string
  /** How token answers are parsed: Slack's (`ok`, comma scopes, `team.id`) or RFC 6749 JSON. */
  profile: 'slack' | 'generic'
  mcp: {
    /** The URL JSON-RPC is POSTed to. */
    endpoint: string
    /** The RFC 8707 value sent in both OAuth requests and compared with PRM's `resource`. */
    resource: string
    /** Default true; false only when the live check shows the AS refuses the parameter (recorded with the date). */
    sendResource?: boolean
    /** Exact hosts the hub may call for this connector. */
    allowedHosts: readonly string[]
  }
  client: 'preregistered' | 'dynamic'
  /** Pre-registered only: pinned endpoints the nightly compares with live discovery. */
  endpoints?: { authorization: string; token: string; revoke: string | null }
  scopes: { base: readonly string[]; policy: Readonly<Record<string, readonly string[]>> }
  tools: readonly McpToolEntry[]
  /** Upstream tools known to be writes: `callTool` on one answers write_refused. */
  knownWrites: readonly string[]
  configure(env: Readonly<Record<string, unknown>>): McpClientConfig | null
}

/** Every module the registry takes. */
export type HubConnector = ConnectorModule | McpConnectorModule

export const isMcpConnector = (c: HubConnector): c is McpConnectorModule => c.kind === 'oauth_mcp'

/** Scope handles as Slack writes them: `channels:history`, `search:read.public`. */
export const MCP_SCOPE = /^[a-z]+(?:[:.][a-z.]+)+$/

/** `scopes.base` plus every enabled policy's extras, sorted and unique. */
export function requestedScopes(connector: McpConnectorModule, config: McpClientConfig): string[] {
  const out = new Set(connector.scopes.base)
  for (const p of config.policies) for (const s of connector.scopes.policy[p] ?? []) out.add(s)
  return [...out].sort()
}

export const sameScopeSet = (a: readonly string[], b: readonly string[]): boolean => {
  const x = new Set(a)
  const y = new Set(b)
  return x.size === y.size && [...x].every(s => y.has(s))
}

export type RegisteredTool = {
  name: string
  description: string
  /** Read from the module at runtime. buildRegistry admits only 'read'; the gateway checks again (P6 adds modes). */
  mode: string
  input: z.ZodType<unknown>
  inputSchema: Record<string, unknown>
  run(ctx: ToolContext, input: unknown): Promise<HubResult<unknown>>
  connector: HubConnector
  /** The policy that must be on (oauth_mcp tools only). */
  policy?: string
}

export type Registry = {
  tools: ReadonlyMap<string, RegisteredTool>
  modules: readonly HubConnector[]
  /** Hub names and upstream names of every oauth_mcp connector's known writes (P5 W1). */
  knownWrites?: ReadonlySet<string>
}

export const TOOL_NAME = /^[a-z]+(?:_[a-z]+)+$/
export const READ_SCOPE = /^read_[a-z_]+$/
export const MAX_DESCRIPTION = 1024
export const MAX_RESULT_BYTES = 32 * 1024

function isStrictObject(schema: unknown): boolean {
  if (!(schema instanceof z.ZodObject)) return false
  const catchall = (schema as z.ZodObject)._zod.def.catchall
  return catchall !== undefined && catchall._zod.def.type === 'never'
}

export function buildRegistry(modules: readonly HubConnector[]): Registry {
  const tools = new Map<string, RegisteredTool>()
  const scopesByAccount = new Map<string, string>()
  const knownWrites = new Set<string>()
  for (const m of modules) {
    if (m.kind === 'oauth_mcp') {
      checkMcpModule(m, tools, scopesByAccount, knownWrites)
      continue
    }
    if (typeof m.id !== 'string' || !ACCOUNT_ID.test(m.id)) throw new Error(`hub registry: bad connector id "${String(m.id)}"`)
    if (typeof m.accountId !== 'string' || !ACCOUNT_ID.test(m.accountId)) throw new Error(`hub registry: bad account id in connector "${m.id}"`)
    const read = [...(m.scopes?.read ?? [])]
    const required = [...(m.scopes?.required ?? [])]
    for (const s of [...read, ...required]) {
      if (typeof s !== 'string' || !READ_SCOPE.test(s)) throw new Error(`hub registry: scope "${String(s)}" in connector "${m.id}" isn't read_*`)
    }
    for (const s of required) {
      if (!read.includes(s)) throw new Error(`hub registry: required scope "${s}" in connector "${m.id}" isn't in its read list`)
    }
    if (m.id === 'shopify' && !required.includes('read_returns')) {
      throw new Error('hub registry: the shopify connector must require read_returns')
    }
    // One SignIn per account: every connector naming an account must agree on its scopes, since the grant checks them.
    const scopeKey = JSON.stringify([[...read].sort(), [...required].sort()])
    const seen = scopesByAccount.get(m.accountId)
    if (seen !== undefined && seen !== scopeKey) throw new Error(`hub registry: connectors disagree on the scopes of account "${m.accountId}"`)
    scopesByAccount.set(m.accountId, scopeKey)

    for (const t of m.tools) {
      if (typeof t.name !== 'string' || !TOOL_NAME.test(t.name)) throw new Error(`hub registry: tool name "${String(t.name)}" isn't resource_action`)
      if (tools.has(t.name)) throw new Error(`hub registry: duplicate tool name "${t.name}"`)
      if ((t as { mode: unknown }).mode !== 'read') throw new Error(`hub registry: tool "${t.name}" isn't mode read`)
      if (typeof t.description !== 'string' || t.description.length === 0 || t.description.length > MAX_DESCRIPTION) {
        throw new Error(`hub registry: tool "${t.name}" description must be 1 to ${MAX_DESCRIPTION} characters`)
      }
      if (!isStrictObject(t.input)) throw new Error(`hub registry: tool "${t.name}" input isn't a strict z.object`)
      let inputSchema: Record<string, unknown>
      try {
        inputSchema = z.toJSONSchema(t.input) as Record<string, unknown>
      } catch {
        throw new Error(`hub registry: tool "${t.name}" input can't convert to JSON Schema`)
      }
      tools.set(t.name, {
        name: t.name,
        description: t.description,
        mode: t.mode,
        input: t.input,
        inputSchema,
        run: t.run,
        connector: m,
      })
    }
  }
  return { tools, modules, knownWrites }
}

function isHttps(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    return new URL(raw).protocol === 'https:'
  } catch {
    return false
  }
}

/** The startup rules for an `oauth_mcp` module (P5 W1 section 6). Throws: loud, never half open. */
function checkMcpModule(m: McpConnectorModule, tools: Map<string, RegisteredTool>, scopesByAccount: Map<string, string>, knownWrites: Set<string>): void {
  const fail = (msg: string): never => {
    throw new Error(`hub registry: ${msg}`)
  }
  if (typeof m.id !== 'string' || !ACCOUNT_ID.test(m.id)) fail(`bad connector id "${String(m.id)}"`)
  if (typeof m.accountId !== 'string' || !ACCOUNT_ID.test(m.accountId)) fail(`bad account id in connector "${m.id}"`)
  if (m.profile !== 'slack' && m.profile !== 'generic') fail(`connector "${m.id}" has no known profile`)
  if (typeof m.configure !== 'function') fail(`connector "${m.id}" has no configure()`)
  const hosts = [...(m.mcp?.allowedHosts ?? [])]
  if (hosts.length === 0 || hosts.some(h => typeof h !== 'string' || !/^[a-z0-9.-]+(:\d+)?$/.test(h))) fail(`connector "${m.id}" allowed hosts are malformed`)
  const allowed = (raw: unknown, what: string) => {
    if (!isHttps(raw) || !hosts.includes(new URL(raw).host)) fail(`connector "${m.id}" ${what} isn't https on an allowed host`)
  }
  allowed(m.mcp.endpoint, 'mcp.endpoint')
  if (!isHttps(m.mcp.resource) || m.mcp.resource.endsWith('/')) fail(`connector "${m.id}" mcp.resource must be https without a trailing slash`)
  if (m.client === 'preregistered') {
    if (!m.endpoints) fail(`connector "${m.id}" is pre-registered without pinned endpoints`)
    allowed(m.endpoints!.authorization, 'authorization endpoint')
    allowed(m.endpoints!.token, 'token endpoint')
    if (m.endpoints!.revoke !== null) allowed(m.endpoints!.revoke, 'revoke endpoint')
  } else if (m.client === 'dynamic') {
    if (m.endpoints) fail(`connector "${m.id}" is dynamic and pins endpoints`)
  } else fail(`connector "${m.id}" client must be preregistered or dynamic`)

  const base = [...(m.scopes?.base ?? [])]
  const policies = Object.entries(m.scopes?.policy ?? {})
  const seen = new Set<string>()
  for (const [list, name] of [[base, 'base'], ...policies.map(([p, l]) => [[...l], `policy ${p}`] as const)] as const) {
    for (const s of list) {
      if (typeof s !== 'string' || !MCP_SCOPE.test(s)) fail(`scope "${String(s)}" in connector "${m.id}" isn't an exact scope handle`)
      if (seen.has(s)) fail(`scope "${s}" in connector "${m.id}" ${name} isn't disjoint from the other lists`)
      seen.add(s)
    }
  }
  if (base.length === 0) fail(`connector "${m.id}" has no base scopes`)
  const scopeKey = JSON.stringify(['oauth_mcp', [...base].sort(), policies.map(([p, l]) => [p, [...l].sort()]).sort()])
  const prior = scopesByAccount.get(m.accountId)
  if (prior !== undefined && prior !== scopeKey) fail(`connectors disagree on the scopes of account "${m.accountId}"`)
  scopesByAccount.set(m.accountId, scopeKey)

  const writes = new Set(m.knownWrites ?? [])
  for (const w of writes) knownWrites.add(w)
  for (const t of m.tools ?? []) {
    if (typeof t.name !== 'string' || !TOOL_NAME.test(t.name)) fail(`tool name "${String(t.name)}" isn't resource_action`)
    if (tools.has(t.name)) fail(`duplicate tool name "${t.name}"`)
    if (writes.has(t.name) || writes.has(t.upstream)) fail(`tool "${t.name}" names a known write`)
    if (typeof t.upstream !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(t.upstream)) fail(`tool "${t.name}" upstream name is malformed`)
    if (typeof t.description !== 'string' || t.description.length === 0 || t.description.length > MAX_DESCRIPTION) {
      fail(`tool "${t.name}" description must be 1 to ${MAX_DESCRIPTION} characters`)
    }
    if (!isStrictObject(t.input)) fail(`tool "${t.name}" input isn't a strict z.object`)
    if (t.policy !== undefined && !Object.hasOwn(m.scopes.policy, t.policy)) fail(`tool "${t.name}" names an unknown policy`)
    const cap = t.maxResultBytes ?? MAX_RESULT_BYTES
    if (!Number.isSafeInteger(cap) || cap <= 0 || cap > MAX_RESULT_BYTES) fail(`tool "${t.name}" maxResultBytes must be 1 to ${MAX_RESULT_BYTES}`)
    let inputSchema: Record<string, unknown> = {}
    try {
      inputSchema = z.toJSONSchema(t.input) as Record<string, unknown>
    } catch {
      fail(`tool "${t.name}" input can't convert to JSON Schema`)
    }
    const fixed = { ...(t.fixed ?? {}) }
    tools.set(t.name, {
      name: t.name,
      description: t.description,
      mode: 'read',
      input: t.input,
      inputSchema,
      connector: m,
      policy: t.policy,
      run: async (ctx, input) => {
        if (!ctx.mcp) return err('not_configured', m.id)
        // The hub's fixed arguments win over the model's.
        const r = await ctx.mcp.call(t.upstream, { ...(input as Record<string, unknown>), ...fixed })
        if (!r.ok) return r
        if (new TextEncoder().encode(JSON.stringify(r.value)).byteLength > cap) return err('result_too_large', MCP_TOO_LARGE)
        return ok(r.value)
      },
    })
  }
}

/** The fixed hint on an MCP tool's oversize result (never truncated). */
export const MCP_TOO_LARGE = 'narrow the search or lower `limit`'

/** The scope lists of the connector that names this account. */
export function scopesFor(registry: Registry, accountId: string): { read: readonly string[]; required: readonly string[] } | null {
  const m = registry.modules.find(c => c.accountId === accountId)
  // An oauth_mcp account has no client-credentials scopes: H0's grant path answers not_configured for it.
  return m && !isMcpConnector(m) ? m.scopes : null
}

/** The connector kind behind an account (P5 W1): picks the SignIn path. Null: no connector names the account. */
export function kindFor(registry: Registry, accountId: string): 'client_credentials' | 'oauth_mcp' | null {
  const m = registry.modules.find(c => c.accountId === accountId)
  return m ? (isMcpConnector(m) ? 'oauth_mcp' : 'client_credentials') : null
}

/** The oauth_mcp module for an account, if any. */
export const mcpConnectorFor = (registry: Registry, accountId: string): McpConnectorModule | null =>
  registry.modules.find((c): c is McpConnectorModule => c.accountId === accountId && isMcpConnector(c)) ?? null

export type GatewayDeps = {
  registry: Registry
  /** Whether a connector's account is configured (Shopify: shop, client id and secret all set). Env only. */
  isConfigured(connector: HubConnector): boolean
  /** The read client for a connector's account (the SignIn stub). Tool code never sees a token. */
  shopifyFor(connector: HubConnector): ShopifyReadClient
  nowMs(): number
}

/** What an account's SignIn says about serving its tools now (P5 W1). */
export type Readiness = { ready: true; policies: readonly string[] } | { ready: false; code: 'not_configured' | 'scope_mismatch' | 'paused' }

/** H0's deps plus the per-account readiness and the MCP proxy. ReadGateway passes these (orchestrator wiring line). */
export type ReadyGatewayDeps = GatewayDeps & {
  /** Asks the account's SignIn: oauth_mcp usable (exact scopes) and not paused; client_credentials not paused. */
  isReady(accountId: string): Promise<Readiness>
  mcpFor(connector: McpConnectorModule): McpClient
}

/** The tool name a log line may carry: a registered name, else a fixed `unknown` (never caller text). */
export const toolNameForLog = (registry: Registry, name: string): string => (registry.tools.has(name) ? name : 'unknown')

/** Read tools whose connector account is configured. */
export function listReadTools(deps: GatewayDeps): ToolInfo[] {
  const out: ToolInfo[] = []
  for (const t of deps.registry.tools.values()) {
    if (t.mode !== 'read' || !deps.isConfigured(t.connector)) continue
    // oauth_mcp tools need the account's readiness, which only listReadyTools asks for: never listed here.
    if (isMcpConnector(t.connector)) continue
    out.push({ name: t.name, connector: t.connector.id, description: t.description, inputSchema: t.inputSchema })
  }
  return out
}

/** Runs a read tool. Unknown, not read, unconfigured, bad args and oversize results are results, never throws. */
export async function callReadTool(deps: GatewayDeps, scope: CallerScope, name: string, args: unknown): Promise<HubResult<{ data: unknown }>> {
  const t = deps.registry.tools.get(name)
  if (!t) return err('unknown_tool', TOOL_NAME.test(name) ? name : undefined)
  if (t.mode !== 'read') return err('write_refused', name)
  if (!deps.isConfigured(t.connector)) return err('not_configured', t.connector.id)
  // oauth_mcp tools run only through callReadyTool (readiness first): fail closed here.
  if (isMcpConnector(t.connector)) return err('not_configured', t.connector.id)
  return runTool(deps, scope, t, args, undefined)
}

async function runTool(deps: GatewayDeps, scope: CallerScope, t: RegisteredTool, args: unknown, mcp: McpClient | undefined): Promise<HubResult<{ data: unknown }>> {
  const name = t.name
  const parsed = t.input.safeParse(args)
  if (!parsed.success) return err('invalid_args', name)
  const ctx: ToolContext = { shopify: deps.shopifyFor(t.connector), scope, nowMs: deps.nowMs() }
  if (mcp) ctx.mcp = mcp
  const result = await t.run(ctx, parsed.data)
  if (!result.ok) {
    // Rebuilt here from the code alone: a tool's own message could carry upstream text, and it never reaches the runner.
    const code = isHubErrorCode(result.error?.code) ? result.error.code : 'internal'
    const retry = result.error?.retryAfterMs
    // An MCP tool's oversize result keeps its fixed hint (P5 W1); every other message is the code's text and the name.
    const detail = code === 'result_too_large' && isMcpConnector(t.connector) ? `${name}; ${MCP_TOO_LARGE}` : name
    return err(code, detail, typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? retry : undefined)
  }
  let json: string | undefined
  try {
    json = JSON.stringify(result.value)
  } catch {
    return err('internal')
  }
  if (json !== undefined && new TextEncoder().encode(json).byteLength > MAX_RESULT_BYTES) {
    return err('result_too_large', isMcpConnector(t.connector) ? `${name}; ${MCP_TOO_LARGE}` : name)
  }
  return ok({ data: result.value })
}

/** Readiness once per account for one listing or call. */
async function readinessByAccount(deps: ReadyGatewayDeps, accounts: Iterable<string>): Promise<Map<string, Readiness>> {
  const ids = [...new Set(accounts)]
  const answers = await Promise.all(ids.map(id => deps.isReady(id)))
  return new Map(ids.map((id, i) => [id, answers[i]!]))
}

/** ReadGateway.listTools (P5 W1): read tools whose account is configured and ready and whose policy (if any) is on. */
export async function listReadyTools(deps: ReadyGatewayDeps): Promise<ToolInfo[]> {
  const candidates = [...deps.registry.tools.values()].filter(t => t.mode === 'read' && deps.isConfigured(t.connector))
  const ready = await readinessByAccount(deps, candidates.map(t => t.connector.accountId))
  const out: ToolInfo[] = []
  for (const t of candidates) {
    const r = ready.get(t.connector.accountId)
    if (!r?.ready) continue
    if (t.policy !== undefined && !r.policies.includes(t.policy)) continue
    out.push({ name: t.name, connector: t.connector.id, description: t.description, inputSchema: t.inputSchema })
  }
  return out
}

/**
 * ReadGateway.callTool (P5 W1). Before parsing arguments and before any upstream request: a known write answers
 * write_refused, any other unlisted name unknown_tool, an unconfigured or disconnected account not_configured, a scope
 * difference scope_mismatch, a paused account paused, a tool whose policy is off unknown_tool (it isn't listed).
 */
export async function callReadyTool(deps: ReadyGatewayDeps, scope: CallerScope, name: string, args: unknown): Promise<HubResult<{ data: unknown }>> {
  const t = deps.registry.tools.get(name)
  if (!t) {
    if (deps.registry.knownWrites?.has(name)) return err('write_refused', TOOL_NAME.test(name) ? name : undefined)
    return err('unknown_tool', TOOL_NAME.test(name) ? name : undefined)
  }
  if (t.mode !== 'read') return err('write_refused', name)
  if (!deps.isConfigured(t.connector)) return err('not_configured', t.connector.id)
  const r = (await readinessByAccount(deps, [t.connector.accountId])).get(t.connector.accountId)!
  if (!r.ready) return err(r.code, t.connector.id)
  if (t.policy !== undefined && !r.policies.includes(t.policy)) return err('unknown_tool', name)
  return runTool(deps, scope, t, args, isMcpConnector(t.connector) ? deps.mcpFor(t.connector) : undefined)
}
