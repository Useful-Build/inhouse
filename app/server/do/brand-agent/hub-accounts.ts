// The hub's word on the brand's write accounts (Stage 1 M2-D, N9), read inside BrandAgent: the runner's egress holds no
// hub binding but ReadGateway (the P5 import boundary), so the write path asks the object (`BrandAgentRpc.hubAccounts`).
// The hub is the authority on a connection (it owns the sign-in): its `connectedAt` and the Shopify write store's handle
// are copied into `connector_accounts` (db/connector-accounts.ts `syncFromHub`), where `resolve`, the claim and the
// dispatcher's `expect.connectedAtMs` read them. The binding's answer is copied out and released, never kept.
import { z } from 'zod'
import type { CallerScope, ConnectGateway } from '../../../hub/index/contract.ts'
import { connectorAccountStore } from '../../db/connector-accounts.ts'
import { SYSTEM_MEMBER_ID } from '../../db/ids.ts'
import { ACCOUNT_IDS } from '../../outbox/facts.ts'
import type { HubAccountFacts } from '../../outbox/facts.ts'
import { safeError } from '../../safe-error.ts'

const AccountsAnswer = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.array(z.object({
      accountId: z.string(), connector: z.string(),
      status: z.object({ state: z.string(), paused: z.boolean(), connectedAt: z.object({ ms: z.number().int().nonnegative() }).nullable() }),
      shop: z.string().optional(),
    })),
  }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
])

/** `Symbol.dispose` (the runtime has it; this project's TypeScript lib doesn't name it yet). */
const DISPOSE = (Symbol as unknown as { dispose?: symbol }).dispose

/**
 * An RPC answer's plain data, and its disposer run: Workers RPC gives every object an RPC returns a disposer, and until
 * it runs the call's context stays open (outbox/dispatch.ts found it kept BrandAgent from going idle). Nothing from the
 * binding is kept but the copy. https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 */
export function rpcPlain(value: unknown): unknown {
  let copy: unknown
  try {
    const text = JSON.stringify(value)
    copy = text === undefined ? undefined : JSON.parse(text)
  } catch {
    copy = undefined
  }
  if (typeof value === 'object' && value !== null && DISPOSE !== undefined) {
    const dispose = (value as Record<symbol, unknown>)[DISPOSE]
    if (typeof dispose === 'function') (dispose as () => void).call(value)
  }
  return copy
}

const LABEL: Readonly<Record<'shopify' | 'slack', string>> = { shopify: 'Shopify', slack: 'Slack' }

/**
 * The hub's word on the brand's write accounts, read now (ConnectGateway.listAccounts), and its connection date and
 * Shopify store handle copied into `connector_accounts` (N9; the hub is the authority: it owns the sign-in). Answers each
 * account's pause and label for `resolve`; an account the hub doesn't call active is answered as paused, so a write on it
 * is refused (`account_unavailable`). An answer that can't be read answers nothing: every account is then refused.
 */
export async function hubAccountFacts(d: {
  connect: Pick<ConnectGateway, 'listAccounts'>; db: D1Database; nowMs: number; requestId: string; log(e: Record<string, unknown>): void
}): Promise<HubAccountFacts[]> {
  const scope: CallerScope = { kind: 'server', job: 'actions.accounts', requestId: d.requestId }
  let raw: unknown
  try {
    raw = rpcPlain(await d.connect.listAccounts(scope))
  } catch (err) {
    d.log({ event: 'actions_accounts_unreadable', why: 'threw', error: safeError(err) })
    return []
  }
  const parsed = AccountsAnswer.safeParse(raw)
  if (!parsed.success || !parsed.data.ok) {
    d.log({ event: 'actions_accounts_unreadable', why: parsed.success ? 'hub_error' : 'malformed' })
    return []
  }
  const accounts = connectorAccountStore({ db: d.db })
  const out: HubAccountFacts[] = []
  for (const connector of ['shopify', 'slack'] as const) {
    const a = parsed.data.value.find(x => x.accountId === ACCOUNT_IDS[connector])
    if (!a) continue
    const active = a.status.state === 'active' && a.status.connectedAt !== null
    if (active) {
      await accounts.syncFromHub(a.accountId, connector, { connectedAtMs: a.status.connectedAt!.ms, shop: connector === 'shopify' ? a.shop ?? null : null },
        { actorId: SYSTEM_MEMBER_ID, requestId: d.requestId, nowMs: d.nowMs })
    }
    out.push({ accountId: a.accountId, paused: a.status.paused || !active, label: LABEL[connector] })
  }
  return out
}

