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
  [NOTICE.paused]: "Your Inhouse agent is paused, so it can't answer questions until an Admin resumes it.",
  [NOTICE.poolBusy]: 'Your Inhouse agent is busy, so this answer starts in a moment.',
} as const

/** Route 39 refuses a file name over 230 UTF-8 bytes (bad name). */
export const ATTACHMENT_NAME_MAX_BYTES = 230
/** The server's name rule (route 39): at most 200 characters (UTF-16 units) and 230 bytes, and a name `encodeURIComponent` can encode (no lone surrogate), since it travels in a header. */
export const attachmentNameTooLong = (name: string): boolean => {
  if (name.length > 200 || new TextEncoder().encode(name).length > ATTACHMENT_NAME_MAX_BYTES) return true
  try { encodeURIComponent(name); return false } catch { return true }
}
/** Why a name is refused: said on the file's chip and when the agent refuses a send with it (about 76 characters of Chinese, Japanese or Korean at 3 bytes each). */
export const ATTACHMENT_NAME_TOO_LONG = 'The name is too long. Keep it under 200 letters or numbers, or about 76 characters in Chinese, Japanese or Korean.'
export const NO_MODEL_NOTE = 'No model yet. An Admin turns one on in Settings.'

/** What a turn says when its model was switched off: the failed turn and the refused send (turn-text.ts). The failed line offers "Pick another model" when its text is one of these. */
export const MODEL_OFF_FAILED = "The model for this answer is switched off, so it didn't run. Pick another model and ask again."
export const MODEL_OFF_REFUSED = 'Your team turned this model off. Pick another and ask again.'
export const MODEL_OFF_TEXTS: readonly string[] = [MODEL_OFF_FAILED, MODEL_OFF_REFUSED]

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

/**
 * What a chat shows: its stored history in the order the agent stored it (by position), then the sample turns (a chat has
 * one or the other), then what happened in this tab that the history doesn't hold yet. A message is keyed by its stable id
 * (`<turnId>.u`, `<turnId>.<n>`), so one the history and the live stream both carry shows once, at its stored place; a reloaded
 * chat can therefore order its messages differently from the live stream that showed them first, and the stored order is the
 * one that stays.
 */
export function mergeHistory(history: readonly ChatMessage[] | undefined, seed: readonly ChatMessage[], extras: readonly ChatMessage[]): ChatMessage[] {
  if (!history?.length) return seed.length ? [...seed, ...extras] : [...extras]
  const stored = new Set(history.map(m => m.id))
  return [...history, ...seed, ...extras.filter(m => !stored.has(m.id))]
}

/**
 * Whether opening chat `id` reads its history from the agent: the chat is one the agent has and has no sample turns. An unknown
 * id (a stale or typed link, a deleted chat) reads nothing: the app's own "That chat isn't available" notice is the one answer,
 * and a read that fails with the same words would be a second toast for one navigation.
 */
export const historyWanted = (chats: readonly { id: string; turns: readonly unknown[] }[], id: string | null): boolean => {
  if (id === null) return false
  const thread = chats.find(c => c.id === id)
  return thread !== undefined && thread.turns.length === 0
}

/** A chat with nothing in it yet. */
export const emptyView = (): ChatView => ({ messages: [], queued: [], turns: {}, live: null, thinking: null, liveSteps: [], notice: null, budgetWait: false, damaged: false, openRuns: [], files: [], job: null, pendingEnd: null })
