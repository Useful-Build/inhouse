// What a chat's long job shows (Stage 1 M1-D, N3), from what this tab's run said (`JobInfo`, view.ts) and what the
// server keeps (`Job`, route 100), so a reload or a closed tab shows the same thing with no live turn. Pure: JobStatus.tsx
// draws it. A running job is a progress row with Cancel; an ended one is a result card while it is the newest thing in
// the chat (a later message moves the conversation on; the bell keeps the notice).
import type { ChatMessage, Job, JobOutcome } from '../../agent/types'
import type { JobInfo } from './view'

export type JobShown =
  | { kind: 'running'; jobId: string; waiting: boolean; label: string | null; helpers: number }
  | { kind: 'ended'; jobId: string; outcome: JobOutcome; durationMs: number | null }

/**
 * This tab's events win for the job they name, except where the server already knows more: the same job ended (a
 * Cancel answered here before its `job.ended` arrived) or waiting on a question (no event says so), or another job that
 * is still going (one this tab saw no events of). The card leaves the job's cost out (DESIGN.md section 1: no cost per run).
 */
export function jobShown(live: JobInfo | null, stored: Job | null, messages: readonly ChatMessage[]): JobShown | null {
  const storedNewer = live !== null && stored !== null && stored.jobId !== live.jobId && stored.state !== 'ended'
  if (live !== null && !storedNewer) {
    if (stored?.jobId === live.jobId && stored.state === 'ended') return storedEnd(stored, messages)
    if (live.state === 'running') {
      const waiting = stored?.jobId === live.jobId && stored.state === 'waiting'
      return { kind: 'running', jobId: live.jobId, waiting, label: live.progress?.label || null, helpers: live.progress?.helpers ?? 0 }
    }
    if (live.outcome === null || (live.endedAt !== null && movedOn(messages, live.endedAt.ms))) return null
    return { kind: 'ended', jobId: live.jobId, outcome: live.outcome, durationMs: live.durationMs }
  }
  if (stored === null) return null
  if (stored.state !== 'ended') {
    return { kind: 'running', jobId: stored.jobId, waiting: stored.state === 'waiting', label: stored.progress?.label || null, helpers: stored.progress?.helpers ?? 0 }
  }
  return storedEnd(stored, messages)
}

function storedEnd(j: Job, messages: readonly ChatMessage[]): JobShown | null {
  if (j.outcome === null || j.endedAt === null || movedOn(messages, j.endedAt.ms)) return null
  return { kind: 'ended', jobId: j.jobId, outcome: j.outcome, durationMs: Math.max(0, j.endedAt.ms - j.startedAt.ms) }
}

/**
 * The person wrote again after the job ended: the chat has moved on. Only their own message counts: an answer's part
 * stamped after the end (a turn winding down at the 8-hour cap is interrupted, not fenced) is still the job's.
 */
const movedOn = (messages: readonly ChatMessage[], endedMs: number): boolean =>
  messages.some(m => m.role === 'user' && m.at !== undefined && m.at.ms > endedMs)

/** What route 100 last said for a chat. */
export interface StoredJob { chatId: string; job: Job | null }

/**
 * A read of route 100 taken in: a job's end is final, so an older read that still says it runs (one that left before a
 * Cancel was answered) never takes the end back.
 */
export function takeStored(prev: StoredJob | null, next: StoredJob): StoredJob | null {
  const had = prev?.chatId === next.chatId ? prev.job : null
  if (had && next.job && had.jobId === next.job.jobId && had.state === 'ended' && next.job.state !== 'ended') return prev
  return next
}

/** The job whose Cancel job the person pressed in this chat, so its card takes the focus once it shows. */
export interface CancelFocus { chatId: string; jobId: string }

/**
 * What the focus wish does now that the chat shows `shown`: `focus` the card's heading (and forget the wish) once that
 * job's card shows, whichever came first, its `job.ended` frame or the Cancel's answer; `wait` while its row still shows;
 * `drop` it for anything else (another chat, another job, nothing), so it never outlives that card.
 */
export function cancelFocus(wish: CancelFocus | null, chatId: string | null, shown: JobShown | null): 'focus' | 'wait' | 'drop' {
  if (wish === null || wish.chatId !== chatId || shown?.jobId !== wish.jobId) return 'drop'
  return shown.kind === 'ended' ? 'focus' : 'wait'
}
