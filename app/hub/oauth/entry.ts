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
import * as G from './gateway'

async function guarded<T>(fn: () => Promise<HubResult<T>>): Promise<HubResult<T>> {
  try {
    return await fn()
  } catch {
    log('hub_internal', { code: 'internal' })
    return err('internal')
  }
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
    return guarded(async () => G.startConnect(await deps(this.env), scope, req))
  }
  async completeConnect(scope: CallerScope, req: { state: string; code: string; memberId: string }): Promise<HubResult<{ accountId: string }>> {
    return guarded(async () => G.completeConnect(await deps(this.env), scope, req))
  }
  async failConnect(scope: CallerScope, req: { state: string; memberId: string; error: string }): Promise<HubResult<{ accountId: string | null }>> {
    return guarded(async () => G.failConnect(await deps(this.env), scope, req))
  }
  async disconnect(scope: CallerScope, accountId: string): Promise<HubResult<{ revoked: boolean }>> {
    return guarded(async () => G.disconnect(await deps(this.env), scope, accountId))
  }
  async setPaused(scope: CallerScope, accountId: string, paused: boolean): Promise<HubResult<{ paused: boolean }>> {
    return guarded(async () => G.setPaused(await deps(this.env), scope, accountId, paused))
  }
  async listAccounts(scope: CallerScope): Promise<HubResult<AccountSummary[]>> {
    return guarded(async () => G.listAccounts(await deps(this.env), scope))
  }
}
