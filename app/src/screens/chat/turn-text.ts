// The words the chat says about a turn's end and about the agent's state. One file, so the reducer, the store and the
// tests name each string once. House voice: contractions, no dashes, plain.
import type { TurnFailure } from '../../../shared/contract/runs'
import { CANCEL, FAIL, NOTICE } from '../../../shared/contract/chat-codes'
import { RATE_LIMITED, REASON } from '../../../shared/contract/error-codes'

export const STOPPED_NOTE = 'You stopped your Inhouse agent. Nothing was changed.'
export const RELOAD_NOTE = 'Your Inhouse agent stopped when the page reloaded. Nothing was changed.'
export const RUN_FAILED = "Your Inhouse agent couldn't finish this answer. Nothing was changed."

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

/** A notice that comes with a run (the `notice` event). */
export const NOTICE_TEXT = {
  [NOTICE.mirrorError]: "This chat's memory couldn't be saved, so it can't go on. Start it fresh to keep asking.",
  [NOTICE.sessionDamaged]: "This chat's memory couldn't be saved, so it can't go on. Start it fresh to keep asking.",
  [NOTICE.capReached]: 'Your team has reached its spending cap.',
  [NOTICE.budgetBusy]: "You're close to your spending cap, so this answer is waiting for others to finish",
  [NOTICE.paused]: 'Your Inhouse agent is paused. Questions wait until an Admin resumes it.',
  [NOTICE.poolBusy]: 'Your Inhouse agent is busy, so this answer starts in a moment.',
} as const

/** Why a turn that was waiting never ran. Null: nothing to say (the person removed or deleted it). */
export const CANCELLED_TEXT: Record<(typeof CANCEL)[keyof typeof CANCEL], string | null> = {
  [CANCEL.paused]: 'Your Inhouse agent was paused, so this question was not asked.',
  [CANCEL.removed]: null,
  [CANCEL.deleted]: null,
  [CANCEL.capReached]: FAILURE_TEXT[FAIL.capReached],
  [CANCEL.poolFull]: FAILURE_TEXT[FAIL.poolFull],
  [CANCEL.sessionUnusable]: "This chat's memory couldn't be saved, so this question was not asked.",
}

/** Route 39 refuses a file name over 230 UTF-8 bytes (bad name). */
export const ATTACHMENT_NAME_MAX_BYTES = 230
export const attachmentNameTooLong = (name: string): boolean => new TextEncoder().encode(name).length > ATTACHMENT_NAME_MAX_BYTES
/** Why a name is refused: said on the file's chip and when the agent refuses a send with it (about 76 characters of Chinese, Japanese or Korean at 3 bytes each). */
export const ATTACHMENT_NAME_TOO_LONG = 'The name is too long. Keep it under 230 letters or numbers, or about 76 characters in Chinese, Japanese or Korean.'
export const NO_MODEL_NOTE = 'No model yet. An Admin turns one on in Settings.'

/** No model is on for the team (route 38), so Send waits. */
export const NO_MODEL_YET = 'No model yet'
export const NO_MODEL_TEXT = "Your team hasn't turned on a model yet, so there's nothing to answer with."

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

export const CONNECTION_TEXT = {
  held: 'Reconnecting. Your answer keeps going.',
  reload: 'Inhouse has been updated. Reload the page to go on.',
  grantEnded: "Inhouse support access ended, so this chat is no longer shown.",
} as const
