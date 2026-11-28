// Stage 1 M2 (frozen by W0-A; M2-A fills the table, N9): one entry per write operation. The server types its table as
// `OperationTable` (each entry typed by its own key), so it and the hub's `WRITE_OPERATIONS` can't drift. Types only.
import type { z } from 'zod'
import type { WriteOperationKey } from '../../../hub/index/contract.ts'
import type { ActionDetail } from '../../../shared/contract/actions.ts'
import type { ResolveFacts } from '../../permissions/types.ts'
import type { CardFactsView, FactsWanted } from '../detail.ts'

export type { WriteOperationKey }

/** What an operation can do beyond its own record. Any flag set means an exact approval (N9). */
export interface Effects { money: boolean; customer: boolean; destructive: boolean; access: boolean }

/**
 * A money amount in the shop's minor units (cents for USD, yen for JPY) and its ISO 4217 currency, upper case (N21).
 * Shown on the card, bound by the payload hash (it's in the arguments) and sent as it is.
 */
export interface MoneyAmount { minor: number; currency: string }

/** Stage 1 M3 (N24): a new grant's limits ("Always allow"), always under the ceiling. */
export interface GrantDefaults { perDay: number; unitsMax: number }

/**
 * Stage 1 M3 (N24): an operation's suggested limits. `grant`: a new grant's, or null for an operation no grant can cover
 * (any effect flag set, so every call is an exact approval; N24 leaves those blank). `ceiling`: what the Inhouse team's
 * screen suggests for a new ceiling row. Nothing is seeded from either.
 */
export interface OperationDefaults {
  grant: GrantDefaults | null
  ceiling: { perDayMax: number; unitsMax: number }
}

/** What every entry has, whatever it can do. */
export interface OperationBase<A> {
  key: WriteOperationKey
  /** The tool name the agent calls: 'shopify_order_tag_add', 'slack_channel_post'. */
  tool: string
  /** What the actions server lists. */
  description: string
  /** Strict. */
  args: z.ZodType<A>
  connector: 'shopify' | 'slack'
  /**
   * The permission scope, or the refusal `resolve` gives: `not_listed` (the channel or other target isn't one the brand
   * listed); Stage 1 M3-S2: `invalid_args` (an argument the brand's account can't take, such as a refund in another
   * currency than the shop's) and `account_unavailable` (the account lacks a fact the operation needs, such as the shop's
   * currency).
   */
  scope(a: A, f: ResolveFacts): Record<string, string> | { refuse: 'not_listed' | 'invalid_args' | 'account_unavailable' }
  /** Records the call touches: more than the ceiling's `bulk_threshold` is an exact approval (`bulk`). */
  records(a: A): number
  /** What the daily count and `units_max` count (orders, stock units, minor currency units, posts). */
  units(a: A): number
  /**
   * Stage 1 M3 (N21): what `units` counts, in the person's words: "orders", "stock units", "posts". A money operation's
   * units are the shop's minor currency units, shown through `amount` and the shop's currency, never by this label.
   */
  unitsLabel: string
  /**
   * Stage 1 M3 (N21, N22): how one call over the bulk threshold (or a multi-record call under a grant) splits into a
   * batch's items, one hub call each, in order. Each item is the operation's own arguments for one record (so the
   * strict `args`, `records`, `units` and the hub's own check apply to it unchanged), and the items' units add up to
   * the call's. Absent for an operation whose call is always one record. A call that joins a collecting batch is never
   * split: it is one item holding the whole call (at most `bulk_threshold` records), one hub call (`OutboxItemRow`).
   */
  items?(a: A): A[]
  /**
   * Stage 1 M3 (N21): one item's line on a batch card and in the full list: its destination and every material argument,
   * in server words ("Order 1042 (store-a): add VIP, rush"). Nothing a person approves may be cut from it.
   */
  itemLine(item: A, f: ResolveFacts): string
  /**
   * Stage 1 M3 (card details, #488): the store records a card of this call names, for the facts a person sees beside the
   * ids (detail.ts). Absent for an operation with none to read (a Slack post, a stock change).
   */
  facts?(a: A): FactsWanted
  /**
   * Stage 1 M3 (card details): the call's (or one item's) detail rows from the store's answer, or null when it didn't
   * answer for every id. Display only: never part of `card`, `itemLine` or anything else the agent reads.
   */
  detail?(a: A, f: CardFactsView): ActionDetail | null
  /**
   * Stage 1 M3 (#575): the quiet note a card shows when the store couldn't be read for this call ("Product names couldn't
   * be read."), in place of rows. Absent: no note (the card shows its ids only). The request goes ahead either way.
   */
  unreadNote?: string
  /**
   * Stage 1 M3-U (N33): one item as a row of the batch card and its full list: the record, the change and, where it has
   * one, its amount or quantity. Server words; the item's `line` stays the full form. Every operation that coalesces
   * defines it (operations.test.ts).
   */
  itemRow?(item: A): { ref: string; change: string; amount?: string }
  /**
   * Stage 1 M3-U: the rows' column heads, in the person's words, for an operation whose batch shows as a table (its rows
   * carry quantities or money: stock). Left out, the batch is a plain list, whatever its rows carry.
   */
  rowHeads?: { ref: string; change: string; amount: string }
  /**
   * Stage 1 M3-U (N33): a batch card's title, what happens with its count ("Tag 450 orders as VIP"). `same` is an item's
   * arguments when every item of the batch has the same value at `titleKey` (a JSON path, such as the tags), else null.
   */
  batchTitle?(c: { records: number; units: number }, same: A | null): string
  titleKey?: string
  /** M2: no automatic resend. */
  idempotent: false
  /** Server words only. */
  card(a: A, f: ResolveFacts): { title: string; lines: string[] }
}

/** Neither money nor a destructive effect. */
type Harmless = Effects & { money: false; destructive: false }

/**
 * Stage 1 M3 (section 0, N21, N22, N25): what an operation's effects and approver force, checked by the compiler (and
 * again over the table in operations.test.ts). Money, destructive and admin-only (`memberMay: false`) operations never
 * coalesce, so no batch ever needs an admin and none moves money; money defines `amount`; destructive isn't reversible;
 * money and destructive name no grant defaults.
 *
 * - `memberMay`: false means a member's call is an exact card for any active admin (N25, M3-X).
 * - `coalesces` (N22): whether calls of this kind may collect into one batch card (a 6th waiting card, or a call past its
 *   grant's count). When false, the 6th waiting card of the kind in a chat is refused `too_many_waiting`.
 * - `amount` (N21): a money operation's amount, shown, bound and sent.
 */
export type OperationClass<A> =
  | { effects: Harmless; memberMay: true; reversible: boolean; coalesces: boolean; amount?: undefined; defaults: OperationDefaults }
  | { effects: Harmless; memberMay: false; reversible: boolean; coalesces: false; amount?: undefined; defaults: OperationDefaults }
  | { effects: Effects & { money: true; destructive: false }; memberMay: boolean; reversible: boolean; coalesces: false; amount(a: A, f: ResolveFacts): MoneyAmount; defaults: OperationDefaults & { grant: null } }
  | { effects: Effects & { money: false; destructive: true }; memberMay: boolean; reversible: false; coalesces: false; amount?: undefined; defaults: OperationDefaults & { grant: null } }
  | { effects: Effects & { money: true; destructive: true }; memberMay: boolean; reversible: false; coalesces: false; amount(a: A, f: ResolveFacts): MoneyAmount; defaults: OperationDefaults & { grant: null } }

export type OperationEntry<A = unknown> = OperationBase<A> & OperationClass<A>

/** One entry per operation, each under its own key (`entry.key` is its record key). */
export type OperationTable = { readonly [K in WriteOperationKey]: OperationEntry & { key: K } }
