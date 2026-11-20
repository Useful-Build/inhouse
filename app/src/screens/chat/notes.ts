// The words the chat shows without any run code: the notes a stopped answer leaves, the notices, the connection and file name
// texts, and `upsert`. Small on purpose: the store and the screens take this on the first load, while the reducer and the
// words about a turn's end (turn-text.ts, view.ts) load with the first send (run.ts). House voice: contractions, no dashes.
import type { ChatMessage } from '../../agent/types'
import type { ChatView } from './view'
import { NOTICE } from '../../../shared/contract/chat-codes'

export const STOPPED_NOTE = 'You stopped your Inhouse agent. Nothing was changed.'
export const RELOAD_NOTE = 'Your Inhouse agent stopped when the page reloaded. Nothing was changed.'
export const RUN_FAILED = "Your Inhouse agent couldn't finish this answer. Nothing was changed."

/** A notice that comes with a run (the `notice` event). */
export const NOTICE_TEXT = {
  [NOTICE.mirrorError]: "This chat's memory couldn't be saved, so it can't go on. Start it fresh to keep asking.",
  [NOTICE.sessionDamaged]: "This chat's memory couldn't be saved, so it can't go on. Start it fresh to keep asking.",
  [NOTICE.capReached]: 'Your team has reached its spending cap.',
  [NOTICE.budgetBusy]: "You're close to your spending cap, so this answer is waiting for others to finish",
  [NOTICE.paused]: 'Your Inhouse agent is paused. Questions wait until an Admin resumes it.',
  [NOTICE.poolBusy]: 'Your Inhouse agent is busy, so this answer starts in a moment.',
} as const

/** Route 39 refuses a file name over 230 UTF-8 bytes (bad name). */
export const ATTACHMENT_NAME_MAX_BYTES = 230
export const attachmentNameTooLong = (name: string): boolean => new TextEncoder().encode(name).length > ATTACHMENT_NAME_MAX_BYTES
/** Why a name is refused: said on the file's chip and when the agent refuses a send with it (about 76 characters of Chinese, Japanese or Korean at 3 bytes each). */
export const ATTACHMENT_NAME_TOO_LONG = 'The name is too long. Keep it under 230 letters or numbers, or about 76 characters in Chinese, Japanese or Korean.'
export const NO_MODEL_NOTE = 'No model yet. An Admin turns one on in Settings.'

/** No model is on for the team (route 38), so Send waits. */
export const NO_MODEL_YET = 'No model yet'
export const NO_MODEL_TEXT = "Your team hasn't turned on a model yet, so there's nothing to answer with."

export const CONNECTION_TEXT = {
  held: 'Reconnecting. Your answer keeps going.',
  reload: 'Inhouse has been updated. Reload the page to go on.',
  grantEnded: "Inhouse support access ended, so this chat is no longer shown.",
} as const

/** Adds a message, or replaces the one with its id where it stands (a stable id never doubles a message). */
export function upsert(messages: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const i = messages.findIndex(x => x.id === m.id)
  if (i < 0) return [...messages, m]
  const next = messages.slice()
  next[i] = m
  return next
}

/** A chat with nothing in it yet. */
export const emptyView = (): ChatView => ({ messages: [], queued: [], turns: {}, live: null, thinking: null, notice: null, budgetWait: false, damaged: false, openRuns: [], files: [] })
