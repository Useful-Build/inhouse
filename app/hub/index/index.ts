// The hub's main module (wrangler.hub.jsonc `main`). Typed RPC only (OC 8): no MCP, no HTTP.
// - Default export: 404 for every method and path. The config has no route, so nothing outside the account reaches it.
// - ReadGateway (named WorkerEntrypoint): listTools, callTool. Read tools only. Bound by H1's egress route.
// - ServerGateway (named): status, reencrypt. Product Worker server code only; the egress route never holds it (OC 9).
// Every method parses its arguments (schemas.ts) and returns a HubResult; an unexpected exception is logged as
// `internal` without its text and returned as `internal`. RPC error serialization is never the contract.
// Docs read 2026-11-20: service bindings RPC (named entrypoints), RPC error handling.
//
// The test upstream seam (hub/testing/) is reached only from signin/signin.ts and this file's shopFor (the test shop
// override, test-shop.ts), each inside the guarded branch
// `__INHOUSE_HUB_TEST__ && env.INHOUSE_TEST_BUILD === '1'`; wrangler.hub.jsonc defines it "false", so esbuild drops it.
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { AccountStatus, CallerScope, CallToolOptions, HubResult, ReadGateway as ReadApi, ServerGateway as ServerApi, ToolInfo } from './contract'
import { err } from './errors'
import { log } from './log'
import { AccountIdSchema, CallerScopeSchema, ToolNameSchema } from './schemas'
import { callReadTool, listReadTools, toolNameForLog, type ConnectorModule, type GatewayDeps, type ShopifyReadClient } from '../registry/registry'
import { isConfigured, loadRegistry, signInName } from '../signin/signin'
import { decideTestShop } from './test-shop'

export { SignIn } from '../signin/signin'

const notFound = (): Response =>
  new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

export default {
  async fetch(): Promise<Response> {
    return notFound()
  },
} satisfies ExportedHandler<Env>

const scopeFields = (scope: CallerScope) =>
  scope.kind === 'run' ? { runId: scope.runId, requestId: scope.requestId } : { requestId: scope.requestId }

const signInFor = (env: Env, accountId: string) => env.SIGNIN.get(env.SIGNIN.idFromName(accountId))

type HubEnv = Env & { INHOUSE_TEST_BUILD?: string }

/**
 * The call's shop (test-shop.ts): the hub's own unless a test build is asked for a host its seam registers. The guard is
 * written out in full (never behind a helper), so the deployable build drops the branch and its dynamic import.
 */
async function shopFor(env: HubEnv, options: unknown): Promise<HubResult<{ shop: string | null }>> {
  if (__INHOUSE_HUB_TEST__ && env.INHOUSE_TEST_BUILD === '1') {
    const { testUpstreams } = await import('../testing/index')
    return decideTestShop(options, true, host => testUpstreams.has(host))
  }
  return decideTestShop(options, false, () => false)
}

async function guarded<T>(fn: () => Promise<HubResult<T>>): Promise<HubResult<T>> {
  try {
    return await fn()
  } catch {
    log('hub_internal', { code: 'internal' })
    return err('internal')
  }
}

/** `testShop`: a test build's override handle (shopFor), read by its own SignIn object (signin.ts signInName). */
async function gatewayDeps(env: Env, testShop: string | null = null): Promise<GatewayDeps> {
  const registry = await loadRegistry(env)
  return {
    registry,
    isConfigured: (c: ConnectorModule) => isConfigured(env, c),
    shopifyFor: (c: ConnectorModule): ShopifyReadClient => ({
      graphql: async (document, variables, apiVersion) => {
        const version = apiVersion ?? c.apiVersion
        if (!version) return err('invalid_args', 'apiVersion')
        const query = { accountId: c.accountId, document, variables, apiVersion: version }
        if (testShop === null) return (await signInFor(env, c.accountId).query(query)) as HubResult<{ data: unknown }>
        return (await env.SIGNIN.get(env.SIGNIN.idFromName(signInName(c.accountId, testShop))).query({ ...query, testShop })) as HubResult<{ data: unknown }>
      },
    }),
    nowMs: () => Date.now(),
  }
}

export class ReadGateway extends WorkerEntrypoint<Env> implements ReadApi {
  async listTools(scope: CallerScope): Promise<HubResult<ToolInfo[]>> {
    return guarded(async () => {
      if (!CallerScopeSchema.safeParse(scope).success) return err('invalid_args', 'scope')
      return { ok: true, value: listReadTools(await gatewayDeps(this.env)) }
    })
  }

  async callTool(scope: CallerScope, name: string, args: unknown, options?: CallToolOptions): Promise<HubResult<{ data: unknown }>> {
    const started = Date.now()
    const parsedScope = CallerScopeSchema.safeParse(scope)
    const parsedName = ToolNameSchema.safeParse(name)
    const result = await guarded(async () => {
      if (!parsedScope.success) return err('invalid_args', 'scope')
      if (!parsedName.success) return err('invalid_args', 'name')
      const shop = await shopFor(this.env, options)
      if (!shop.ok) return shop
      return callReadTool(await gatewayDeps(this.env, shop.value.shop), parsedScope.data, parsedName.data, args)
    })
    // A malformed registry already logged hub_config_invalid; this line then names no tool.
    const registry = await loadRegistry(this.env).catch(() => null)
    log('hub_call', {
      ...(parsedScope.success ? scopeFields(parsedScope.data) : {}),
      tool: registry && parsedName.success ? toolNameForLog(registry, parsedName.data) : 'unknown',
      code: result.ok ? 'ok' : result.error.code,
      ms: Date.now() - started,
    })
    return result
  }
}

export class ServerGateway extends WorkerEntrypoint<Env> implements ServerApi {
  async status(scope: CallerScope, accountId: string): Promise<HubResult<AccountStatus>> {
    return guarded(async () => {
      if (!CallerScopeSchema.safeParse(scope).success) return err('invalid_args', 'scope')
      if (!AccountIdSchema.safeParse(accountId).success) return err('invalid_args', 'accountId')
      return (await signInFor(this.env, accountId).status(accountId)) as HubResult<AccountStatus>
    })
  }

  async reencrypt(scope: CallerScope, accountId: string): Promise<HubResult<{ kid: string; changed: boolean }>> {
    return guarded(async () => {
      if (!CallerScopeSchema.safeParse(scope).success) return err('invalid_args', 'scope')
      if (!AccountIdSchema.safeParse(accountId).success) return err('invalid_args', 'accountId')
      return (await signInFor(this.env, accountId).reencrypt(accountId)) as HubResult<{ kid: string; changed: boolean }>
    })
  }
}
