// ConnectGateway's logic (P5 W1 section 3), as plain functions over the registry and the account's SignIn, so the
// Node project tests it without workerd. entry.ts is the WorkerEntrypoint over these.
// - `scope.kind` must be `server` on every method (the runner's `run` scope is refused).
// - Every argument is parsed; the state's prefix only routes to the right SignIn, the binding is the stored item.
// - listAccounts gives one row per account id, whatever number of modules name it.
// - Every SignIn answer is read through `settledAnswer`: copied as plain data and released, never passed on as is (an
//   answer passed on as is carries its disposer, which keeps the call open until the product's caller, maybe a Durable
//   Object, disposes it).
import type { AccountStatus, AccountSummary, CallerScope, HubResult, Instant } from '../index/contract'
import { err, ok } from '../index/errors'
import { AccountIdSchema, AuthCodeSchema, CallerScopeSchema, ConnectErrorSchema, ConnectStateSchema, MemberIdSchema } from '../index/schemas'
import { isMcpConnector, type HubConnector, type Registry } from '../registry/registry'
import { stateAccount } from './protocol'
import { settledAnswer } from '../../shared/rpc-answer'

/** The SignIn stub methods the gateway calls. */
export type ConnectStub = {
  beginConnect(req: { accountId: string; memberId: string }): Promise<HubResult<{ authorizeUrl: string; expiresAtMs: number }>>
  completeConnect(req: { state: string; code: string; memberId: string }): Promise<HubResult<{ accountId: string }>>
  failConnect(req: { state: string; memberId: string }): Promise<HubResult<{ accountId: string | null }>>
  disconnect(accountId: string): Promise<HubResult<{ generation: number; revoked?: boolean }>>
  setPaused(accountId: string, paused: boolean): Promise<HubResult<{ paused: boolean }>>
  status(accountId: string): Promise<HubResult<AccountStatus>>
}

export type ConnectDeps = {
  registry: Registry
  isConfigured(connector: HubConnector): boolean
  signIn(accountId: string): ConnectStub
  /** Stage 1 M2-D: the store handle a connector's writes go to (Shopify's write app), or null. */
  shopOf?(connector: HubConnector): string | null
}

const instant = (ms: number): Instant => ({ iso: new Date(ms).toISOString(), ms })

export function serverScope(scope: unknown): boolean {
  const parsed = CallerScopeSchema.safeParse(scope)
  return parsed.success && parsed.data.kind === 'server'
}

const modulesFor = (deps: ConnectDeps, accountId: string) => deps.registry.modules.filter(m => m.accountId === accountId)

/** The oauth_mcp module naming the account, or the reason it can't connect. */
function oauthModule(deps: ConnectDeps, accountId: string): HubConnector | 'unknown' | 'not_configured' {
  const m = modulesFor(deps, accountId).find(isMcpConnector)
  if (!m) return 'unknown'
  return deps.isConfigured(m) ? m : 'not_configured'
}

export async function startConnect(deps: ConnectDeps, scope: CallerScope, req: { accountId: string; memberId: string }): Promise<HubResult<{ authorizeUrl: string; expiresAt: Instant }>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  if (typeof req !== 'object' || req === null) return err('invalid_args')
  if (!AccountIdSchema.safeParse(req.accountId).success) return err('invalid_args', 'accountId')
  if (!MemberIdSchema.safeParse(req.memberId).success) return err('invalid_args', 'memberId')
  const m = oauthModule(deps, req.accountId)
  if (m === 'unknown') return err('unknown_tool')
  if (m === 'not_configured') return err('not_configured', req.accountId)
  const r = await settledAnswer(deps.signIn(req.accountId).beginConnect({ accountId: req.accountId, memberId: req.memberId }))
  if (!r.ok) return r
  return ok({ authorizeUrl: r.value.authorizeUrl, expiresAt: instant(r.value.expiresAtMs) })
}

/** The state's account when it routes to a known oauth_mcp connector. */
function routedAccount(deps: ConnectDeps, state: unknown): string | null {
  if (!ConnectStateSchema.safeParse(state).success) return null
  const accountId = stateAccount(state as string)
  if (!accountId) return null
  return modulesFor(deps, accountId).some(isMcpConnector) ? accountId : null
}

export async function completeConnect(deps: ConnectDeps, scope: CallerScope, req: { state: string; code: string; memberId: string }): Promise<HubResult<{ accountId: string }>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  if (typeof req !== 'object' || req === null) return err('invalid_args')
  if (!MemberIdSchema.safeParse(req.memberId).success) return err('invalid_args', 'memberId')
  if (!AuthCodeSchema.safeParse(req.code).success) return err('invalid_args', 'code')
  const accountId = routedAccount(deps, req.state)
  if (!accountId) return err('state_invalid')
  return settledAnswer(deps.signIn(accountId).completeConnect({ state: req.state, code: req.code, memberId: req.memberId }))
}

/** The AS answered `?error=`. Its value is validated and dropped: never echoed, logged or stored. */
export async function failConnect(deps: ConnectDeps, scope: CallerScope, req: { state: string; memberId: string; error: string }): Promise<HubResult<{ accountId: string | null }>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  if (typeof req !== 'object' || req === null) return err('invalid_args')
  if (!MemberIdSchema.safeParse(req.memberId).success) return err('invalid_args', 'memberId')
  if (!ConnectErrorSchema.safeParse(req.error).success) return err('invalid_args', 'error')
  const accountId = routedAccount(deps, req.state)
  if (!accountId) return ok({ accountId: null })
  return settledAnswer(deps.signIn(accountId).failConnect({ state: req.state, memberId: req.memberId }))
}

/** OAuth accounts only (OC-W1-8): Shopify's credentials are deployment config with no connect flow to bring it back. */
export async function disconnect(deps: ConnectDeps, scope: CallerScope, accountId: string): Promise<HubResult<{ revoked: boolean }>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  if (!AccountIdSchema.safeParse(accountId).success) return err('invalid_args', 'accountId')
  const mods = modulesFor(deps, accountId)
  if (mods.length === 0) return err('unknown_tool')
  if (!mods.some(isMcpConnector)) return err('invalid_args', 'accountId')
  const r = await settledAnswer(deps.signIn(accountId).disconnect(accountId))
  if (!r.ok) return r
  return ok({ revoked: r.value.revoked === true })
}

export async function setPaused(deps: ConnectDeps, scope: CallerScope, accountId: string, paused: boolean): Promise<HubResult<{ paused: boolean }>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  if (!AccountIdSchema.safeParse(accountId).success) return err('invalid_args', 'accountId')
  if (typeof paused !== 'boolean') return err('invalid_args', 'paused')
  if (modulesFor(deps, accountId).length === 0) return err('unknown_tool')
  return settledAnswer(deps.signIn(accountId).setPaused(accountId, paused))
}

export async function listAccounts(deps: ConnectDeps, scope: CallerScope): Promise<HubResult<AccountSummary[]>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  const first = new Map<string, HubConnector>()
  for (const m of deps.registry.modules) if (!first.has(m.accountId)) first.set(m.accountId, m)
  const rows: AccountSummary[] = []
  for (const [accountId, m] of first) {
    const status = await settledAnswer(deps.signIn(accountId).status(accountId))
    if (!status.ok) return status
    const configured = modulesFor(deps, accountId).some(x => deps.isConfigured(x))
    const shop = deps.shopOf?.(m) ?? null
    rows.push({ accountId, connector: m.id, configured, status: status.value, ...(shop !== null ? { shop } : {}) })
  }
  return ok(rows)
}
