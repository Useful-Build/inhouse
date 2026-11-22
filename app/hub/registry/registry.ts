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

export type ToolContext = { shopify: ShopifyReadClient; scope: CallerScope; nowMs: number }

export type ToolDef<I> = {
  name: string
  description: string
  mode: 'read'
  input: z.ZodType<I>
  run(ctx: ToolContext, input: I): Promise<HubResult<unknown>>
}

export type ConnectorModule = {
  id: string
  accountId: string
  apiVersion?: string
  scopes: { read: readonly string[]; required: readonly string[] }
  tools: readonly ToolDef<any>[]
}

export type RegisteredTool = {
  name: string
  description: string
  /** Read from the module at runtime. buildRegistry admits only 'read'; the gateway checks again (P6 adds modes). */
  mode: string
  input: z.ZodType<unknown>
  inputSchema: Record<string, unknown>
  run(ctx: ToolContext, input: unknown): Promise<HubResult<unknown>>
  connector: ConnectorModule
}

export type Registry = {
  tools: ReadonlyMap<string, RegisteredTool>
  modules: readonly ConnectorModule[]
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

export function buildRegistry(modules: readonly ConnectorModule[]): Registry {
  const tools = new Map<string, RegisteredTool>()
  const scopesByAccount = new Map<string, string>()
  for (const m of modules) {
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
  return { tools, modules }
}

/** The scope lists of the connector that names this account. */
export function scopesFor(registry: Registry, accountId: string): { read: readonly string[]; required: readonly string[] } | null {
  const m = registry.modules.find(c => c.accountId === accountId)
  return m ? m.scopes : null
}

export type GatewayDeps = {
  registry: Registry
  /** Whether a connector's account is configured (Shopify: shop, client id and secret all set). */
  isConfigured(connector: ConnectorModule): boolean
  /** The read client for a connector's account (the SignIn stub). Tool code never sees a token. */
  shopifyFor(connector: ConnectorModule): ShopifyReadClient
  nowMs(): number
}

/** The tool name a log line may carry: a registered name, else a fixed `unknown` (never caller text). */
export const toolNameForLog = (registry: Registry, name: string): string => (registry.tools.has(name) ? name : 'unknown')

/** Read tools whose connector account is configured. */
export function listReadTools(deps: GatewayDeps): ToolInfo[] {
  const out: ToolInfo[] = []
  for (const t of deps.registry.tools.values()) {
    if (t.mode !== 'read' || !deps.isConfigured(t.connector)) continue
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
  const parsed = t.input.safeParse(args)
  if (!parsed.success) return err('invalid_args', name)
  const result = await t.run({ shopify: deps.shopifyFor(t.connector), scope, nowMs: deps.nowMs() }, parsed.data)
  if (!result.ok) {
    // Rebuilt here from the code alone: a tool's own message could carry upstream text, and it never reaches the runner.
    const code = isHubErrorCode(result.error?.code) ? result.error.code : 'internal'
    const retry = result.error?.retryAfterMs
    return err(code, name, typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? retry : undefined)
  }
  let json: string | undefined
  try {
    json = JSON.stringify(result.value)
  } catch {
    return err('internal')
  }
  if (json !== undefined && new TextEncoder().encode(json).byteLength > MAX_RESULT_BYTES) return err('result_too_large', name)
  return ok({ data: result.value })
}
