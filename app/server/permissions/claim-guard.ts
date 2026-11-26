// `claimGuardSql` (N9, N11): `decideCore`'s rules as one SQL condition on an `outbox_actions` row, for the outbox's
// claim (a conditional update to `sending`). It checks again, at the claim, everything a decision rested on:
//  - the operation is still enabled in the ceiling, and the row was made under the current policy;
//  - the account's generation is unchanged (`connector_accounts.connected_at_ms`, and no disconnect since);
//  - the asker is still an active person whose role may do the operation;
//  - for Slack, the channel is still listed;
//  - and either (a) `grant_id` set: not a routine's action, no guardrail (no effect flag, at most 5 records), the grant
//    live and covering (decide.ts `covers`), and an unreleased use row for this action and revision; or (b) no grant:
//    the approver is still an active person whose role may do the operation.
// The outbox adds its own gate checks (state, revision, hold, epoch, pause generation). Every value is a bound parameter
// or a column; `alias` must be a plain SQL identifier. decide.property.test.ts checks this against `decideCore` on
// random D1 states.
import { OPERATION_KEYS, OPERATIONS } from '../outbox/operations/index.ts'
import type { OperationEntry, WriteOperationKey } from '../outbox/operations/types.ts'
import { BULK_RECORDS, POLICY_REV } from './policy.ts'

const list = (n: number) => Array.from({ length: n }, () => '?').join(', ')
/** `col IN (...)` over a possibly empty list (SQLite takes `IN ()`, but say what's meant). */
const inList = (col: string, keys: readonly string[]) => (keys.length === 0 ? '0' : `${col} IN (${list(keys.length)})`)

/** The flags the guard reads from each operation's entry. */
export type GuardTable = Readonly<Record<WriteOperationKey, Pick<OperationEntry, 'memberMay' | 'effects' | 'connector'>>>

/** `table` is the real operation table; the differential test passes made-up flags so every branch runs. */
export function claimGuardSql(alias: string, table: GuardTable = OPERATIONS): { sql: string; params: unknown[] } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('claimGuardSql: alias must be a plain identifier')
  const a = alias
  const memberMay = OPERATION_KEYS.filter(k => table[k].memberMay)
  const effectful = OPERATION_KEYS.filter(k => Object.values(table[k].effects).some(Boolean))
  const slack = OPERATION_KEYS.filter(k => table[k].connector === 'slack')
  const may = (m: string) => `(${m}.role = 'admin' OR ${inList(`${a}.operation`, memberMay)})`
  const sql = `(
  EXISTS (SELECT 1 FROM permission_ceiling pc WHERE pc.operation = ${a}.operation AND pc.enabled = 1)
  AND ${a}.policy_rev = ?
  AND EXISTS (SELECT 1 FROM connector_accounts ca WHERE ca.account_id = ${a}.account_id AND ca.connected_at_ms = ${a}.account_gen
    AND (ca.disconnected_at_ms IS NULL OR ca.disconnected_at_ms < ca.connected_at_ms))
  AND EXISTS (SELECT 1 FROM members am WHERE am.id = ${a}.asked_by AND am.kind = 'person' AND am.status = 'active' AND ${may('am')})
  AND (NOT ${inList(`${a}.operation`, slack)} OR EXISTS (SELECT 1 FROM notify_channels nc
    WHERE nc.channel_id = json_extract(${a}.scope_json, '$.channelId') AND nc.removed_at_ms IS NULL))
  AND (
    (${a}.grant_id IS NOT NULL AND ${a}.origin <> 'routine' AND ${a}.records <= ? AND NOT ${inList(`${a}.operation`, effectful)}
      AND EXISTS (SELECT 1 FROM permission_grants g
        JOIN permission_ceiling gc ON gc.operation = g.operation AND gc.enabled = 1
        JOIN members gm ON gm.id = ${a}.asked_by
        WHERE g.id = ${a}.grant_id AND g.revoked_at_ms IS NULL AND g.account_id = ${a}.account_id
          AND g.account_gen = ${a}.account_gen AND g.operation = ${a}.operation AND g.scope_key = ${a}.scope_key
          AND g.ceiling_rev = gc.lowered_rev AND g.policy_rev = ?
          AND ((g.holder = 'member:' || ${a}.asked_by AND (gm.role = 'admin' OR g.granted_role = 'member'))
            OR (g.holder = 'brand' AND g.granted_role = 'admin')))
      AND EXISTS (SELECT 1 FROM permission_uses u WHERE u.action_id = ${a}.id AND u.action_rev = ${a}.rev
        AND u.grant_id = ${a}.grant_id AND u.released_at_ms IS NULL))
    OR (${a}.grant_id IS NULL AND EXISTS (SELECT 1 FROM members ap WHERE ap.id = ${a}.approved_by AND ap.kind = 'person'
      AND ap.status = 'active' AND ${may('ap')}))
  )
)`
  // Parameters in the order their `?` appear above.
  const params: unknown[] = [
    POLICY_REV,
    ...memberMay,
    ...slack,
    BULK_RECORDS, ...effectful, POLICY_REV,
    ...memberMay,
  ]
  return { sql, params }
}
