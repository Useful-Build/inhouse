// A chat's live view, built from its run events (p3-design section 2). A pure reducer: the same events in the same order
// give the same view, so a replay after a reconnect or a reload shows what the live stream showed. Messages are keyed
// by their stable ids (`<turnId>.u`, `<turnId>.<n>`), so an event seen twice never doubles a message.
// Ids the view makes itself from a turn's end event: `<turnId>.f` a failed turn's answer, `<turnId>.x` a note. The server
// stores the same ids as the turn's end row (projection.ts), and turn-text.ts `historyMessages` words it the same way.
import type { Attachment, AttachmentRef, ChatMessage, Instant } from '../../agent/types'
import type { ChatEvent, TurnFailure } from '../../../shared/contract/runs'
import { NOTICE } from '../../../shared/contract/chat-codes'
import { NOTICE_TEXT, RUN_FAILED, STOPPED_NOTE, emptyView, upsert } from './notes'
import { CANCELLED_TEXT, FAILURE_TEXT } from './turn-text'

export type NoticeCode = Extract<ChatEvent, { type: 'notice' }>['code']

/** A message sent into the chat that waits for its turn. It joins the messages when its turn starts. */
export interface QueuedTurn { turnId: string; messageId: string; text: string; quote?: string; atts: Attachment[]; priority: 'now' | 'next' | 'later' }

export type TurnState = 'queued' | 'live' | 'done' | 'interrupted' | 'stopped' | 'failed' | 'cancelled'
export interface TurnInfo { turnId: string; runId: string; state: TurnState; text: string; quote?: string; atts: Attachment[]; failure?: TurnFailure }

export interface ChatView {
  messages: ChatMessage[]
  queued: QueuedTurn[]
  turns: Record<string, TurnInfo>
  /** The turn being answered now. */
  live: string | null
  /** The newest step's label while a turn is live ("Reading your question…"). */
  thinking: string | null
  /** The latest notice that still holds, as its text. Cleared when a turn starts or the run ends. */
  notice: { code: NoticeCode; text: string } | null
  /** A turn waits for others to finish because of the spending cap (the budget is busy): shown as waiting, not failed. */
  budgetWait: boolean
  /** The chat's session can't go on (the notices for a damaged session or a failed mirror): sends are refused until `resetSession`. */
  damaged: boolean
  /** Runs that started and haven't finished. */
  openRuns: string[]
  files: { turnId: string; fileId: string; name: string; bytes: number; contentType: string }[]
}

export { emptyView }

/** What the composer knew about each file it sent (its size line and icon), by name: the run's events carry only the name. */
const attachmentCatalog = new Map<string, Attachment>()
export const rememberAttachments = (atts: readonly Attachment[]) => { for (const a of atts) attachmentCatalog.set(a.name, a) }
const attOf = (name: string): Attachment => attachmentCatalog.get(name) ?? { name, meta: '', icon: 'description' }

/** A file the demo's composer holds, as the send names it. A real upload names its own `fileId` (the next PR); this one is stable per name. */
export function refOf(a: Attachment): AttachmentRef {
  let h = 2166136261
  const bytes = new TextEncoder().encode(a.name)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
  let id = ''
  for (let i = 0; i < 22; i++) {
    for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0
    h = Math.imul(h ^ (i + 1), 16777619) >>> 0
    id += chars[h % 64]
  }
  return { fileId: `f_${id}`, name: a.name }
}

const userMessage = (t: TurnInfo, messageId: string): ChatMessage => ({
  id: messageId, role: 'user', text: t.text, ...(t.quote !== undefined ? { quote: t.quote } : {}), ...(t.atts.length ? { atts: t.atts } : {}),
})
const withoutTurn = (q: QueuedTurn[], turnId: string) => q.filter(x => x.turnId !== turnId)
const setTurn = (v: ChatView, turnId: string, patch: Partial<TurnInfo>): ChatView['turns'] => {
  const t = v.turns[turnId]
  return t ? { ...v.turns, [turnId]: { ...t, ...patch } } : v.turns
}

/** `at`: when the frame was sent (a note's time). Returns the same view object when the event changes nothing. */
export function reduce(v: ChatView, ev: ChatEvent, at: Instant, runId = ''): ChatView {
  switch (ev.type) {
    case 'run.started':
      return v.openRuns.includes(ev.runId) ? v : { ...v, openRuns: [...v.openRuns, ev.runId] }
    case 'turn.queued': {
      if (v.turns[ev.turnId]) return v
      const atts = ev.attachments.map(a => attOf(a.name))
      const info: TurnInfo = { turnId: ev.turnId, runId, state: 'queued', text: ev.text, ...(ev.quote !== undefined ? { quote: ev.quote } : {}), atts }
      const q: QueuedTurn = { turnId: ev.turnId, messageId: ev.messageId, text: ev.text, ...(ev.quote !== undefined ? { quote: ev.quote } : {}), atts, priority: ev.priority }
      return { ...v, turns: { ...v.turns, [ev.turnId]: info }, queued: [...v.queued, q] }
    }
    case 'turn.started': {
      const t = v.turns[ev.turnId]
      if (!t) return v
      const msgId = v.queued.find(x => x.turnId === ev.turnId)?.messageId ?? `${ev.turnId}.u`
      return {
        ...v, live: ev.turnId, thinking: 'Reading your question…', notice: null, budgetWait: false,
        turns: setTurn(v, ev.turnId, { state: 'live' }), queued: withoutTurn(v.queued, ev.turnId), messages: upsert(v.messages, userMessage(t, msgId)),
      }
    }
    case 'part':
      return { ...v, messages: upsert(v.messages, { id: ev.messageId, role: 'agent', part: ev.part, trace: ev.turnId, model: ev.model, at: ev.at }) }
    case 'step':
      return v.live === ev.turnId ? { ...v, thinking: ev.label } : v
    case 'file':
      return v.files.some(f => f.fileId === ev.fileId) ? v : { ...v, files: [...v.files, { turnId: ev.turnId, fileId: ev.fileId, name: ev.name, bytes: ev.bytes, contentType: ev.contentType }] }
    case 'file.refused':
    case 'files.restored':
      return v
    case 'turn.finished': {
      const t = v.turns[ev.turnId]
      if (!t || t.state === 'done' || t.state === 'interrupted' || t.state === 'stopped' || t.state === 'failed') return v
      const state: TurnState = ev.outcome
      let messages = v.messages
      // A turn that ended before it started (a failure at the claim) still shows what was asked.
      if (t.state === 'queued') messages = upsert(messages, userMessage(t, v.queued.find(x => x.turnId === ev.turnId)?.messageId ?? `${ev.turnId}.u`))
      if (ev.outcome === 'failed') {
        const reason = ev.reason ?? 'unknown'
        messages = upsert(messages, { id: `${ev.turnId}.f`, role: 'agent', trace: ev.turnId, at, part: { type: 'error', text: FAILURE_TEXT[reason] ?? RUN_FAILED, retryQuestion: t.text } })
      } else if (ev.outcome === 'interrupted' || ev.outcome === 'stopped') {
        messages = upsert(messages, { id: `${ev.turnId}.x`, role: 'event', text: STOPPED_NOTE })
      }
      return {
        ...v, messages, queued: withoutTurn(v.queued, ev.turnId), live: v.live === ev.turnId ? null : v.live, thinking: v.live === ev.turnId ? null : v.thinking,
        budgetWait: false, turns: setTurn(v, ev.turnId, { state, ...(ev.reason ? { failure: ev.reason } : {}) }),
      }
    }
    case 'turn.cancelled': {
      const t = v.turns[ev.turnId]
      if (!t || t.state !== 'queued') return v
      const text = CANCELLED_TEXT[ev.why]
      let messages = v.messages
      if (text !== null) {
        messages = upsert(messages, userMessage(t, v.queued.find(x => x.turnId === ev.turnId)?.messageId ?? `${ev.turnId}.u`))
        messages = upsert(messages, { id: `${ev.turnId}.x`, role: 'event', text })
      }
      return { ...v, messages, queued: withoutTurn(v.queued, ev.turnId), budgetWait: false, turns: setTurn(v, ev.turnId, { state: 'cancelled' }) }
    }
    case 'notice': {
      const notice = { code: ev.code, text: NOTICE_TEXT[ev.code] }
      const damaged = ev.code === NOTICE.sessionDamaged || ev.code === NOTICE.mirrorError
      return { ...v, notice, budgetWait: ev.code === NOTICE.budgetBusy ? true : v.budgetWait, damaged: v.damaged || damaged }
    }
    case 'run.finished':
      return { ...v, openRuns: v.openRuns.filter(r => r !== ev.runId), thinking: null, live: null, notice: v.damaged ? v.notice : null, budgetWait: false }
  }
}

/** A whole stream through the reducer, from an empty view. */
export const viewOf = (events: readonly ChatEvent[], at: Instant, runId = ''): ChatView => events.reduce((v, e) => reduce(v, e, at, runId), emptyView())
