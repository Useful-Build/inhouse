// ConnectGateway (P5 W1): a named WorkerEntrypoint for product Worker server code only, re-exported from index.ts by
// an orchestrator line (`export { ConnectGateway } from '../oauth/entry'`). The logic is gateway.ts. Every method
// returns a HubResult; an unexpected exception is logged as `internal` without its text.
// Keeping the runner off this binding is code discipline plus checks, not structure (brief section 3): this entrypoint
// refuses a `run` scope, the import-boundary lint and the product config check are the orchestrator's.
import { safeError } from '../../server/safe-error'
import { WorkerEntrypoint } from 'cloudflare:workers'
import type {
  AccountSummary, CallToolOptions, CallerScope, CardFacts, CardFactsRequest, ConfirmToolsRequest, ConnectGateway as ConnectApi, ConnectionActor,
  ConnectionCredential, ConnectionState, ConnectionSummary, ConnectionTools, ConnectionView, DetectResult, HubResult, Instant, PrepareConnectionRequest,
  UpdateConnectionRequest, WriteToolInfo,
} from '../index/contract'
import { CardFactsRequestSchema } from '../index/schemas'
import { err } from '../index/errors'
import { log } from '../index/log'
import { connectionsIndexFor, envRecord, flushTestLogs, isConfiguredFrom, loadRegistry, signInFor, signInName, TEST_FAKES_DO_NAME } from '../signin/signin'
import { methodHooks } from '../connections/hooks'
import type { ConnectionGatewayDeps, ConnectionObjectStub, IndexStub } from '../connections/gateway'
import { isMcpConnector, type HubConnector } from '../registry/registry'
import { decideTestShop } from '../index/test-shop'
import { refuseTestFakes } from './test-gate'
import { parseShopifyWriteConfig, SHOPIFY_WRITE_SIGNIN_ACCOUNT } from '../connectors/shopify/write/provider'
import * as G from './gateway'
import { settledAnswer } from '../../shared/rpc-answer'

type HubEnv = Env & { INHOUSE_TEST_BUILD?: string }

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

/**
 * `guarded`, and in the hub's TEST bundle only, each answer's JSON also kept in a bounded list in the singleton
 * `__test-fakes__` DO (hub/testing/fakes.ts, `state.connect.bodies`, for W5's strict-parse check). The deployable
 * bundle drops the branch (the define is "false").
 */
async function answered<T>(env: Env, fn: () => Promise<HubResult<T>>): Promise<HubResult<T>> {
  const r = await guarded(env, fn)
  if (__INHOUSE_HUB_TEST__ && (env as HubEnv).INHOUSE_TEST_BUILD === '1') {
    // Must not turn a HubResult into a throw: a failed record is logged loudly (error name only) and the answer still returns.
    try {
      await env.SIGNIN.get(env.SIGNIN.idFromName(TEST_FAKES_DO_NAME)).testRecordConnectBody(JSON.stringify(r))
    } catch (e) {
      console.error(`hub test: recording a ConnectGateway answer failed and it is lost (${safeError(e)})`)
    }
  }
  return r
}

async function deps(env: Env): Promise<G.ConnectDeps> {
  const [registry, record] = await Promise.all([loadRegistry(env), envRecord(env)])
  return {
    registry,
    isConfigured: c => isConfiguredFrom(env, record, c),
    signIn: accountId => signInFor(env, accountId) as unknown as G.ConnectStub,
    // Stage 1 M2-D: the store the write app writes to (its handle only), when the write app is configured; else none, so
    // the product refuses a Shopify write (fail closed).
    shopOf: c => (c.id === 'shopify' ? parseShopifyWriteConfig(env as Parameters<typeof parseShopifyWriteConfig>[0])?.shop ?? null : null),
    // Stage 1 M3-S2 (N21): the write store's currency, read by the write SignIn in the test build only (writes are off
    // elsewhere, so the deployable build neither asks nor reads; the guard is written out in full).
    ...(__INHOUSE_HUB_TEST__ && (env as Env & { INHOUSE_TEST_BUILD?: string }).INHOUSE_TEST_BUILD === '1'
      ? {
        currencyOf: async (c: HubConnector) => {
          if (c.id !== 'shopify') return null
          const ns = env.SHOPIFY_WRITE_SIGNIN
          return (await settledAnswer(ns.get(ns.idFromName(SHOPIFY_WRITE_SIGNIN_ACCOUNT)).shopCurrency())) as string | null
        },
      }
      : {}),
  }
}

/** Stage 1 M4-R1 (N35): the connection methods' deps (connections/gateway.ts): the objects, the index and the hooks. */
export async function connectionDeps(env: Env): Promise<ConnectionGatewayDeps> {
  return {
    registry: await loadRegistry(env),
    object: accountId => signInFor(env, accountId) as unknown as ConnectionObjectStub,
    index: () => connectionsIndexFor(env) as unknown as IndexStub,
    hooks: methodHooks,
  }
}

export class ConnectGateway extends WorkerEntrypoint<Env> implements ConnectApi {
  async startConnect(scope: CallerScope, req: { accountId: string; memberId: string }): Promise<HubResult<{ authorizeUrl: string; expiresAt: Instant }>> {
    return answered(this.env, async () => G.startConnect(await deps(this.env), scope, req))
  }
  async completeConnect(scope: CallerScope, req: { state: string; code: string; memberId: string }): Promise<HubResult<{ accountId: string }>> {
    return answered(this.env, async () => G.completeConnect(await deps(this.env), scope, req))
  }
  async failConnect(scope: CallerScope, req: { state: string; memberId: string; error: string }): Promise<HubResult<{ accountId: string | null }>> {
    return answered(this.env, async () => G.failConnect(await deps(this.env), scope, req))
  }
  async disconnect(scope: CallerScope, accountId: string): Promise<HubResult<{ revoked: boolean }>> {
    return answered(this.env, async () => G.disconnect(await deps(this.env), scope, accountId))
  }
  async setPaused(scope: CallerScope, accountId: string, paused: boolean): Promise<HubResult<{ paused: boolean }>> {
    return answered(this.env, async () => G.setPaused(await deps(this.env), scope, accountId, paused))
  }
  /**
   * `options.testShopHost` (P5 #337): in the hub's test build only, for a host its seam registers, a Shopify account's row
   * comes from that test shop's own SignIn object, granted first (its token endpoint), as the turn's reads will use it.
   * Anything else with an override is refused (`invalid_args`), never answered from the real account. The guard is written
   * out in full (as index.ts shopFor), so the deployable bundle drops the branch and its imports.
   */
  async listAccounts(scope: CallerScope, options?: CallToolOptions): Promise<HubResult<AccountSummary[]>> {
    return answered(this.env, async () => {
      // The caller's scope first (#337 round 3): nothing is granted for a caller G.listAccounts would refuse.
      if (!G.serverScope(scope)) return err('invalid_args', 'scope')
      let shop: HubResult<{ shop: string | null }>
      if (__INHOUSE_HUB_TEST__ && (this.env as Env & { INHOUSE_TEST_BUILD?: string }).INHOUSE_TEST_BUILD === '1') {
        const { testUpstreams } = await import('../testing/index')
        shop = decideTestShop(options, true, host => testUpstreams.has(host))
      } else shop = decideTestShop(options, false, () => false)
      if (!shop.ok) return shop
      const d = await deps(this.env)
      const testShop = shop.value.shop
      if (testShop === null) return G.listAccounts(d, scope)
      const shopifyAccounts = new Set(d.registry.modules.filter(c => !isMcpConnector(c)).map(c => c.accountId))
      const stubFor = (accountId: string) => this.env.SIGNIN.get(this.env.SIGNIN.idFromName(signInName(accountId, testShop)))
      for (const accountId of shopifyAccounts) {
        // A failed grant leaves the row as the object has it (`failed`): the prompt then doesn't claim the app.
        await settledAnswer(stubFor(accountId).warmTestShop({ accountId, testShop }))
      }
      return G.listAccounts({ ...d, signIn: accountId => (shopifyAccounts.has(accountId) ? stubFor(accountId) : d.signIn(accountId)) as unknown as G.ConnectStub }, scope)
    })
  }
  /**
   * Stage 1 M3 (card details, #488; contract.ts `cardFacts`): a `server` scope only, its request parsed strictly, then the
   * write SignIn's read in the test build. The deployable build answers `not_configured` and reads nothing (the guard is
   * written out in full). Not `answered`: no customer's name is kept in the test hook's list of answers.
   */
  async cardFacts(scope: CallerScope, req: CardFactsRequest): Promise<HubResult<CardFacts>> {
    return guarded(this.env, async () => {
      if (!G.serverScope(scope)) return err('invalid_args', 'scope')
      const parsed = CardFactsRequestSchema.safeParse(req)
      if (!parsed.success) return err('invalid_args', 'req')
      if (__INHOUSE_HUB_TEST__ && (this.env as Env & { INHOUSE_TEST_BUILD?: string }).INHOUSE_TEST_BUILD === '1') {
        const ns = this.env.SHOPIFY_WRITE_SIGNIN
        return (await settledAnswer(ns.get(ns.idFromName(SHOPIFY_WRITE_SIGNIN_ACCOUNT)).cardFacts(parsed.data))) as HubResult<CardFacts>
      }
      return err('not_configured', 'shopify_write')
    })
  }
  // Stage 1 M4-R1 (N35): every connection method, each parsed and scope-checked in connections/gateway.ts. Prepare, get,
  // update, remove and the list are built here; the rest delegate to connections/hooks.ts, `not_built` until filled.
  async detectConnection(scope: CallerScope, req: { actor: ConnectionActor; url: string }): Promise<HubResult<DetectResult>> {
    return answered(this.env, async () => G.detectConnection(await connectionDeps(this.env), scope, req))
  }
  async prepareConnection(scope: CallerScope, req: PrepareConnectionRequest): Promise<HubResult<ConnectionView>> {
    return answered(this.env, async () => G.prepareConnection(await connectionDeps(this.env), scope, req))
  }
  async getConnection(scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<ConnectionView>> {
    return answered(this.env, async () => G.getConnection(await connectionDeps(this.env), scope, req))
  }
  async updateConnection(scope: CallerScope, req: UpdateConnectionRequest): Promise<HubResult<ConnectionView>> {
    return answered(this.env, async () => G.updateConnection(await connectionDeps(this.env), scope, req))
  }
  async setTrusted(scope: CallerScope, req: { actor: ConnectionActor; accountId: string; trusted: boolean; ifRev: number }): Promise<HubResult<{ trusted: boolean; policyRev: number }>> {
    return answered(this.env, async () => G.setTrusted(await connectionDeps(this.env), scope, req))
  }
  async startConnectionSignIn(scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<{ authorizeUrl: string; host: string; expiresAt: Instant }>> {
    return answered(this.env, async () => G.startConnectionSignIn(await connectionDeps(this.env), scope, req))
  }
  /** Not `answered`: a credential's request never lands in the test hook's list of answers, even refused. */
  async setConnectionCredential(scope: CallerScope, req: { actor: ConnectionActor; accountId: string; credential: ConnectionCredential }): Promise<HubResult<{ state: ConnectionState }>> {
    return guarded(this.env, async () => G.setConnectionCredential(await connectionDeps(this.env), scope, req))
  }
  async checkConnection(scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<{ listed: number }>> {
    return answered(this.env, async () => G.checkConnection(await connectionDeps(this.env), scope, req))
  }
  async listConnectionTools(scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<ConnectionTools>> {
    return answered(this.env, async () => G.listConnectionTools(await connectionDeps(this.env), scope, req))
  }
  async confirmConnectionTools(scope: CallerScope, req: ConfirmToolsRequest): Promise<HubResult<{ policyRev: number }>> {
    return answered(this.env, async () => G.confirmConnectionTools(await connectionDeps(this.env), scope, req))
  }
  async removeConnection(scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<{ revoked: boolean }>> {
    return answered(this.env, async () => G.removeConnection(await connectionDeps(this.env), scope, req))
  }
  async listConnections(scope: CallerScope): Promise<HubResult<ConnectionSummary[]>> {
    return answered(this.env, async () => G.listConnections(await connectionDeps(this.env), scope))
  }
  async listWriteTools(scope: CallerScope): Promise<HubResult<WriteToolInfo[]>> {
    return answered(this.env, async () => G.listWriteTools(await connectionDeps(this.env), scope))
  }
  /**
   * TEST BUILD ONLY (contract.ts `testFakes`): refused with `not_configured` outside the test bundle whatever the scope,
   * and with `invalid_args` for any scope but `server` inside it (test-gate.ts). The import sits inside the guard written
   * out in full, so the deployable bundle (define "false") never bundles the hook.
   */
  async testFakes(scope: CallerScope, op: unknown): Promise<HubResult<unknown>> {
    return guarded(this.env, async () => {
      const testBuild = __INHOUSE_HUB_TEST__ && (this.env as Env & { INHOUSE_TEST_BUILD?: string }).INHOUSE_TEST_BUILD === '1'
      const refused = refuseTestFakes(testBuild, scope)
      if (refused) return refused
      if (__INHOUSE_HUB_TEST__ && (this.env as Env & { INHOUSE_TEST_BUILD?: string }).INHOUSE_TEST_BUILD === '1') {
        const { runHubFakesOp } = await import('../testing/fakes')
        return runHubFakesOp(this.env, op)
      }
      return err('not_configured', 'testFakes')
    })
  }
}
