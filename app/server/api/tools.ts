// The Tools page's server side (P5 W3, p5-w3.md): route C reads the tools (the hub's accounts, the product's
// `connector_accounts` rows and the catalog, merged, never inventing a tool), route D pauses or resumes one, route E
// disconnects an OAuth one. Routes D and E take the hub's account id (`:accountId`), as W1's route A does. Connect is
// W1's (`api/connect.ts`), not here. Technical routes: the Inhouse team writes, an Admin reads, a Member reads (the
// composer needs the list).
//
// The gateway and the D1 side arrive as ports (`ToolsDeps`), built per request by the orchestrator's wiring line
// (`toolsHandlers(resolve)`), so the merge rules and the guards run in plain tests with a fake hub.
import { ToolPausedInputSchema } from '../../shared/contract/tools.ts'
import type { ToolChannel, ToolDetail, ToolsData } from '../../shared/contract/tools.ts'
import type { StageIndex } from '../../shared/contract/common.ts'
import { z } from 'zod'
import { readBody, writer } from '../db/handler-kit.ts'
import type { At } from '../db/members.ts'
import { apiError, apiJson } from '../http.ts'
import type { Handler, HandlerContext } from '../routes.ts'
import type { AccountSummary, ConnectGateway, HubError } from '../../hub/index/contract.ts'
import type { ConnectorAccount } from '../db/connector-accounts.ts'
import { TOOL_CATALOG, catalogByAccount } from './tools-catalog.ts'
import { withTestShopConnectInWorker } from '@test-shop'
import type { CatalogEntry } from './tools-catalog.ts'

/** The ConnectGateway methods these routes call (W1's contract, app/hub/index/contract.ts). */
export type ToolsGateway = Pick<ConnectGateway, 'listAccounts' | 'setPaused' | 'disconnect'>

/**
 * Route 70's ports over the env's `HUB_CONNECT` (#337 rounds 3 and 4): `gateway` is the binding as it is, and `listView`
 * is route C's read. In the test and eval builds only, that read carries the test shop override the turns' reads and
 * prompt carry (`@test-shop` withTestShopConnectInWorker), so the graded runners' store check reads exactly the account
 * the turns use; every other build gets the off module (the binding as it is). It takes no options of its own (route C
 * sends none; the override is the only one). Pause and disconnect keep the binding's own read and write.
 */
export function toolsDepsOf(env: { HUB_CONNECT?: unknown; INHOUSE_TEST_BUILD?: string }): { gateway: ToolsGateway; listView: Pick<ToolsGateway, 'listAccounts'> } {
  const gateway = env.HUB_CONNECT as ToolsGateway
  const view = withTestShopConnectInWorker(gateway, env)
  return { gateway, listView: { listAccounts: scope => view.listAccounts(scope) } }
}
// `disconnect` must be idempotent: route E calls it again on a retry after a failed row write (the hub is already
// `disconnected`).

/** What the page reads of a `connector_accounts` row (W1's store, `ConnectorAccount`). */
export type ConnectorAccountRow = Pick<ConnectorAccount, 'accountId' | 'connector' | 'lastState' | 'lastStateAtMs' | 'connectedBy' | 'connectedAtMs'>

/** What route D and route E write to the audit log (`app/shared/contract/audit.ts`'s two new actions). */
export type ToolsAuditArgs =
  | { action: 'tools.pause'; accountId: string; paused: boolean }
  | { action: 'tools.disconnect'; accountId: string; revoked: boolean }

/** The D1 side. Implemented over the stores by `tools-accounts.ts` (part 2; W1's store owns the table). */
export interface ToolsAccounts {
  list(): Promise<ConnectorAccountRow[]>
  /** Stage 1 M2-I: the write operations enabled for the brand (`permission_ceiling`); a tool with one `acts`. */
  enabledOperations(): Promise<readonly string[]>
  /** The audit line for a pause that changed something, target kind `connector`. */
  recordPause(at: At, accountId: string, line: ToolsAuditArgs): Promise<void>
  /**
   * Route E's write in one batch: the row's `last_state = 'disconnected'`, `disconnected_by`, `disconnected_at_ms`,
   * `rev + 1` (an upsert: the row may not exist yet), and the audit line.
   */
  recordDisconnect(at: At, accountId: string, connector: string, line: ToolsAuditArgs): Promise<void>
}

export interface ToolsDeps {
  /** The hub's own accounts: pause and disconnect act on them, and read them for their "before" state. */
  gateway: ToolsGateway
  /**
   * Route C's list read, when it differs from `gateway` (#337 round 4): in test and eval builds it carries the test shop
   * override (toolsDepsOf), so the graded runners' store check reads the account the turns use. Absent: `gateway`.
   */
  listView?: Pick<ToolsGateway, 'listAccounts'>
  accounts: ToolsAccounts
}

/** The hub's state TTL for a connect in progress (W1 section 5): an older `connecting` row is an abandoned connect. */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000

const instant = (ms: number): { iso: string; ms: number } => ({ iso: new Date(ms).toISOString(), ms })
/** STUB: the `lastRead.default` until the agent's read times are recorded (the real client's empty value). */
const NEVER_READ = instant(0)

const SLACK_CHANNEL_DESC = 'Notices reach your team in the channels your admin lists, and anyone can ask your Inhouse agent there.'
/** The contract's legacy `need` (N17): kept so the shape is unchanged, never read by the product, which has no stages (M2-I). */
const SLACK_CHANNEL_NEED: StageIndex = 1

/**
 * `ToolsData` from the hub's accounts, the product's rows and the catalog, at `nowMs` (injected). A tool shows only when the
 * hub returned its account and says it's configured; every key in the lists names such an account. No timestamp is
 * invented: a time the hub and the row can't give is never replaced by the clock.
 */
export function buildToolsData(input: { accounts: readonly AccountSummary[]; rows: readonly ConnectorAccountRow[]; nowMs: number; enabled?: readonly string[] }): ToolsData {
  const { nowMs } = input
  // An operation key starts with its connector (`shopify.order.tag_add`). None given: none enabled, the N2 default.
  const acting = new Set((input.enabled ?? []).map(op => op.split('.')[0]))
  const hub = new Map(input.accounts.map(a => [a.accountId, a] as const))
  const rows = new Map(input.rows.map(r => [r.accountId, r] as const))

  const connected: string[] = []
  const beingConnected: string[] = []
  const connection: ToolsData['connection'] = {}
  const catalog: ToolsData['catalog'] = []
  const details: ToolsData['details'] = {}
  const channels: ToolChannel[] = []
  let readable = 0

  for (const e of TOOL_CATALOG) {
    const a = hub.get(e.accountId)
    if (!a || !a.configured) continue
    const row = rows.get(e.accountId)
    const s = a.status
    const connectedAtMs = s.connectedAt?.ms ?? row?.connectedAtMs ?? null
    // The contract: connected implies `since` (the client throws on a connected tool with no date). The hub gives a
    // client-credentials account its first grant's time, an OAuth one its connect time; else a `connected` row's time (the
    // Slack channel below uses the same). A failed row's time is a failure, never a connect date. An account with none (a
    // first grant that failed, nothing ever connected) is not connected: it reads as a catalog entry, and its details say
    // when its login failed.
    const sinceMs = connectedAtMs ?? (row?.lastState === 'connected' ? row.lastStateAtMs : null)
    const isConnected = (s.state === 'active' || s.state === 'failed') && sinceMs !== null
    // A failed or reconnect-needing tool with a fresh connecting row is in `connected` (with its failed state) AND in
    // `beingConnected`: a reconnect is in progress.
    const connecting = row?.lastState === 'connecting' && nowMs - row.lastStateAtMs <= CONNECT_STATE_TTL_MS
    const connectedBy = s.connectedBy ?? row?.connectedBy ?? null

    if (isConnected) {
      connected.push(e.key)
      if (s.state === 'failed' || s.needsReconnect) {
        // The contract's `since` is required: the hub's error time, else the row's, else when it was connected (never the
        // clock). Rare: a failure the hub gave no time for.
        connection[e.key] = { status: 'disconnected', since: instant(s.lastError?.at.ms ?? row?.lastStateAtMs ?? sinceMs) }
      } else if (s.state === 'active' && !s.paused) {
        readable += 1
      }
    } else if (!connecting) {
      catalog.push({ k: e.key, name: e.name, desc: e.desc, need: e.need, accountId: e.accountId })
    }
    if (connecting) beingConnected.push(e.key)

    // Details for a tool with a history: connected, being connected, or that has an account row or a hub state of its own
    // (failed or refused first connect, disconnected, a failed revoke). A tool the Inhouse team never touched has none: it
    // is a catalog entry only, and the UI has no page for it.
    if (!isConnected && !connecting && s.state === 'empty' && row === undefined) continue
    const d: ToolDetail = { accountId: e.accountId, name: e.name, desc: e.desc, ex: e.ex, read: e.read, draft: e.draft, run: e.run, conn: e.conn, site: e.site }
    if (isConnected) d.since = instant(sinceMs)
    else if (s.state === 'failed' && s.lastError) d.loginFailedAt = s.lastError.at
    if (connecting && row) d.liveBy = instant(row.lastStateAtMs + CONNECT_STATE_TTL_MS)
    if (connectedBy !== null) d.connectedBy = connectedBy
    if (e.oauth) d.canDisconnect = isConnected
    if (s.revokeFailedAt !== null) d.revokeFailed = true
    if (isConnected) d.paused = s.paused
    if (acting.has(e.key)) d.acts = true
    details[e.key] = d

    // Slack is also a channel (decision 0006's successor): where notices reach the team, once it's usable.
    if (e.key === 'slack' && s.state === 'active' && !s.needsReconnect) {
      // `since` is required by the contract: with no time from the hub or the row, Slack isn't listed as a channel yet.
      if (sinceMs !== null) channels.push({ key: e.key, name: e.name, desc: SLACK_CHANNEL_DESC, need: SLACK_CHANNEL_NEED, since: instant(sinceMs), site: e.site })
    }
  }

  // `readDone` is a STUB (like `lastRead`): the tools the agent can read now (active, not paused, no reconnect needed),
  // until the morning check records what it has read.
  return { connected, channels, beingConnected, lastRead: { default: NEVER_READ }, catalog, details, connection, setup: {}, readDone: readable }
}

// ---- Handlers ----

const NoBody = z.object({}).strict()

const scopeOf = (c: HandlerContext, job: string) => ({ kind: 'server' as const, job, requestId: c.requestId })

/**
 * The hub's failure as the API's: `not_configured` is a 409 with its reason, `rate_limited` a 429 (with `Retry-After`
 * when the hub gives one), an unreachable hub 503, the rest 500.
 */
export function hubFailure(error: HubError): Response {
  switch (error.code) {
    case 'not_configured': return apiError('conflict', { reason: 'not_configured' })
    case 'rate_limited': return apiError('rate_limited', error.retryAfterMs === undefined ? {} : { headers: { 'Retry-After': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) } })
    case 'upstream_unavailable': return apiError('unavailable')
    default: return apiError('unknown')
  }
}

/** The catalog entry a path's `:accountId` names: the hub's account id only (a connector key is unknown, 404). */
const entryOf = (param: string | undefined): CatalogEntry | undefined => (param === undefined ? undefined : catalogByAccount(param))

export function toolsHandlers(resolve: (c: HandlerContext) => ToolsDeps): { listTools: Handler; setToolPaused: Handler; disconnectTool: Handler } {
  /** Route C, `GET /api/tools`. A query string is ignored. */
  const listTools: Handler = async c => {
    const deps = resolve(c)
    const hub = await (deps.listView ?? deps.gateway).listAccounts(scopeOf(c, 'tools.list'))
    if (!hub.ok) return hubFailure(hub.error)
    const [rows, enabled] = await Promise.all([deps.accounts.list(), deps.accounts.enabledOperations()])
    return apiJson(buildToolsData({ accounts: hub.value, rows, nowMs: c.nowMs, enabled }))
  }

  /**
   * Route D, `PUT /api/tools/:accountId/paused` `{ paused }`: Inhouse only. Last write wins, no `ifRev`. A repeat that
   * changes nothing (the hub already held that state) writes no audit line.
   */
  const setToolPaused: Handler = async c => {
    if (c.principal.kind !== 'inhouse') return apiError('forbidden')
    const entry = entryOf(c.params.accountId)
    if (!entry) return apiError('not_found')
    const body = await readBody(c.request, ToolPausedInputSchema)
    if ('error' in body) return body.error
    const deps = resolve(c)
    const before = await deps.gateway.listAccounts(scopeOf(c, 'tools.pause'))
    if (!before.ok) return hubFailure(before.error)
    const was = before.value.find(a => a.accountId === entry.accountId)
    if (!was || !was.configured) return apiError('conflict', { reason: 'not_configured' })
    const r = await deps.gateway.setPaused(scopeOf(c, 'tools.pause'), entry.accountId, body.ok.paused)
    if (!r.ok) return hubFailure(r.error)
    // The line follows the change: a failed write answers 5xx with the change made (a retry then sees no change and
    // writes no line, so a lost line is the stated residual).
    if (was.status.paused !== r.value.paused) {
      await deps.accounts.recordPause(writer(c), entry.accountId, { action: 'tools.pause', accountId: entry.accountId, paused: r.value.paused })
    }
    return apiJson({ paused: r.value.paused })
  }

  /**
   * Route E, `POST /api/tools/:accountId/disconnect`: Inhouse only, OAuth tools only, and only a connected account (an
   * empty or already disconnected one is 409 `not_connected`, no line). A retry after a failed row write finds the hub
   * `disconnected` and the row not, so it calls the hub again: W1's `disconnect` must be idempotent.
   */
  const disconnectTool: Handler = async c => {
    if (c.principal.kind !== 'inhouse') return apiError('forbidden')
    const entry = entryOf(c.params.accountId)
    if (!entry) return apiError('not_found')
    const body = await readBody(c.request, NoBody)
    if ('error' in body) return body.error
    if (!entry.oauth) return apiError('conflict', { reason: 'not_disconnectable' })
    const deps = resolve(c)
    const before = await deps.gateway.listAccounts(scopeOf(c, 'tools.disconnect'))
    if (!before.ok) return hubFailure(before.error)
    const was = before.value.find(a => a.accountId === entry.accountId)
    if (!was || !was.configured) return apiError('conflict', { reason: 'not_configured' })
    const state = was.status.state
    let retry = false
    if (state === 'disconnected') {
      const row = (await deps.accounts.list()).find(r => r.accountId === entry.accountId)
      // Only a row that still says connected or failed: a `connecting` row is a reconnect in flight, which a second
      // hub disconnect would kill.
      retry = row?.lastState === 'connected' || row?.lastState === 'failed'
    }
    if (state !== 'active' && state !== 'failed' && !retry) return apiError('conflict', { reason: 'not_connected' })
    const r = await deps.gateway.disconnect(scopeOf(c, 'tools.disconnect'), entry.accountId)
    if (!r.ok) return hubFailure(r.error)
    // On a retry the hub finds no captured token and says `revoked: true`, which would hide a failed first revoke: keep
    // the hub's record of it.
    const revoked = retry ? r.value.revoked && was.status.revokeFailedAt === null : r.value.revoked
    await deps.accounts.recordDisconnect(writer(c), entry.accountId, entry.key, { action: 'tools.disconnect', accountId: entry.accountId, revoked })
    return apiJson({ revoked })
  }

  return { listTools, setToolPaused, disconnectTool }
}
