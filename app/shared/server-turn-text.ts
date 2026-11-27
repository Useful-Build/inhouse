// What the chat shows for a turn the server wrote itself (Stage 1, N3 and N20): a long job's continuation, an action's
// result coming back, a question's answer resuming the agent. None is the person's own message, so none ever shows in
// their bubble or as their words: the live view (src/screens/chat/view.ts) and a reloaded chat (server/db/chats.ts)
// both read these, so the two say the same thing with the same id. House voice: contractions, no dashes.
import { FAIL } from './contract/chat-codes.ts'

/** The `turns.source` of a turn the person didn't type (core.ts). A person's own turn is `person`. */
export type ServerTurnSource = 'job' | 'action' | 'question'

export const SERVER_TURN_SOURCES: readonly ServerTurnSource[] = ['job', 'action', 'question']

/** A long job's continuation: the agent went on by itself (no button, nothing to answer). */
export const JOB_CARRIED_ON_TEXT = 'Your Inhouse agent carried on with this task by itself.'

/** An action's resume turn: the agent picked the chat up again once the action it proposed was settled. */
export const ACTION_CARRIED_ON_TEXT = 'Your Inhouse agent went on once the action was settled.'

/**
 * What the chat shows in place of a server-written turn's text, or null for nothing at all. A question's resume has
 * no text (the answer shows on the question's own card), so it shows nothing.
 */
export function serverTurnText(source: ServerTurnSource): string | null {
  switch (source) {
    case 'job': return JOB_CARRIED_ON_TEXT
    case 'action': return ACTION_CARRIED_ON_TEXT
    case 'question': return null
  }
}

export const isServerTurnSource = (s: unknown): s is ServerTurnSource => SERVER_TURN_SOURCES.includes(s as ServerTurnSource)

/**
 * The failures of a long job's continuation the thread still shows (with Try again asking the person's own question):
 * the ones that end the job `failed` whatever happens next (jobs/rules.ts `judge`). Every other failure is the job's to
 * carry on from, retry or end for its budget, and its progress row and result card say so; a timeout too, since only the
 * server knows whether a cut came first. The live view (view.ts) and the history projection (projection.ts) both read it.
 */
export const JOB_TURN_FAILURES_SHOWN: ReadonlySet<string> = new Set([FAIL.sdkError, FAIL.modelOff, FAIL.structuredOutput, FAIL.files])
