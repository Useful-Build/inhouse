// What `request` reads before it resolves and decides (N9, N10): the brand's connected accounts, its listed Slack
// channels, the ceiling, the grants that might cover the action and the "Allow once" count. D1 holds the account's
// generation (`connector_accounts.connected_at_ms`, the hub's own date copied in by M2-D's sync) and the Shopify write
// store's handle (`connector_accounts.shop`, likewise); the hub's SignIn state holds its pause and label, so those come
// through `hubAccounts` (the caller's binding; N12: the hub checks them again at the send).
import { all, first, stmt } from '../db/sql.ts'
import { memberHolder } from '../permissions/decide.ts'
import { NUDGE_WINDOW_MS } from '../permissions/policy.ts'
import type { CeilingFacts, ConnectedAccountFacts, DecideCtx, DecideFacts, GrantFacts, Resolved, ResolveFacts, WriteOperationKey } from '../permissions/types.ts'
import { knownZone } from '../routines/brand.ts'
import { DEFAULT_TZ } from '../usage/month.ts'

/** The one account per connector Stage 1 writes to (the hub's account ids). */
export const ACCOUNT_IDS = { shopify: 'shopify:store', slack: 'slack:workspace' } as const

/**
 * What the hub says about one account now: paused (or not active, which refuses the same way), and the label a person
 * reads. The shop handle and the generation are D1's (`connector_accounts`), copied from the hub by M2-D's sync.
 */
export interface HubAccountFacts { accountId: string; paused: boolean; label: string }

export interface OutboxFacts {
  resolveFacts(nowMs: number): Promise<ResolveFacts>
  decideFacts(r: Resolved, ctx: DecideCtx): Promise<DecideFacts>
}

/** The brand's time zone (`g:tz`), for the day a use counts toward (N10). A stored value no runtime knows throws. */
export async function brandTimeZone(db: D1Database): Promise<string> {
  const row = await first<{ value_json: string }>(db, stmt("SELECT value_json FROM settings WHERE owner = 'brand' AND key = 'g:tz'"))
  if (!row) return DEFAULT_TZ
  const v: unknown = JSON.parse(row.value_json)
  if (v === null) return DEFAULT_TZ
  if (typeof v !== 'string' || !knownZone(v)) throw new Error('outbox: the brand time zone is not one this runtime knows')
  return v
}

type AccountRow = { account_id: string; last_state: string; connected_at_ms: number | null; disconnected_at_ms: number | null; shop: string | null; currency: string | null }
type CeilingRow = {
  operation: WriteOperationKey; enabled: number; per_day_max: number; lowered_rev: number; units_max: number; bulk_threshold: number; batch_max: number; rev: number
}
type GrantRow = {
  id: string; holder: string; account_id: string; account_gen: number; operation: WriteOperationKey; scope_key: string; per_day: number; units_max: number
  policy_rev: number; granted_role: 'member' | 'admin'; ceiling_rev: number; revoked_at_ms: number | null
}

const DEFAULT_LABEL = { shopify: 'Shopify', slack: 'Slack' } as const

function accountFacts(connector: 'shopify' | 'slack', row: AccountRow | undefined, hub: HubAccountFacts | undefined): ConnectedAccountFacts | null {
  if (!row) return null
  // Connected now: the last state says so and no disconnect came after the connect (claim-guard.ts checks the same).
  const connected = row.last_state === 'connected' && row.connected_at_ms !== null
    && (row.disconnected_at_ms === null || row.disconnected_at_ms < row.connected_at_ms)
  return {
    accountId: row.account_id,
    connectedAtMs: row.connected_at_ms,
    connected,
    // An account the hub didn't name is treated as paused: refused, never assumed open.
    paused: hub ? hub.paused : true,
    label: hub?.label ?? DEFAULT_LABEL[connector],
    shop: connector === 'shopify' ? row.shop : null,
    // Stage 1 M3-S2: the write store's currency, copied from the hub like the handle (0790).
    currency: connector === 'shopify' ? row.currency : null,
  }
}

export function outboxFacts(d: { db: D1Database; hubAccounts: () => Promise<readonly HubAccountFacts[]> }): OutboxFacts {
  const { db } = d
  return {
    async resolveFacts(nowMs) {
      // The hub's word first: reading it copies the hub's connection date and shop into `connector_accounts` (M2-D), so
      // the rows are read only after that write, never beside it (the first request after a connect would see the old row).
      const hub = await d.hubAccounts()
      const [rows, channels] = await Promise.all([
        all<AccountRow>(db, stmt('SELECT account_id, last_state, connected_at_ms, disconnected_at_ms, shop, currency FROM connector_accounts WHERE account_id IN (?, ?)', ACCOUNT_IDS.shopify, ACCOUNT_IDS.slack)),
        all<{ channel_id: string; name: string }>(db, stmt('SELECT channel_id, name FROM notify_channels WHERE removed_at_ms IS NULL ORDER BY channel_id')),
      ])
      const row = (id: string) => rows.find(r => r.account_id === id)
      const hubOf = (id: string) => hub.find(h => h.accountId === id)
      return {
        nowMs,
        accounts: {
          shopify: accountFacts('shopify', row(ACCOUNT_IDS.shopify), hubOf(ACCOUNT_IDS.shopify)),
          slack: accountFacts('slack', row(ACCOUNT_IDS.slack), hubOf(ACCOUNT_IDS.slack)),
        },
        listedChannels: channels.map(c => ({ id: c.channel_id, name: c.name })),
      }
    },

    async decideFacts(r, ctx) {
      const holders = ctx.asker ? [memberHolder(ctx.asker.memberId), 'brand'] : ['brand']
      const [ceilings, grants, once] = await Promise.all([
        all<CeilingRow>(db, stmt('SELECT operation, enabled, per_day_max, lowered_rev, units_max, bulk_threshold, batch_max, rev FROM permission_ceiling')),
        all<GrantRow>(db, stmt(
          `SELECT id, holder, account_id, account_gen, operation, scope_key, per_day, units_max, policy_rev, granted_role, ceiling_rev, revoked_at_ms
           FROM permission_grants WHERE revoked_at_ms IS NULL AND operation = ? AND account_id = ? AND holder IN (${holders.map(() => '?').join(', ')})`,
          r.operation, r.accountId, ...holders,
        )),
        // "Allow once" answers: an `ask` card this member approved for this operation and scope, with no grant.
        ctx.asker
          ? first<{ n: number }>(db, stmt(
            `SELECT COUNT(*) AS n FROM outbox_actions WHERE asked_by = ? AND approved_by = ? AND operation = ? AND scope_key = ?
               AND verdict = 'ask' AND grant_id IS NULL AND approved_at_ms >= ?`,
            ctx.asker.memberId, ctx.asker.memberId, r.operation, r.scopeKey, ctx.nowMs - NUDGE_WINDOW_MS,
          ))
          : Promise.resolve({ n: 0 }),
      ])
      const ceiling: Partial<Record<WriteOperationKey, CeilingFacts>> = {}
      for (const c of ceilings) {
        ceiling[c.operation] = {
          enabled: c.enabled === 1, perDayMax: c.per_day_max, loweredRev: c.lowered_rev, unitsMax: c.units_max, bulkThreshold: c.bulk_threshold,
          batchMax: c.batch_max, rev: c.rev,
        }
      }
      return {
        ceiling,
        grants: grants.map((g): GrantFacts => ({
          id: g.id, holder: g.holder, accountId: g.account_id, accountGen: g.account_gen, operation: g.operation, scopeKey: g.scope_key,
          perDay: g.per_day, unitsMax: g.units_max, policyRev: g.policy_rev, grantedRole: g.granted_role, ceilingRev: g.ceiling_rev,
          revokedAtMs: g.revoked_at_ms,
        })),
        allowOnceCount: once?.n ?? 0,
      }
    },
  }
}
