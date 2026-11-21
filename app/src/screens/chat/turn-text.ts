// The words the chat says about a turn's end and about a refused send. Loads with the first send (run.ts); the notes and
// notices that show without a run are in notes.ts. House voice: contractions, no dashes, plain.
import type { TurnFailure } from '../../../shared/contract/runs'
import type { StoredMessage } from '../../../shared/contract/chats'
import type { ChatMessage } from '../../agent/types'
import { CANCEL, FAIL, NOTICE } from '../../../shared/contract/chat-codes'
import { ATTACHMENT_NAME_TOO_LONG, MODEL_OFF_FAILED, MODEL_OFF_REFUSED, NOTICE_TEXT, RUN_FAILED } from './notes'
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
  [FAIL.modelOff]: MODEL_OFF_FAILED,
  // Only a routine's run asks for structured output (P4), and no person's chat shows one: the generic words.
  [FAIL.structuredOutput]: RUN_FAILED,
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

/**
 * A stored history page in the words the live stream used. A turn's end row (the server's projection.ts) becomes the
 * message its live `turn.finished` or `turn.cancelled` showed (view.ts), with the same id, so the two show once; one with
 * nothing to say is left out. Every other message is kept as it is.
 */
export function historyMessages(page: readonly StoredMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of page) {
    if (m.role !== 'event' || m.end === undefined) {
      out.push(m)
    } else if ('failure' in m.end) {
      out.push({ id: m.id, role: 'agent', trace: m.turnId, at: m.at, part: { type: 'error', text: FAILURE_TEXT[m.end.failure] ?? RUN_FAILED, retryQuestion: m.end.retryQuestion } })
    } else {
      const text = CANCELLED_TEXT[m.end.why]
      if (text !== null) out.push({ id: m.id, role: 'event', text })
    }
  }
  return out
}

/** Why the agent refused a send, in the person's words (the reason when there is one, else the code). */
export function sendFailureText(e: { code: string; reason?: string }): string {
  switch (e.reason) {
    case REASON.paused: return NOTICE_TEXT[NOTICE.paused]
    case REASON.modelOff: return MODEL_OFF_REFUSED
    case REASON.sessionDamaged: return NOTICE_TEXT[NOTICE.sessionDamaged]
    case REASON.waitingAnswer: return 'This chat is waiting for an answer from you first.'
    case REASON.queueFull: return 'Too many messages are waiting in this chat. Ask again when some have been answered.'
    case REASON.draining: return 'Inhouse is restarting. Ask again in a minute.'
    case REASON.removed: return "You're no longer on this team."
    case REASON.badName: return ATTACHMENT_NAME_TOO_LONG
    default: return e.code === RATE_LIMITED ? 'Too many messages at once. Ask again in a minute.' : RUN_FAILED
  }
}

