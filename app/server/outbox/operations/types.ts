// Stage 1 M2 (frozen by W0-A; M2-A fills the table, N9): one entry per write operation. The server types its table as
// `OperationTable` (each entry typed by its own key), so it and the hub's `WRITE_OPERATIONS` can't drift. Types only.
import type { z } from 'zod'
import type { WriteOperationKey } from '../../../hub/index/contract.ts'
import type { ResolveFacts } from '../../permissions/types.ts'

export type { WriteOperationKey }

/** What an operation can do beyond its own record. Any flag set means an exact approval (N9). */
export interface Effects { money: boolean; customer: boolean; destructive: boolean; access: boolean }

/**
 * A money amount in the shop's minor units (cents for USD, yen for JPY) and its ISO 4217 currency, upper case (N21).
 * Shown on the card, bound by the payload hash (it's in the arguments) and sent as it is.
 */
export interface MoneyAmount { minor: number; currency: string }

/**
 * Stage 1 M3 (N24): an operation's suggested limits. `perDay` and `unitsMax` are a new grant's ("Always allow"), always
 * under the ceiling; `ceiling` is what the Inhouse team's screen suggests for a new ceiling row. Nothing is seeded from
 * them. An operation no grant can cover (an effect flag set, so every call is exact) still names values; they're unused.
 */
export interface OperationDefaults {
  perDay: number
  unitsMax: number
  ceiling: { perDayMax: number; unitsMax: number }
}

export interface OperationEntry<A = unknown> {
  key: WriteOperationKey
  /** The tool name the agent calls: 'shopify_order_tag_add', 'slack_channel_post'. */
  tool: string
  /** What the actions server lists. */
  description: string
  /** Strict. */
  args: z.ZodType<A>
  connector: 'shopify' | 'slack'
  scope(a: A, f: ResolveFacts): Record<string, string> | { refuse: 'not_listed' }
  /** Records the call touches: more than the ceiling's `bulk_threshold` is an exact approval (`bulk`). */
  records(a: A): number
  /** What the daily count and `units_max` count (orders, stock units, minor currency units, posts). */
  units(a: A): number
  /** Stage 1 M3 (N21): what `units` counts, in the person's words: "orders", "stock units", "dollars", "posts". */
  unitsLabel: string
  /**
   * Stage 1 M3 (N21, N22): a multi-record call's items, one hub call each, in order. Each item is the operation's own
   * arguments for one record (so the strict `args`, `records`, `units` and the hub's own check apply to it unchanged),
   * and the items' units add up to the call's. Absent for an operation whose call is always one record (one hub call).
   */
  items?(a: A): A[]
  /**
   * Stage 1 M3 (N21): one item's line on a batch card and in the full list: its destination and material arguments, in
   * server words ("Order 1042 (store-a): add VIP, rush"). For a single-record operation the item is the call itself.
   */
  itemLine(item: A, f: ResolveFacts): string
  /** Stage 1 M3 (N21): a money operation's amount, shown, bound and sent. Absent for an operation that moves no money. */
  amount?(a: A, f: ResolveFacts): MoneyAmount
  effects: Effects
  /** False: a member's call is an exact card for any active admin (N25; refused `needs_admin` until M3-X). */
  memberMay: boolean
  reversible: boolean
  /** M2: no automatic resend. */
  idempotent: false
  /**
   * Stage 1 M3 (N22): whether calls of this kind may collect into one batch card (a 6th waiting card, or a call past its
   * grant's count). False for any money or destructive operation: its 6th waiting card in a chat is refused
   * `too_many_waiting` instead.
   */
  coalesces: boolean
  /** Stage 1 M3 (N24): suggested limits for a new grant and a new ceiling row. */
  defaults: OperationDefaults
  /** Server words only. */
  card(a: A, f: ResolveFacts): { title: string; lines: string[] }
}

/** One entry per operation, each under its own key (`entry.key` is its record key). */
export type OperationTable = { readonly [K in WriteOperationKey]: OperationEntry & { key: K } }
