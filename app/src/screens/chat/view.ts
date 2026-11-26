// A chat's live view, built from its run events (p3-design section 2). A pure reducer: the same events in the same order
// give the same view, so a replay after a reconnect or a reload shows what the live stream showed. Messages are keyed
// by their stable ids (`<turnId>.u`, `<turnId>.<n>`), so an event seen twice never doubles a message.
// Ids the view makes itself from a turn's end event: `<turnId>.f` a failed turn's answer, `<turnId>.x` a note. The server
// stores the same ids as the turn's end row (projection.ts), and turn-text.ts `historyMessages` words it the same way.
// Live-only notes (the server stores neither): `<turnId>.r.<name>` a file the agent made that wasn't saved,
// `<turnId>.l` the chat's earlier files a run couldn't bring back.
//
// Turns the server wrote itself (Stage 1, N3 and N20: a long job's continuation, an action's or a question's resume) are
// never the person's message: their `<turnId>.u` shows as the server's own note (shared/server-turn-text.ts), as a
// reload shows it, and their text is never offered back as the person's question (Try again). Most of a long job's own
// turn ends say nothing in the thread (the job's progress row and result card speak for it, JobStatus.tsx): a promoted
// root's limit or cut, a continuation's failure the job carries on from or retries, or the server's cut. The server's
// history projection (projection.ts) keeps no end row for exactly those, so a reload agrees.
import type { Attachment, AttachmentRef, ChatMessage, Instant, Money } from '../../agent/types'
import type { ChatEvent, TurnFailure, TurnSource } from '../../../shared/contract/runs'
import type { JobOutcome } from '../../../shared/contract/jobs'
import { FAIL, NOTICE } from '../../../shared/contract/chat-codes'
import { JOB_TURN_FAILURES_SHOWN, serverTurnText } from '../../../shared/server-turn-text'
import { NOTICE_TEXT, RUN_FAILED, STOPPED_NOTE, emptyView, upsert } from './notes'
import { FAILURE_TEXT, cancelledText, fileRefusedText, filesLeftOutText } from './turn-text'
import { JOB_THINKING } from './job-text'

export type NoticeCode = Extract<ChatEvent, { type: 'notice' }>['code']

/** A message sent into the chat that waits for its turn. It joins the messages when its turn starts. */
export interface QueuedTurn { turnId: string; messageId: string; text: string; quote?: string; atts: Attachment[]; priority: 'now' | 'next' | 'later' }

export type TurnState = 'queued' | 'live' | 'done' | 'interrupted' | 'stopped' | 'failed' | 'cancelled'
/**
 * `at`: when the question was sent (the `turn.queued` frame's time), shown as the person's message time. `source`: who
 * wrote a turn the person didn't type (a question's resume is told by its empty text: a person's message never is).
 */
export interface TurnInfo {
  turnId: string; runId: string; messageId: string; state: TurnState; text: string; quote?: string; atts: Attachment[]; at: Instant; failure?: TurnFailure
  source?: TurnSource
}
/** One live step emitted while a turn is running. */
export interface LiveStep { id: string; label: string; tool?: string }

/** The chat's long job as its events told it (N3): `job.started`, its last `job.progress`, its one `job.ended`. */
export interface JobInfo {
  jobId: string
  rootTurnId: string
  state: 'running' | 'ended'
  progress: { label: string; helpers: number } | null
  outcome: JobOutcome | null
  /** When `job.ended` was sent, its length and its cost. */
  endedAt: Instant | null
  durationMs: number | null
  cost: Money | null
}

export interface ChatView {
  messages: ChatMessage[]
  queued: QueuedTurn[]
  turns: Record<string, TurnInfo>
  /** The turn being answered now. */
  live: string | null
  /** The newest step's label while a turn is live ("Reading your question…"). */
  thinking: string | null
  /** The live steps accumulated during the current running turn, in arrival order. */
  liveSteps: LiveStep[]
  /** The latest notice that still holds, as its text. Cleared when a turn starts or the run ends. */
  notice: { code: NoticeCode; text: string } | null
  /** A turn waits for others to finish because of the spending cap (the budget is busy): shown as waiting, not failed. */
  budgetWait: boolean
  /** The chat's session can't go on (the notices for a damaged session or a failed mirror): sends are refused until `resetSession`. */
  damaged: boolean
  /** Runs that started and haven't finished. */
  openRuns: string[]
  files: { turnId: string; fileId: string; name: string; bytes: number; contentType: string }[]
  /** The chat's newest long job in this run, or null. */
  job: JobInfo | null
  /**
   * A person's turn that ended at a limit (failed for too many steps or the one-answer budget) or interrupted: the server may make it a
   * long job in the same step (`job.started` comes next, N3), and then its end isn't a failure. Its end message waits
   * here for the next event: dropped if that event starts its job, shown otherwise.
   */
  pendingEnd: { turnId: string; message: ChatMessage } | null
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

const userMessage = (t: TurnInfo): ChatMessage => ({
  id: t.messageId, role: 'user', text: t.text, ...(t.quote !== undefined ? { quote: t.quote } : {}), ...(t.atts.length ? { atts: t.atts } : {}), at: t.at,
})
/** What a turn's `.u` shows: the person's message, or the server's own note for a turn it wrote (null: nothing). */
function askedMessage(t: TurnInfo): ChatMessage | null {
  if (t.source === undefined) return userMessage(t)
  const text = serverTurnText(t.source)
  return text === null ? null : { id: t.messageId, role: 'event', text }
}
const withAsked = (messages: ChatMessage[], t: TurnInfo): ChatMessage[] => {
  const m = askedMessage(t)
  return m === null ? messages : upsert(messages, m)
}
/** The question Try again asks: only ever the person's own words. A server-written turn's text is never theirs. */
const retryOf = (v: ChatView, t: TurnInfo): string => {
  if (t.source === undefined) return t.text
  if (t.source === 'job' && v.job) { const root = v.turns[v.job.rootTurnId]; if (root && root.source === undefined) return root.text }
  return ''
}
/** A person's turn ended this way may become a long job in the same step (N3, `promotable`): its end waits. */
const CARRY_FAILURES: ReadonlySet<string> = new Set([FAIL.maxTurns, FAIL.turnBudget])
const mayCarry = (t: TurnInfo, ev: Extract<ChatEvent, { type: 'turn.finished' }>): boolean =>
  t.source === undefined && ((ev.outcome === 'failed' && CARRY_FAILURES.has(ev.reason ?? '')) || ev.outcome === 'interrupted')
const withoutTurn = (q: QueuedTurn[], turnId: string) => q.filter(x => x.turnId !== turnId)
const setTurn = (v: ChatView, turnId: string, patch: Partial<TurnInfo>): ChatView['turns'] => {
  const t = v.turns[turnId]
  return t ? { ...v.turns, [turnId]: { ...t, ...patch } } : v.turns
}

/**
 * `at`: when the frame was sent (a note's time). Returns the same view object when the event changes nothing.
 * A held end (`pendingEnd`) shows before any event but the one that starts its job, which drops it.
 */
export function reduce(v: ChatView, ev: ChatEvent, at: Instant, runId = ''): ChatView {
  if (v.pendingEnd !== null && !(ev.type === 'job.started' && ev.rootTurnId === v.pendingEnd.turnId)) {
    v = { ...v, messages: upsert(v.messages, v.pendingEnd.message), pendingEnd: null }
  }
  return step(v, ev, at, runId)
}

function step(v: ChatView, ev: ChatEvent, at: Instant, runId: string): ChatView {
  switch (ev.type) {
    case 'run.started':
      return v.openRuns.includes(ev.runId) ? v : { ...v, openRuns: [...v.openRuns, ev.runId] }
    case 'turn.queued': {
      if (v.turns[ev.turnId]) return v
      const atts = ev.attachments.map(a => ({ ...attOf(a.name), fileId: a.fileId }))
      // A question's resume carries no source on the wire (core.ts) and no text: a person's message always has text.
      const source: TurnSource | undefined = ev.source ?? (ev.text === '' && atts.length === 0 ? 'question' : undefined)
      const info: TurnInfo = {
        turnId: ev.turnId, runId, messageId: ev.messageId, state: 'queued', text: ev.text, ...(ev.quote !== undefined ? { quote: ev.quote } : {}), atts, at,
        ...(source !== undefined ? { source } : {}),
      }
      // Only the person's own messages wait as queued chips: a server-written turn is never shown as something they sent.
      if (source !== undefined) return { ...v, turns: { ...v.turns, [ev.turnId]: info } }
      const q: QueuedTurn = { turnId: ev.turnId, messageId: ev.messageId, text: ev.text, ...(ev.quote !== undefined ? { quote: ev.quote } : {}), atts, priority: ev.priority }
      return { ...v, turns: { ...v.turns, [ev.turnId]: info }, queued: [...v.queued, q] }
    }
    case 'turn.started': {
      const t = v.turns[ev.turnId]
      if (!t) return v
      return {
        ...v, live: ev.turnId, thinking: t.source === 'job' ? JOB_THINKING : 'Reading your question…', liveSteps: [], notice: null, budgetWait: false,
        turns: setTurn(v, ev.turnId, { state: 'live' }), queued: withoutTurn(v.queued, ev.turnId), messages: withAsked(v.messages, t),
      }
    }
    case 'part':
      return { ...v, messages: upsert(v.messages, { id: ev.messageId, role: 'agent', part: ev.part, trace: ev.turnId, model: ev.model, at: ev.at }) }
    case 'step': {
      if (v.live !== ev.turnId) return v
      const nextStep: LiveStep = { id: ev.stepId, label: ev.label, ...(ev.tool !== undefined ? { tool: ev.tool } : {}) }
      const idx = v.liveSteps.findIndex(s => s.id === ev.stepId)
      const liveSteps = idx < 0 ? [...v.liveSteps, nextStep] : v.liveSteps.map((s, i) => (i === idx ? nextStep : s))
      return { ...v, thinking: ev.label, liveSteps }
    }
    case 'file':
      return v.files.some(f => f.fileId === ev.fileId) ? v : { ...v, files: [...v.files, { turnId: ev.turnId, fileId: ev.fileId, name: ev.name, bytes: ev.bytes, contentType: ev.contentType }] }
    case 'file.refused':
      return { ...v, messages: upsert(v.messages, { id: `${ev.turnId}.r.${ev.name}`, role: 'event', text: fileRefusedText(ev.name, ev.reason) }) }
    case 'files.restored':
      return ev.leftOut.length === 0 ? v : { ...v, messages: upsert(v.messages, { id: `${ev.turnId}.l`, role: 'event', text: filesLeftOutText(ev.leftOut) }) }
    case 'turn.finished': {
      const t = v.turns[ev.turnId]
      if (!t || t.state === 'done' || t.state === 'interrupted' || t.state === 'stopped' || t.state === 'failed' || t.state === 'cancelled') return v
      const state: TurnState = ev.outcome
      let messages = v.messages
      // A turn that ended before it started (a failure at the claim) still shows what was asked.
      if (t.state === 'queued') messages = withAsked(messages, t)
      let end: ChatMessage | null = null
      if (ev.outcome === 'failed') {
        const reason = ev.reason ?? 'unknown'
        end = { id: `${ev.turnId}.f`, role: 'agent', trace: ev.turnId, at, part: { type: 'error', text: FAILURE_TEXT[reason] ?? RUN_FAILED, retryQuestion: retryOf(v, t) } }
      } else if (ev.outcome === 'interrupted' || ev.outcome === 'stopped') {
        end = { id: `${ev.turnId}.x`, role: 'event', text: STOPPED_NOTE }
      }
      let pendingEnd = v.pendingEnd
      if (t.source === 'job') {
        // A job's own turn: most failures are the job's to judge (carry on, retry or end for its budget, and its card says
        // so); one that ends the job whatever comes next still shows, with Try again asking the person's question. The
        // server's cut carries the job on. A stop says so only when the person stopped it: a Stop or Cancel (`stopped`), an
        // interrupt that cancelled the job (its `job.ended` came first), or their new message taking the turn's place.
        const shown = ev.outcome === 'failed' ? JOB_TURN_FAILURES_SHOWN.has(ev.reason ?? 'unknown')
          : ev.outcome === 'stopped' || (ev.outcome === 'interrupted' && (v.job?.outcome === 'cancelled' || v.queued.length > 0))
        if (!shown) end = null
      } else if (end !== null && mayCarry(t, ev)) {
        pendingEnd = { turnId: ev.turnId, message: end }
        end = null
      }
      if (end !== null) messages = upsert(messages, end)
      return {
        ...v, messages, pendingEnd, queued: withoutTurn(v.queued, ev.turnId),
        live: v.live === ev.turnId ? null : v.live,
        thinking: v.live === ev.turnId ? null : v.thinking,
        liveSteps: v.live === ev.turnId ? [] : v.liveSteps,
        budgetWait: false, turns: setTurn(v, ev.turnId, { state, ...(ev.reason ? { failure: ev.reason } : {}) }),
      }
    }
    case 'turn.cancelled': {
      const t = v.turns[ev.turnId]
      // A turn still waiting, or one that went live and was stopped by the cancel (a pause): both say why, once.
      if (!t || (t.state !== 'queued' && t.state !== 'live')) return v
      const text = cancelledText(ev.why, v.messages.some(x => x.role === 'agent' && x.trace === ev.turnId))
      let messages = v.messages
      if (text !== null) {
        messages = withAsked(messages, t)
        messages = upsert(messages, { id: `${ev.turnId}.x`, role: 'event', text })
      }
      const wasLive = v.live === ev.turnId
      return {
        ...v, messages, queued: withoutTurn(v.queued, ev.turnId), budgetWait: false, turns: setTurn(v, ev.turnId, { state: 'cancelled' }),
        ...(wasLive ? { live: null, thinking: null, liveSteps: [] } : {}),
      }
    }
    case 'notice': {
      const notice = { code: ev.code, text: NOTICE_TEXT[ev.code] }
      const damaged = ev.code === NOTICE.sessionDamaged || ev.code === NOTICE.mirrorError
      return { ...v, notice, budgetWait: ev.code === NOTICE.budgetBusy ? true : v.budgetWait, damaged: v.damaged || damaged }
    }
    case 'run.finished':
      return { ...v, openRuns: v.openRuns.filter(r => r !== ev.runId), thinking: null, live: null, liveSteps: [], notice: v.damaged ? v.notice : null, budgetWait: false }
    // Stage 1 M1-D (N3): the job's life, for its progress row and result card (JobStatus.tsx).
    case 'job.started':
      return {
        ...v, pendingEnd: v.pendingEnd?.turnId === ev.rootTurnId ? null : v.pendingEnd,
        job: { jobId: ev.jobId, rootTurnId: ev.rootTurnId, state: 'running', progress: null, outcome: null, endedAt: null, durationMs: null, cost: null },
      }
    case 'job.progress':
      return v.job?.jobId === ev.jobId && v.job.state === 'running' ? { ...v, job: { ...v.job, progress: { label: ev.label, helpers: ev.helpers } } } : v
    case 'job.ended': {
      if (v.job?.state === 'ended' && v.job.jobId === ev.jobId) return v
      const base = v.job?.jobId === ev.jobId ? v.job : { jobId: ev.jobId, rootTurnId: '', progress: null }
      return { ...v, job: { ...base, state: 'ended', outcome: ev.outcome, endedAt: at, durationMs: ev.durationMs, cost: ev.cost } }
    }
    // Stage 1 M2-H: the card reads itself again (AskCard, through the client's `onActionUpdated`); the thread is unchanged.
    case 'action.updated':
      return v
  }
}

/** The files these turns saved, in the order they came. A block of the thread can hold more than one turn's parts. */
export const filesOfTurns = (v: ChatView | undefined, turnIds: ReadonlySet<string>): ChatView['files'] => (v ? v.files.filter(f => turnIds.has(f.turnId)) : [])
