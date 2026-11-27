// Stage 1 M2 (frozen by W0-A; M2-A builds on it, N9 and N10): what `resolve` and `decideCore` take and give. Types only.
// The model supplies an operation (by its tool name) and arguments; the server derives everything else. `decideCore` is
// pure and property-tested; `claimGuardSql` states the same rules for the outbox's claim.
import type { WriteOperationKey } from '../../hub/index/contract.ts'
import type { Guardrail } from '../../shared/contract/permissions.ts'
import type { MemberRole } from '../../shared/contract/members.ts'
import type { Effects } from '../outbox/operations/types.ts'

export type { Guardrail, WriteOperationKey }

/** Where a proposal comes from: a person's chat turn, a job's turn, or a routine's. */
export type Origin = 'chat' | 'job' | 'routine'

/** The member an action would be asked of. Null for a system routine (no one to ask). */
export interface Asker { memberId: string; role: MemberRole }

export interface DecideCtx { asker: Asker | null; origin: Origin; chatId: string; nowMs: number }

/** What the model proposed: the operation its tool names, and the raw arguments. */
export interface Proposed { operation: WriteOperationKey; args: unknown }

/**
 * A proposal the server resolved: the account and its generation from the brand's connected account (never from the
 * arguments), the scope and counts from the operation's entry. `payloadHash` is SHA-256 of the canonical JSON of
 * operation, account, generation, scope and parsed arguments; `policyRev` is a code constant.
 */
export interface Resolved {
  operation: WriteOperationKey
  args: unknown
  accountId: string
  accountGen: number
  scope: Record<string, string>
  scopeKey: string
  records: number
  units: number
  effects: Effects
  memberMay: boolean
  payloadHash: string
  policyRev: number
}

export type RefuseReason =
  | 'unknown_operation'
  | 'invalid_args'
  | 'over_ceiling'
  | 'account_unavailable'
  | 'not_listed'
  | 'needs_admin'
  | 'no_one_to_ask'
  // Stage 1 M3 (N23, N22, N26). `over_limit`: one call's units are past the ceiling's `units_max` ("over the limit the
  // Inhouse team set"). `batch_full`: the open batch for this kind holds `batch_max` items. `too_many_waiting`: a 6th
  // waiting card of an operation that never collects (money, destructive) in one chat. `writes_off`: a ceiling change
  // while editing is off in a deployable build (`CEILING_EDIT_ON = false`).
  | 'over_limit'
  | 'batch_full'
  | 'too_many_waiting'
  | 'writes_off'

export type Verdict =
  | { verdict: 'run'; grantId: string }
  | { verdict: 'ask'; nudge: boolean }
  /**
   * `approver` (Stage 1 M3, N25): `asker` is M2's card, answered by the person who asked; `admins` is a card any active
   * admin answers (a member asked for an operation with `memberMay: false`, from M3-X).
   */
  | { verdict: 'exact'; guardrail: Guardrail; approver: 'asker' | 'admins' }
  | { verdict: 'refuse'; reason: RefuseReason }

export type RefuseVerdict = Extract<Verdict, { verdict: 'refuse' }>

/** The brand's connected account for one connector, as `resolve` reads it (`connector_accounts` plus the hub's pause). */
export interface ConnectedAccountFacts {
  accountId: string
  /** `connector_accounts.connected_at_ms`: the account's generation. Null when never connected. */
  connectedAtMs: number | null
  connected: boolean
  paused: boolean
  /** The tool as a person reads it: "Shopify (Store A)". */
  label: string
  /** Shopify only: the shop handle (`<handle>.myshopify.com`), `shopify.order.tag_add`'s scope `{ shop }`. Null otherwise. */
  shop: string | null
  /**
   * Stage 1 M3 (N21): Shopify only, the shop's currency (ISO 4217, upper case), from the hub's connect/status answer and
   * copied into `connector_accounts` like the shop handle (M3-S2). A refund in any other currency is refused at
   * `resolve`. Null otherwise, and until M3-S2 copies it.
   */
  currency: string | null
}

/** A Slack channel the admin listed (`notify_channels`, not removed). */
export interface ListedChannel { id: string; name: string }

/** What `resolve` reads before it decides anything. */
export interface ResolveFacts {
  nowMs: number
  accounts: Readonly<Record<'shopify' | 'slack', ConnectedAccountFacts | null>>
  listedChannels: readonly ListedChannel[]
}

/**
 * One operation's row in `permission_ceiling`. A missing row means the operation doesn't exist for the brand (N2).
 * Stage 1 M3 (N23, 0760): `unitsMax` is the largest single call (one item) whatever approves it; `bulkThreshold` the
 * most records one call touches before it's an exact approval (1 to 5); `batchMax` the most items in one batch (1 to
 * 500); `rev` the row's revision for the screen's `ifRev`.
 */
export interface CeilingFacts {
  enabled: boolean
  perDayMax: number
  loweredRev: number
  unitsMax: number
  bulkThreshold: number
  batchMax: number
  rev: number
}

/** A grant that might cover the resolved action (`permission_grants`); `decideCore` itself skips a revoked one (`revokedAtMs`). */
export interface GrantFacts {
  id: string
  /** `member:<id>` or `brand`. */
  holder: string
  accountId: string
  accountGen: number
  operation: WriteOperationKey
  scopeKey: string
  perDay: number
  /** Stage 1 M3 (N23, 0760): the largest single call this grant lets run. A bigger one is an exact `count` card. */
  unitsMax: number
  policyRev: number
  grantedRole: MemberRole
  ceilingRev: number
  /** Null while live. `decideCore` treats a set value as no grant, whatever the caller's query did. */
  revokedAtMs: number | null
}

/** What `decideCore` reads: the ceiling, the grants for this operation and account, and the nudge count. */
export interface DecideFacts {
  ceiling: Readonly<Partial<Record<WriteOperationKey, CeilingFacts>>>
  grants: readonly GrantFacts[]
  /** This member's "Allow once" answers for the same operation and scope in the last 30 days. */
  allowOnceCount: number
}

/**
 * Stage 1 M3 (N22, N23; M3-L owns the table and the daily sum): one batch item's units given back from its batch's one
 * grant use, at most once per item and approval (`UNIQUE (action_id, action_rev, n)`; 0760 keys the row by one column,
 * `id = <action_id>#<action_rev>#<n>`, for retention, as `permission_uses`): the item failed definitely, moved to a new
 * card, or was withdrawn. `reserveUseSql`'s daily sum subtracts these while their use is unreleased; `releaseItemSql`
 * writes them.
 */
export interface PermissionItemReleaseRow {
  action_id: string
  action_rev: number
  n: number
  units: number
  reason: 'failed' | 'moved' | 'withdrawn'
  at_ms: number
}

/** Async: `payloadHash` uses WebCrypto's digest (changed by M2-A; no call site existed). */
export type ResolveFn = (f: ResolveFacts, p: Proposed) => Promise<Resolved | { refuse: RefuseVerdict }>
export type DecideCoreFn = (f: DecideFacts, ctx: DecideCtx, r: Resolved) => Verdict
export type ClaimGuardSqlFn = (alias: string) => { sql: string; params: unknown[] }
