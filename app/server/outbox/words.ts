// The outbox's words (N11, N14, N18): what the agent reads when a request is refused, and what a card says about a
// lapse or an outcome. Server words only: never connector output, never the model's text.
import type { LapseReason } from './sql.ts'
import type { OutboxRefuseReason } from './types.ts'

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
}

/** A needs-check row's words on its card. */
export const NEEDS_CHECK_TEXT = 'It isn’t clear whether this went out. Check in the tool, then say whether it did.'
/** A failed row's words: the hub's code in plain words is the audit text's; the card keeps it short. */
export const FAILED_TEXT = 'It didn’t go out.'
export const SENT_TEXT = 'Sent.'
