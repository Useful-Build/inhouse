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

export type Verdict =
  | { verdict: 'run'; grantId: string }
  | { verdict: 'ask'; nudge: boolean }
  | { verdict: 'exact'; guardrail: Guardrail }
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
}

/** A Slack channel the admin listed (`notify_channels`, not removed). */
export interface ListedChannel { id: string; name: string }

/** What `resolve` reads before it decides anything. */
export interface ResolveFacts {
  nowMs: number
  accounts: Readonly<Record<'shopify' | 'slack', ConnectedAccountFacts | null>>
  listedChannels: readonly ListedChannel[]
}

/** One operation's row in `permission_ceiling`. A missing row means the operation doesn't exist for the brand (N2). */
export interface CeilingFacts { enabled: boolean; perDayMax: number; loweredRev: number }

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

/** Async: `payloadHash` uses WebCrypto's digest (changed by M2-A; no call site existed). */
export type ResolveFn = (f: ResolveFacts, p: Proposed) => Promise<Resolved | { refuse: RefuseVerdict }>
export type DecideCoreFn = (f: DecideFacts, ctx: DecideCtx, r: Resolved) => Verdict
export type ClaimGuardSqlFn = (alias: string) => { sql: string; params: unknown[] }
