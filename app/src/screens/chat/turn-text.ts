// The words the chat says about a turn's end and about a refused send. Loads with the first send (run.ts); the notes and
// notices that show without a run are in notes.ts. House voice: contractions, no dashes, plain.
import type { TurnFailure } from '../../../shared/contract/runs'
import type { FileRefusalReason } from '../../../shared/contract/attachments'
import type { StoredMessage } from '../../../shared/contract/chats'
import type { ChatMessage } from '../../agent/types'
import { CANCEL, FAIL, NOTICE } from '../../../shared/contract/chat-codes'
import { ATTACHMENT_NAME_TOO_LONG, MODEL_OFF_FAILED, MODEL_OFF_REFUSED, NOTICE_TEXT, RUN_FAILED, STOPPED_NOTE } from './notes'
import { FILE_REFUSAL, RATE_LIMITED, REASON } from '../../../shared/contract/error-codes'

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

/** A file the agent made that wasn't saved (the `file.refused` event), with its name. */
export function fileRefusedText(name: string, reason: FileRefusalReason): string {
  const made = `Your Inhouse agent made ${name}, but`
  switch (reason) {
    case FILE_REFUSAL.tooLarge: return `${made} it wasn't saved because it's too big.`
    case FILE_REFUSAL.tooMany: return `${made} it wasn't saved because this answer made too many files.`
    case FILE_REFUSAL.typeNotAllowed: return `${made} it wasn't saved because your team doesn't allow that type of file.`
    case FILE_REFUSAL.saveFailed: return `${made} it couldn't be saved. Ask again to try once more.`
    case FILE_REFUSAL.badName: return `${made} it wasn't saved because its name can't be used.`
  }
}

/** The most left-out files a note names; the rest are counted. */
const LEFT_OUT_NAMED = 5

/** The runner's last `leftOut` entry past its cap (runner files.ts `capLeftOut`): how many more there were. A path never looks like it (it starts with its folder). */
const MORE_TAIL = /^and (\d+) more$/

/** The chat's earlier files a run couldn't bring back (the `files.restored` event's `leftOut`), named without their folder. */
export function filesLeftOutText(leftOut: readonly string[]): string {
  const tail = MORE_TAIL.exec(leftOut.at(-1) ?? '')
  const paths = tail ? leftOut.slice(0, -1) : leftOut
  const names = paths.slice(0, LEFT_OUT_NAMED).map(p => p.replace(/^(inputs|outputs)\//, ''))
  const more = paths.length - names.length + (tail ? Number(tail[1]) : 0)
  const list = more > 0 ? `${names.join(', ')} and ${more} more` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  return `Some of this chat's earlier files were too big to bring back together, so your Inhouse agent can't use these in this answer: ${list}.`
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
 * message its live `turn.finished` or `turn.cancelled` showed (view.ts: the failure, the stopped note or the cancel note), with the same id, so the two show once; one with
 * nothing to say is left out. Every other message is kept as it is.
 */
export function historyMessages(page: readonly StoredMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of page) {
    if (m.role !== 'event' || m.end === undefined) {
      out.push(m)
    } else if ('failure' in m.end) {
      out.push({ id: m.id, role: 'agent', trace: m.turnId, at: m.at, part: { type: 'error', text: FAILURE_TEXT[m.end.failure] ?? RUN_FAILED, retryQuestion: m.end.retryQuestion } })
    } else if ('outcome' in m.end) {
      out.push({ id: m.id, role: 'event', text: STOPPED_NOTE })
    } else {
      const text = CANCELLED_TEXT[m.end.why]
      if (text != null) out.push({ id: m.id, role: 'event', text })
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
    case REASON.providerChanged: return "This chat was started with a different AI provider, so it can't go on here. Start a new chat to keep asking."
    case REASON.queueFull: return 'Too many messages are waiting in this chat. Ask again when some have been answered.'
    case REASON.draining: return 'Inhouse is restarting. Ask again in a minute.'
    case REASON.removed: return "You're no longer on this team."
    case REASON.badName: return ATTACHMENT_NAME_TOO_LONG
    default: return e.code === RATE_LIMITED ? 'Too many messages at once. Ask again in a minute.' : RUN_FAILED
  }
}

