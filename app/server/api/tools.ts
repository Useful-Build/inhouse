// The Tools page's server side (P5 W3, p5-w3.md): route C reads the tools (the hub's accounts, the product's
// `connector_accounts` rows and the catalog, merged, never inventing a tool), route D pauses or resumes one, route E
// disconnects an OAuth one. Connect is W1's (`api/connect.ts`), not here. Technical routes: the Inhouse team writes, an
// Admin reads, a Member reads (the composer needs the list).
//
// The gateway and the D1 side arrive as ports (`ToolsDeps`), built per request by the orchestrator's wiring line
// (`toolsHandlers(resolve)`), so the merge rules and the guards run in plain tests with a fake hub.
import { ToolPausedInputSchema } from '../../shared/contract/tools.ts'
import type { ToolChannel, ToolDetail, ToolsData } from '../../shared/contract/tools.ts'
import type { StageIndex } from '../../shared/contract/common.ts'
import type { AgentErrorCode } from '../../shared/contract/index.ts'
import { z } from 'zod'
import { readBody, writer } from '../db/handler-kit.ts'
import type { At } from '../db/members.ts'
import { apiError, apiJson } from '../http.ts'
import type { Handler, HandlerContext } from '../routes.ts'
import { TOOL_CATALOG, catalogByAccount, catalogByKey } from './tools-catalog.ts'
import type { CatalogEntry } from './tools-catalog.ts'

// ---- The hub's `ConnectGateway` (p5-w1.md section 3), mirrored for the types this file uses. ----
// Replace these with `import type` from the hub's contract once W1 is on the branch (an orchestrator line).
type Instant = { iso: string; ms: number }
type HubErrorCode = 'invalid_args' | 'not_configured' | 'upstream_unavailable' | 'rate_limited' | 'internal' | (string & {})
type HubResult<T> = { ok: true; value: T } | { ok: false; error: { code: HubErrorCode; message: string } }
type CallerScope = { kind: 'server'; job: string; requestId: string }
export interface AccountSummary {
  accountId: string
  connector: string
  configured: boolean
  status: {
    accountId: string
    state: 'empty' | 'active' | 'failed' | 'disconnected'
    lastError: { code: string; at: Instant } | null
    paused: boolean
    kind: 'client_credentials' | 'oauth_mcp'
    connectedBy: string | null
    connectedAt: Instant | null
    revokeFailedAt: Instant | null
    needsReconnect: boolean
  }
}
export interface ConnectGateway {
  disconnect(scope: CallerScope, accountId: string): Promise<HubResult<{ revoked: boolean }>>
  setPaused(scope: CallerScope, accountId: string, paused: boolean): Promise<HubResult<{ paused: boolean }>>
  listAccounts(scope: CallerScope): Promise<HubResult<AccountSummary[]>>
}

/** A `connector_accounts` row (W1's 0300): the product's lifecycle record for the page. */
export interface ConnectorAccountRow {
  accountId: string
  connector: string
  lastState: 'never' | 'connecting' | 'connected' | 'failed' | 'disconnected'
  lastStateAtMs: number
  connectedBy: string | null
  connectedAtMs: number | null
}

/** What route D and route E write to the audit log (`app/shared/contract/audit.ts`'s two new actions). */
export type ToolsAuditArgs =
  | { action: 'tools.pause'; accountId: string; paused: boolean }
  | { action: 'tools.disconnect'; accountId: string; revoked: boolean }

/** The D1 side. Implemented over the stores by the orchestrator's wiring (W1's store owns the table). */
export interface ToolsAccounts {
  list(): Promise<ConnectorAccountRow[]>
  /** The audit line for a pause, target kind `connector`. */
  recordPause(at: At, accountId: string, line: ToolsAuditArgs): Promise<void>
  /**
   * Route E's write in one batch: the row's `last_state = 'disconnected'`, `disconnected_by`, `disconnected_at_ms`,
   * `rev + 1` (an upsert: the row may not exist yet), and the audit line.
   */
  recordDisconnect(at: At, accountId: string, connector: string, line: ToolsAuditArgs): Promise<void>
}

export interface ToolsDeps {
  gateway: ConnectGateway
  accounts: ToolsAccounts
}

/** The hub's state TTL for a connect in progress (W1 section 5): an older `connecting` row is an abandoned connect. */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000

const instant = (ms: number): Instant => ({ iso: new Date(ms).toISOString(), ms })
/** The `lastRead.default` when the agent has read nothing yet (the real client's empty value). */
const NEVER_READ = instant(0)

const SLACK_CHANNEL_DESC = 'Notices reach your team in the channels your admin lists, and anyone can ask your Inhouse agent there.'
const SLACK_CHANNEL_NEED: StageIndex = 1

/**
 * `ToolsData` from the hub's accounts, the product's rows and the catalog, at `nowMs` (injected). A tool shows only when the
 * hub returned its account and says it's configured; every key in the lists names such an account.
 */
export function buildToolsData(input: { accounts: readonly AccountSummary[]; rows: readonly ConnectorAccountRow[]; nowMs: number }): ToolsData {
  const { nowMs } = input
  const hub = new Map(input.accounts.map(a => [a.accountId, a] as const))
  const rows = new Map(input.rows.map(r => [r.accountId, r] as const))

  const connected: string[] = []
  const beingConnected: string[] = []
  const connection: ToolsData['connection'] = {}
  const catalog: ToolsData['catalog'] = []
  const details: ToolsData['details'] = {}
  const channels: ToolChannel[] = []

  for (const e of TOOL_CATALOG) {
    const a = hub.get(e.accountId)
    if (!a || !a.configured) continue
    const row = rows.get(e.accountId)
    const s = a.status
    const isConnected = s.state === 'active' || s.state === 'failed'
    const connecting = row?.lastState === 'connecting' && nowMs - row.lastStateAtMs <= CONNECT_STATE_TTL_MS
    const connectedAtMs = s.connectedAt?.ms ?? row?.connectedAtMs ?? null
    const connectedBy = s.connectedBy ?? row?.connectedBy ?? null

    if (isConnected) {
      connected.push(e.key)
      if (s.state === 'failed' || s.needsReconnect) {
        const since = s.lastError?.at.ms ?? row?.lastStateAtMs ?? connectedAtMs ?? nowMs
        connection[e.key] = { status: 'disconnected', since: instant(since) }
      }
    } else {
      catalog.push({ k: e.key, name: e.name, desc: e.desc, need: e.need })
    }
    if (connecting) beingConnected.push(e.key)

    const d: ToolDetail = { name: e.name, desc: e.desc, ex: e.ex, read: e.read, draft: e.draft, run: e.run, conn: e.conn, site: e.site }
    if (isConnected && connectedAtMs !== null) d.since = instant(connectedAtMs)
    if (connecting && row) d.liveBy = instant(row.lastStateAtMs + CONNECT_STATE_TTL_MS)
    if (connectedBy !== null) d.connectedBy = connectedBy
    if (e.oauth) d.canDisconnect = isConnected
    if (s.revokeFailedAt !== null) d.revokeFailed = true
    if (isConnected) d.paused = s.paused
    details[e.key] = d

    // Slack is also a channel (decision 0006's successor): where notices reach the team, once it's usable.
    if (e.key === 'slack' && s.state === 'active' && !s.needsReconnect) {
      channels.push({ key: e.key, name: e.name, desc: SLACK_CHANNEL_DESC, need: SLACK_CHANNEL_NEED, since: instant(connectedAtMs ?? nowMs), site: e.site })
    }
  }

  return { connected, channels, beingConnected, lastRead: { default: NEVER_READ }, catalog, details, connection, setup: {}, readDone: connected.length }
}

// ---- Handlers ----

const NoBody = z.object({}).strict()

const scopeOf = (c: HandlerContext, job: string): CallerScope => ({ kind: 'server', job, requestId: c.requestId })

/** The hub's failure as the API's: `not_configured` is a 409 with its reason, an unreachable hub 503, the rest 500. */
export function hubFailure(code: HubErrorCode): Response {
  const api: AgentErrorCode = code === 'not_configured' ? 'conflict' : code === 'upstream_unavailable' || code === 'rate_limited' ? 'unavailable' : 'unknown'
  return code === 'not_configured' ? apiError(api, { reason: 'not_configured' }) : apiError(api)
}

/** The catalog entry a path's `:accountId` names: the connector key (what the client sends) or the hub's account id. */
const entryOf = (param: string | undefined): CatalogEntry | undefined =>
  param === undefined ? undefined : catalogByKey(param) ?? catalogByAccount(param)

export function toolsHandlers(resolve: (c: HandlerContext) => ToolsDeps): { listTools: Handler; setToolPaused: Handler; disconnectTool: Handler } {
  /** Route C, `GET /api/tools`. */
  const listTools: Handler = async c => {
    if (new URL(c.request.url).search !== '') return apiError('invalid')
    const deps = resolve(c)
    const hub = await deps.gateway.listAccounts(scopeOf(c, 'tools.list'))
    if (!hub.ok) return hubFailure(hub.error.code)
    const rows = await deps.accounts.list()
    return apiJson(buildToolsData({ accounts: hub.value, rows, nowMs: c.nowMs }))
  }

  /** Route D, `PUT /api/tools/:accountId/paused` `{ paused }`: Inhouse only. Last write wins, no `ifRev`. */
  const setToolPaused: Handler = async c => {
    if (c.principal.kind !== 'inhouse') return apiError('forbidden')
    const entry = entryOf(c.params.accountId)
    if (!entry) return apiError('not_found')
    const body = await readBody(c.request, ToolPausedInputSchema)
    if ('error' in body) return body.error
    const deps = resolve(c)
    const r = await deps.gateway.setPaused(scopeOf(c, 'tools.pause'), entry.accountId, body.ok.paused)
    if (!r.ok) return hubFailure(r.error.code)
    // The line follows the change: a failed write answers 5xx with the change made (a retry changes nothing more and
    // writes the line).
    await deps.accounts.recordPause(writer(c), entry.accountId, { action: 'tools.pause', accountId: entry.accountId, paused: r.value.paused })
    return apiJson({ paused: r.value.paused })
  }

  /** Route E, `POST /api/tools/:accountId/disconnect`: Inhouse only, OAuth tools only. */
  const disconnectTool: Handler = async c => {
    if (c.principal.kind !== 'inhouse') return apiError('forbidden')
    const entry = entryOf(c.params.accountId)
    if (!entry) return apiError('not_found')
    const body = await readBody(c.request, NoBody)
    if ('error' in body) return body.error
    if (!entry.oauth) return apiError('conflict', { reason: 'not_disconnectable' })
    const deps = resolve(c)
    const r = await deps.gateway.disconnect(scopeOf(c, 'tools.disconnect'), entry.accountId)
    if (!r.ok) return hubFailure(r.error.code)
    await deps.accounts.recordDisconnect(writer(c), entry.accountId, entry.key, { action: 'tools.disconnect', accountId: entry.accountId, revoked: r.value.revoked })
    return apiJson({ revoked: r.value.revoked })
  }

  return { listTools, setToolPaused, disconnectTool }
}
