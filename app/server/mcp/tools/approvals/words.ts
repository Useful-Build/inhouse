// What the approval tools say to the agent (M2-E). Fixed texts only: never connector output and never the model's own
// words read back as fact. Ids and states go in after them; a card's title and lines (the server's own words, N18) go
// only in the structured data.
import type { ActionState } from '../../../../shared/contract/actions.ts'

/** Each state as the agent reads it after "It's" or "The approval is". */
export const STATE_WORDS: Readonly<Record<ActionState, string>> = {
  waiting: "waiting for the person's answer in Approvals",
  approved: 'approved and in its short hold, when the person can still undo it',
  sending: 'being sent',
  sent: 'sent',
  failed: "finished, and it didn't go out",
  needs_check: "unclear whether it went out, so the person is asked to check",
  undone: 'undone by the person before it went out',
  denied: 'declined by the person',
  withdrawn: 'withdrawn',
  expired: 'expired: no one answered in 7 days',
}

export const TEXT = {
  /** The tools aren't wired into this build yet (M2-D wires `approval_request` with its admission). */
  notSwitchedOn: "Asking for approval from chat isn't switched on yet, so nothing was asked or sent. Tell the person you can't put this in Approvals yet.",
  /** M2-D's admission found no matching call of this tool by the main agent in this turn. */
  notAdmitted: "That call couldn't be matched to this turn, so nothing was asked or sent.",
  /** The chat's owner isn't an active person on the team. */
  noPerson: "There's no one to ask for an approval here, so nothing was asked or sent.",
  made: (id: string) => `It's in Approvals for the person to answer (approval_id: ${id}). Nothing goes out unless they approve it. This doesn't wait for the answer: check it later with approval_get.`,
  alreadyWaiting: (id: string) => `The same action is already waiting in Approvals, so no second card was made (approval_id: ${id}). Check it with approval_get.`,
  replay: (id: string, state: ActionState) => `This call already made approval ${id}. It's ${STATE_WORDS[state]}.`,
  /** Stage 1 M3-B: a collecting batch holds other calls' items too, so the agent can't withdraw it whole. */
  batch: "That approval holds other calls too, so it can't be withdrawn from here. The person can answer it in Approvals.",
  /**
   * Stage 1 M3-B (N22): the request joined one card with other changes like it (the 6th waiting of its kind in this
   * chat, or past what its permission allows). The approval id is the card's; the item is this request's place on it.
   */
  collected: (id: string, n: number) =>
    `It's in Approvals on one card with other changes like it (approval_id: ${id}, item ${n}). Nothing goes out unless the person approves it. This doesn't wait for the answer: check it later with approval_get.`,
  notFound: "There's no approval with that approval_id for this person. Use approval_list to see theirs.",
  status: (id: string, state: ActionState) => `Approval ${id} is ${STATE_WORDS[state]}.`,
  none: 'No approvals match.',
  listed: (n: number) => `${n} approval${n === 1 ? '' : 's'}, newest first.`,
  otherChat: 'That approval was asked for in another chat, so it can only be taken back there. The person can still say No to it in Approvals.',
  notWaiting: (id: string, state: ActionState) => `Approval ${id} is ${STATE_WORDS[state]}, so there's nothing to take back.`,
  changed: 'That approval changed just now, so it was not withdrawn. Check it with approval_get.',
  withdrawn: (id: string) => `Approval ${id} is withdrawn. Nothing from it will go out.`,
} as const
