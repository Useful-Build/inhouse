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
import { callReadyTool, listReadyTools, toolNameForLog } from '../registry/registry'
import { flushTestLogs, loadRegistry, readyGatewayDeps } from '../signin/signin'
import { codeModeFor } from '../codemode/run'
import { decideTestShop } from './test-shop'

export { SignIn } from '../signin/signin'
export { ConnectGateway } from '../oauth/entry'
// P5 (p5-w4): Slack delivery for product server code only (HUB_DELIVERY).
export { DeliveryGateway } from '../connectors/slack/delivery'

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

async function guarded<T>(env: Env, fn: () => Promise<HubResult<T>>): Promise<HubResult<T>> {
  try {
    return await fn()
  } catch {
    log('hub_internal', { code: 'internal' })
    return err('internal')
  } finally {
    await flushTestLogs(env)
  }
}

export class ReadGateway extends WorkerEntrypoint<Env> implements ReadApi {
  async listTools(scope: CallerScope): Promise<HubResult<ToolInfo[]>> {
    return guarded(this.env, async () => {
      if (!CallerScopeSchema.safeParse(scope).success) return err('invalid_args', 'scope')
      return { ok: true, value: await listReadyTools(await readyGatewayDeps(this.env)) }
    })
  }

  async callTool(scope: CallerScope, name: string, args: unknown, options?: CallToolOptions): Promise<HubResult<{ data: unknown }>> {
    const started = Date.now()
    const parsedScope = CallerScopeSchema.safeParse(scope)
    const parsedName = ToolNameSchema.safeParse(name)
    const result = await guarded(this.env, async () => {
      if (!parsedScope.success) return err('invalid_args', 'scope')
      if (!parsedName.success) return err('invalid_args', 'name')
      const shop = await shopFor(this.env, options)
      if (!shop.ok) return shop
      // P5 (p5-w2): code mode over env.LOADER, read only by shopify_script_run. Its reads go through the same shopifyFor,
      // so a test shop (shopFor) holds for scripts too and the hub's SHOPIFY_SHOP is never read while one is set.
      return callReadyTool({ ...(await readyGatewayDeps(this.env, shop.value.shop)), codemode: codeModeFor(this.env) }, parsedScope.data, parsedName.data, args)
    })
    // A malformed registry already logged hub_config_invalid; this line then names no tool.
    const registry = await loadRegistry(this.env).catch(() => null)
    log('hub_call', {
      ...(parsedScope.success ? scopeFields(parsedScope.data) : {}),
      tool: registry && parsedName.success ? toolNameForLog(registry, parsedName.data) : 'unknown',
      code: result.ok ? 'ok' : result.error.code,
      ms: Date.now() - started,
    })
    await flushTestLogs(this.env)
    return result
  }
}

export class ServerGateway extends WorkerEntrypoint<Env> implements ServerApi {
  async status(scope: CallerScope, accountId: string): Promise<HubResult<AccountStatus>> {
    return guarded(this.env, async () => {
      if (!CallerScopeSchema.safeParse(scope).success) return err('invalid_args', 'scope')
      if (!AccountIdSchema.safeParse(accountId).success) return err('invalid_args', 'accountId')
      return (await signInFor(this.env, accountId).status(accountId)) as HubResult<AccountStatus>
    })
  }

  async reencrypt(scope: CallerScope, accountId: string): Promise<HubResult<{ kid: string; changed: boolean }>> {
    return guarded(this.env, async () => {
      if (!CallerScopeSchema.safeParse(scope).success) return err('invalid_args', 'scope')
      if (!AccountIdSchema.safeParse(accountId).success) return err('invalid_args', 'accountId')
      return (await signInFor(this.env, accountId).reencrypt(accountId)) as HubResult<{ kid: string; changed: boolean }>
    })
  }
}
