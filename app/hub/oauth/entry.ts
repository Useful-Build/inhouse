// ConnectGateway (P5 W1): a named WorkerEntrypoint for product Worker server code only, re-exported from index.ts by
// an orchestrator line (`export { ConnectGateway } from '../oauth/entry'`). The logic is gateway.ts. Every method
// returns a HubResult; an unexpected exception is logged as `internal` without its text.
// Keeping the runner off this binding is code discipline plus checks, not structure (brief section 3): this entrypoint
// refuses a `run` scope, the import-boundary lint and the product config check are the orchestrator's.
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { AccountSummary, CallerScope, ConnectGateway as ConnectApi, HubResult, Instant } from '../index/contract'
import { err } from '../index/errors'
import { log } from '../index/log'
import { isConfigured, loadRegistry, signInFor } from '../signin/signin'
import { CallerScopeSchema } from '../index/schemas'
import * as G from './gateway'

async function guarded<T>(fn: () => Promise<HubResult<T>>): Promise<HubResult<T>> {
  try {
    return await fn()
  } catch {
    log('hub_internal', { code: 'internal' })
    return err('internal')
  }
}

/**
 * `guarded`, and in the hub's TEST bundle only, each answer's JSON also kept in a bounded in-isolate list the test-fakes
 * hook reads (hub/testing/fakes.ts, `state.connect.bodies`, for W5's strict-parse check). The deployable bundle drops
 * the branch (the define is "false").
 */
async function answered<T>(fn: () => Promise<HubResult<T>>): Promise<HubResult<T>> {
  const r = await guarded(fn)
  if (__INHOUSE_HUB_TEST__) {
    const bodies = ((globalThis as { __inhouseHubTestConnectBodies?: string[] }).__inhouseHubTestConnectBodies ??= [])
    bodies.push(JSON.stringify(r))
    if (bodies.length > 500) bodies.shift()
  }
  return r
}

async function deps(env: Env): Promise<G.ConnectDeps> {
  const registry = await loadRegistry(env)
  return {
    registry,
    isConfigured: c => isConfigured(env, c),
    signIn: accountId => signInFor(env, accountId) as unknown as G.ConnectStub,
  }
}

export class ConnectGateway extends WorkerEntrypoint<Env> implements ConnectApi {
  async startConnect(scope: CallerScope, req: { accountId: string; memberId: string }): Promise<HubResult<{ authorizeUrl: string; expiresAt: Instant }>> {
    return answered(async () => G.startConnect(await deps(this.env), scope, req))
  }
  async completeConnect(scope: CallerScope, req: { state: string; code: string; memberId: string }): Promise<HubResult<{ accountId: string }>> {
    return answered(async () => G.completeConnect(await deps(this.env), scope, req))
  }
  async failConnect(scope: CallerScope, req: { state: string; memberId: string; error: string }): Promise<HubResult<{ accountId: string | null }>> {
    return answered(async () => G.failConnect(await deps(this.env), scope, req))
  }
  async disconnect(scope: CallerScope, accountId: string): Promise<HubResult<{ revoked: boolean }>> {
    return answered(async () => G.disconnect(await deps(this.env), scope, accountId))
  }
  async setPaused(scope: CallerScope, accountId: string, paused: boolean): Promise<HubResult<{ paused: boolean }>> {
    return answered(async () => G.setPaused(await deps(this.env), scope, accountId, paused))
  }
  async listAccounts(scope: CallerScope): Promise<HubResult<AccountSummary[]>> {
    return answered(async () => G.listAccounts(await deps(this.env), scope))
  }
  /**
   * TEST BUILD ONLY (contract.ts `testFakes`): the guard written out in full, so the deployable bundle (define "false")
   * drops the branch and its dynamic import, and answers `not_configured`. A `server` scope only.
   */
  async testFakes(scope: CallerScope, op: unknown): Promise<HubResult<unknown>> {
    return guarded(async () => {
      if (__INHOUSE_HUB_TEST__ && (this.env as Env & { INHOUSE_TEST_BUILD?: string }).INHOUSE_TEST_BUILD === '1') {
        const parsed = CallerScopeSchema.safeParse(scope)
        if (!parsed.success || parsed.data.kind !== 'server') return err('invalid_args', 'scope')
        const { runHubFakesOp } = await import('../testing/fakes')
        return runHubFakesOp(this.env, op)
      }
      return err('not_configured', 'testFakes')
    })
  }
}
