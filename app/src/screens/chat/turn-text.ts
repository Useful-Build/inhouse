// The words the chat says about a turn's end and about a refused send. Loads with the first send (run.ts); the notes and
// notices that show without a run are in notes.ts. House voice: contractions, no dashes, plain.
import type { TurnFailure } from '../../../shared/contract/runs'
import { CANCEL, FAIL, NOTICE } from '../../../shared/contract/chat-codes'
import { ATTACHMENT_NAME_TOO_LONG, NOTICE_TEXT, RUN_FAILED } from './notes'
import { RATE_LIMITED, REASON } from '../../../shared/contract/error-codes'

/** Why a failed turn failed, in the person's words. */
export const FAILURE_TEXT: Record<TurnFailure, string> = {
  [FAIL.sessionCrashed]: RUN_FAILED,
  [FAIL.protocol]: RUN_FAILED,
  [FAIL.store]: RUN_FAILED,
  [FAIL.files]: "Your Inhouse agent couldn't save a file it made, so it stopped. Nothing was changed.",
  [FAIL.timeout]: 'This answer took too long, so your Inhouse agent stopped it. Nothing was changed.',
  [FAIL.sdkError]: RUN_FAILED,
  [FAIL.maxTurns]: 'This answer needed more steps than your team allows, so it stopped. Ask again, or raise the limit in Settings.',
  [FAIL.turnBudget]: 'This answer reached the spending limit for one answer, so it stopped.',
  [FAIL.capReached]: "Your team has reached its spending cap, so this answer didn't run.",
  [FAIL.budgetBusy]: "This answer waited for others to finish and didn't get its turn. Try again in a minute.",
  [FAIL.poolFull]: 'Your Inhouse agent is busy right now. Try again in a moment.',
  [FAIL.unknown]: RUN_FAILED,
}

/** Why a turn that was waiting never ran. Null: nothing to say (the person removed or deleted it). */
export const CANCELLED_TEXT: Record<(typeof CANCEL)[keyof typeof CANCEL], string | null> = {
  [CANCEL.paused]: 'Your Inhouse agent was paused, so this question was not asked.',
  [CANCEL.removed]: null,
  [CANCEL.deleted]: null,
  [CANCEL.capReached]: FAILURE_TEXT[FAIL.capReached],
  [CANCEL.poolFull]: FAILURE_TEXT[FAIL.poolFull],
  [CANCEL.sessionUnusable]: "This chat's memory couldn't be saved, so this question was not asked.",
}

/** Why the agent refused a send, in the person's words (the reason when there is one, else the code). */
export function sendFailureText(e: { code: string; reason?: string }): string {
  switch (e.reason) {
    case REASON.paused: return NOTICE_TEXT[NOTICE.paused]
    case REASON.modelOff: return 'Your team turned this model off. Pick another and ask again.'
    case REASON.sessionDamaged: return NOTICE_TEXT[NOTICE.sessionDamaged]
    case REASON.waitingAnswer: return 'This chat is waiting for an answer from you first.'
    case REASON.queueFull: return 'Too many messages are waiting in this chat. Ask again when some have been answered.'
    case REASON.draining: return 'Inhouse is restarting. Ask again in a minute.'
    case REASON.removed: return "You're no longer on this team."
    case REASON.badName: return ATTACHMENT_NAME_TOO_LONG
    default: return e.code === RATE_LIMITED ? 'Too many messages at once. Ask again in a minute.' : RUN_FAILED
  }
}

