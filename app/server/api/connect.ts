// Routes A and B (P5 W1, p5-w1.md section 9): the Inhouse team connects an OAuth tool (Slack) through the hub's
// ConnectGateway (binding `HUB_CONNECT`, product server code only). Both rows are `technical`, allow `inhouse`, so an
// Admin or Member gets 403 from the matrix before any hub call; each handler checks the principal again.
// - No token, code or verifier is logged by our code, stored in D1 or returned. Route B reads only `code`, `state` and
//   `error` from its query and forwards nothing else; the AS's `error` value is never echoed.
// - Route B is a GET (the AS redirects the browser), so P2's Origin check doesn't apply: the state's member binding at
//   the hub is the CSRF guard. Stated residual: the platform's request logs may record B's URL with `code` and `state`;
//   both are one-use, PKCE-bound and expire in 10 minutes.
import type { ConnectGateway } from '../../hub/index/contract.ts'
import { ConnectOutcomeSchema, ConnectorAccountIdSchema } from '../../shared/contract/audit.ts'
import type { ConnectOutcome } from '../../shared/contract/audit.ts'
import type { AgentErrorCode } from '../../shared/contract/index.ts'
import { respond } from '../../shared/security-headers.ts'
import { apiError, apiJson, SECURITY_HEADERS } from '../http.ts'
import { storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import type { ConnectorLastState } from '../db/connector-accounts.ts'
import type { HandlerEnv } from '../routes.ts'

/** The ConnectGateway methods these routes call. */
export type ConnectBinding = Pick<ConnectGateway, 'startConnect' | 'completeConnect' | 'failConnect' | 'listAccounts'>
/** The generated binding (`HUB_CONNECT: Service`, entrypoint ConnectGateway of inhouse-hub). */
export type ConnectCtx = ApiCtx & { env: Pick<HandlerEnv, 'HUB_CONNECT'> }

/**
 * The binding as the hub's contract. `wrangler types` types a service binding to a named entrypoint of another Worker
 * as a bare `Service` (it can't see the hub's code), so the RPC methods are typed from the hub's plain contract file;
 * every answer is a HubResult the handlers check.
 */
const gateway = (c: ConnectCtx): ConnectBinding => c.env.HUB_CONNECT as unknown as ConnectBinding

const scope = (c: ApiCtx) => ({ kind: 'server' as const, job: 'connect', requestId: c.requestId })

/** The Inhouse member calling, now (P2's principal); null for anyone else. */
const inhouseMember = (c: ApiCtx): string | null => (c.principal.kind === 'inhouse' ? c.principal.memberId : null)

/** `slack:workspace` → `slack`. */
const connectorOf = (accountId: string) => accountId.split(':')[0]!

/** A hub error code as this API's error (route A). */
const API_ERROR: Partial<Record<ConnectOutcome, AgentErrorCode>> = {
  invalid_args: 'invalid',
  unknown_tool: 'not_found',
  rate_limited: 'rate_limited',
  upstream_unavailable: 'unavailable',
  upstream_rejected: 'unavailable',
  key_unavailable: 'unavailable',
}

/**
 * Route A, `POST /api/connect/:accountId/start`: `{ authorizeUrl, expiresAt }`; the client navigates there. Writes the
 * row's `last_state = 'connecting'` (rev + 1) and a `tools.connect_start` line.
 */
export async function startConnect(c: ConnectCtx): Promise<Response> {
  const memberId = inhouseMember(c)
  if (!memberId) return apiError('forbidden')
  const id = ConnectorAccountIdSchema.safeParse(c.params.accountId)
  if (!id.success) return apiError('not_found')
  const r = await gateway(c).startConnect(scope(c), { accountId: id.data, memberId })
  if (!r.ok) {
    const code = r.error.code
    return apiError(API_ERROR[code] ?? (code === 'internal' ? 'unknown' : 'conflict'), API_ERROR[code] || code === 'internal' ? {} : { reason: code })
  }
  await storesOf(c).connectors.connectStarted(id.data, connectorOf(id.data), writer(c))
  return apiJson({ authorizeUrl: r.value.authorizeUrl, expiresAt: r.value.expiresAt })
}

/**
 * The account a state routes to: base64url(accountId) before the dot. A copy of `stateAccount` in
 * app/hub/oauth/protocol.ts (the product can only `import type` from the hub). A routing hint for the redirect only,
 * never a trust decision: the hub decides the outcome, and D1 is written only for a state the hub accepted.
 */
export function stateAccountHint(state: string | null): string | null {
  if (!state) return null
  const dot = state.indexOf('.')
  if (dot <= 0 || dot !== state.lastIndexOf('.') || dot > 120) return null
  try {
    const b64 = state.slice(0, dot).replaceAll('-', '+').replaceAll('_', '/')
    const id = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), ch => ch.charCodeAt(0)))
    return ConnectorAccountIdSchema.safeParse(id).success ? id : null
  } catch {
    return null
  }
}

/** The hub's state for an account as the row's `last_state` (`listAccounts`); `failed` when the hub can't say. */
async function hubLastState(c: ConnectCtx, accountId: string): Promise<Exclude<ConnectorLastState, 'connecting'>> {
  const rows = await gateway(c).listAccounts(scope(c))
  const row = rows.ok ? rows.value.find(r => r.accountId === accountId) : undefined
  if (!row) return 'failed'
  return ({ active: 'connected', failed: 'failed', disconnected: 'disconnected', empty: 'never' } as const)[row.status.state]
}

function redirect(location: string): Response {
  return respond(SECURITY_HEADERS, 303, { headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
}

/**
 * Route B, `GET /api/connect/callback`: the AS redirects the browser here. `completeConnect` (or `failConnect` on
 * `?error=`) with the signed-in Inhouse member's id, then `303` to `/tools/<connector>?connected=1`, to
 * `/tools/<connector>?connect_error=<code>` when the account is known, or `/tools?connect_error=<code>`. The code is
 * from the closed list, never upstream text. The row and its `tools.connect` line are written once, and only for a
 * state the hub accepted (a `state_invalid` writes nothing).
 */
export async function connectCallback(c: ConnectCtx): Promise<Response> {
  const memberId = inhouseMember(c)
  if (!memberId) return apiError('forbidden')
  const q = new URL(c.request.url).searchParams
  const state = q.get('state')
  const code = q.get('code')
  const error = q.get('error')
  const hub = gateway(c)

  let outcome: ConnectOutcome
  let confirmed: string | null = null
  if (error !== null) {
    const r = await hub.failConnect(scope(c), { state: state ?? '', memberId, error: error.slice(0, 512) })
    if (r.ok && r.value.accountId) {
      outcome = 'connect_refused'
      confirmed = r.value.accountId
    } else outcome = r.ok ? 'state_invalid' : asOutcome(r.error.code)
  } else if (!state || !code) {
    outcome = 'state_invalid'
  } else {
    const r = await hub.completeConnect(scope(c), { state, code, memberId })
    outcome = r.ok ? 'ok' : asOutcome(r.error.code)
    if (r.ok) confirmed = r.value.accountId
    // Any answer but these means the hub took the state's item, which names the prefix's account.
    else if (outcome !== 'state_invalid' && outcome !== 'invalid_args') confirmed = stateAccountHint(state)
  }

  if (confirmed) {
    const last = outcome === 'ok' ? 'connected' : await hubLastState(c, confirmed)
    await storesOf(c).connectors.connectEnded(confirmed, connectorOf(confirmed), outcome, last, writer(c))
  }
  const account = confirmed ?? stateAccountHint(state)
  if (outcome === 'ok' && account) return redirect(`/tools/${connectorOf(account)}?connected=1`)
  return redirect(account ? `/tools/${connectorOf(account)}?connect_error=${outcome}` : `/tools?connect_error=${outcome}`)
}

/** A hub code from the closed list, else `internal` (never a string from elsewhere). */
const asOutcome = (code: unknown): ConnectOutcome => {
  const parsed = ConnectOutcomeSchema.safeParse(code)
  return parsed.success && parsed.data !== 'ok' ? parsed.data : 'internal'
}
