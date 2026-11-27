// The outbox's words (N11, N14, N18): what the agent reads when a request is refused, and what a card says about a
// lapse or an outcome. Server words only: never connector output, never the model's text.
import type { LapseReason } from './sql.ts'
import type { OutboxRefuseReason } from './types.ts'
// #487: what a partly-sent call stores beside its `needs_check` (`result_json`), read by shared/partial-send.ts.
import type { PartialGroups } from '../../shared/partial-send.ts'

/** The plain refusal the agent reads (`request` wrote nothing). */
export const REFUSAL_TEXT: Readonly<Record<OutboxRefuseReason, string>> = {
  unknown_operation: 'That action isn’t one Inhouse can take.',
  invalid_args: 'The details of that action aren’t valid, so nothing was asked or sent.',
  over_ceiling: 'This kind of action is turned off for this brand, so nothing was asked or sent.',
  account_unavailable: 'The tool for that action isn’t connected, or it’s paused, so nothing was asked or sent.',
  not_listed: 'That Slack channel isn’t one the brand listed, so nothing was asked or sent.',
  needs_admin: 'Only an admin can approve this kind of action, so nothing was asked or sent.',
  no_one_to_ask: 'There’s no one to ask for an approval here, so nothing was asked or sent.',
  invocation_conflict: 'That call was already made with other details, so nothing new was asked or sent.',
  chat_deleted: 'This chat was deleted, so nothing was asked or sent.',
  // Stage 1 M3-A (N23, N22, N26): nothing returns these before M3-L, M3-B and M3-C.
  over_limit: 'That’s over the limit the Inhouse team set for this kind of action, so nothing was asked or sent.',
  batch_full: 'The waiting list for this kind of action is full, so nothing was asked or sent. Wait for an answer on it first.',
  too_many_waiting: 'Five of these are already waiting for an answer in this chat, so nothing was asked or sent. Wait for an answer first.',
  writes_off: 'Changing what the agent can do is switched off in this build, so nothing changed.',
  busy: 'Many changes like this one arrived at once, so this one wasn’t added. Nothing was asked or sent; try it once more.',
}

/** Why an approval lapsed, as the card says it. */
export const LAPSE_TEXT: Readonly<Record<LapseReason, string>> = {
  paused: 'The agent was paused, so this needs your OK again.',
  restore_hold: 'The brand’s data was being restored, so this needs your OK again.',
  expired: 'No one answered in 7 days.',
  over_ceiling: 'This kind of action was turned off, so this needs your OK again.',
  policy_changed: 'The rules changed, so this needs your OK again.',
  account_changed: 'The tool’s connection changed, so this needs your OK again.',
  asker_removed: 'The person who asked left the team.',
  approver_not_allowed: 'The approver can no longer approve this, so it needs an OK again.',
  channel_not_listed: 'The channel isn’t listed any more, so this needs your OK again.',
  permission_removed: 'The permission was removed, so this needs your OK again.',
  count: 'Today’s allowance for this permission is used up, so this needs your OK.',
  stale_approval: 'It wasn’t sent in time after the OK, so it needs your OK again.',
  chat_deleted: 'The chat it was asked in was deleted.',
  // Stage 1 M3-A (N23): nothing lapses for it before M3-L.
  over_limit: 'It’s over the limit the Inhouse team set now, so it can’t be approved as it is.',
}

/**
 * Why an approval was withdrawn rather than sent back: the stored action can never pass again (its account generation
 * or its policy revision is gone), so asking again would only loop. The agent can propose it afresh.
 */
export const WITHDRAWN_TEXT: Readonly<Partial<Record<LapseReason, string>>> = {
  account_changed: 'The tool’s connection changed, so this was withdrawn. Ask the agent to propose it again.',
  policy_changed: 'The rules changed, so this was withdrawn. Ask the agent to propose it again.',
  asker_removed: 'The person who asked left the team, so this was withdrawn.',
  chat_deleted: 'The chat it was asked in was deleted, so this was withdrawn.',
  over_limit: 'It’s over the limit the Inhouse team set now, so this was withdrawn. Ask the agent to propose it again within the limit.',
}

/** A needs-check row's words on its card. */
export const NEEDS_CHECK_TEXT = 'It isn’t clear whether this went out. Check in the tool, then say whether it did.'

/** Stage 1 M3-X (N25): whom an admins card waits for, as its asker's card says it. */
export const WAITING_FOR_ADMIN = 'an admin'


const orderList = (nums: readonly string[]) => `${nums.length === 1 ? 'Order' : 'Orders'} ${nums.join(', ')}`

/** #487: the groups in words: "Orders 9001, 9002 went out. Order 424242 was refused. Order 9003 is unclear." */
export function partialText(g: PartialGroups): string {
  const parts: string[] = []
  if (g.sent.length > 0) parts.push(`${orderList(g.sent)} went out.`)
  if (g.refused.length > 0) parts.push(`${orderList(g.refused)} ${g.refused.length === 1 ? 'was' : 'were'} refused.`)
  if (g.unclear.length > 0) parts.push(`${orderList(g.unclear)} ${g.unclear.length === 1 ? 'is' : 'are'} unclear.`)
  return parts.join(' ')
}

/**
 * A needs-check row's (or item's) words, with the groups a partly-sent call stored (#487) when there are any: "Part of
 * this went out. Orders 9001, 9002 went out. Order 424242 was refused. Check in the tool, then say whether it did."
 */
export function needsCheckText(resultJson: string | null): string {
  const partial = resultJson ? (JSON.parse(resultJson) as { partial?: PartialGroups }).partial : undefined
  if (!partial) return NEEDS_CHECK_TEXT
  return `${partial.sent.length > 0 ? 'Part of this went out. ' : ''}${partialText(partial)} Check in the tool, then say whether it went out.`
}
/** A failed row's words: the hub's code in plain words is the audit text's; the card keeps it short. */
export const FAILED_TEXT = 'It didn’t go out.'
export const SENT_TEXT = 'Sent.'

/**
 * Stage 1 M3-B (N22): the title a collecting card (or the rest of a batch moved to a new card) stores, for the words that
 * read the stored card (the resume turn names it): "Changes in Shopify (Store A)".
 */
export const batchStoredTitle = (label: string): string => `Changes in ${label}`

/**
 * Stage 1 M3-B (N22): a batch card's title when it isn't one call's own (a collecting card, or the rest of one moved to a
 * new card). Its lines and totals carry the details.
 */
export const batchTitle = (items: number, label: string): string => `${items} ${items === 1 ? 'change' : 'changes'} in ${label}`

/**
 * Stage 1 M3-B (#501): a batch that stopped before any of it went out, every item moved to a new card, as its card says
 * it ("Nothing here went out. Its changes moved to a new card. The agent was paused, so this needs your OK again.").
 */
export const batchMovedText = (why: string): string => `Nothing here went out. Its changes moved to a new card. ${why}`

/**
 * Stage 1 M3-B (N22): a batch that stopped part way, to its approver: what went out, and where the rest is now ("Paused:
 * 12 of 40 went out; the other 28 need a new OK").
 */
export function batchStoppedText(p: { sent: number; total: number; left: number; moved: boolean; why: string }): string {
  const rest = p.moved
    ? `The other ${p.left} ${p.left === 1 ? 'needs' : 'need'} a new OK on a new card.`
    : `The other ${p.left} ${p.left === 1 ? 'was' : 'were'} withdrawn.`
  return `${p.sent} of ${p.total} went out before this stopped. ${rest} ${p.why}`
}

/** Stage 1 M3 (#575): a draft-order card's note when the store couldn't be read for its products. */
export const PRODUCTS_UNREAD_TEXT = 'Product names couldn’t be read.'
