// What a chat's long job shows (Stage 1 M1-D, N3), from what this tab's run said (`JobInfo`, view.ts) and what the
// server keeps (`Job`, route 100), so a reload or a closed tab shows the same thing with no live turn. Pure: JobStatus.tsx
// draws it. A running job is a progress row with Cancel; an ended one is a result card while it is the newest thing in
// the chat (a later message moves the conversation on; the bell keeps the notice).
import type { ChatMessage, Job, JobOutcome, Money } from '../../agent/types'
import type { JobInfo } from './view'

export type JobShown =
  | { kind: 'running'; jobId: string; waiting: boolean; label: string | null; helpers: number }
  | { kind: 'ended'; jobId: string; outcome: JobOutcome; durationMs: number | null; cost: Money | null }

/**
 * This tab's events win for the job they name, except where the server already knows more: the same job ended (a
 * Cancel answered here before its `job.ended` arrived), or another job that is still going (one this tab saw no events of).
 */
export function jobShown(live: JobInfo | null, stored: Job | null, messages: readonly ChatMessage[]): JobShown | null {
  const storedNewer = live !== null && stored !== null && stored.jobId !== live.jobId && stored.state !== 'ended'
  if (live !== null && !storedNewer) {
    if (stored?.jobId === live.jobId && stored.state === 'ended') return storedEnd(stored, messages)
    if (live.state === 'running') return { kind: 'running', jobId: live.jobId, waiting: false, label: live.progress?.label || null, helpers: live.progress?.helpers ?? 0 }
    if (live.outcome === null || (live.endedAt !== null && movedOn(messages, live.endedAt.ms))) return null
    return { kind: 'ended', jobId: live.jobId, outcome: live.outcome, durationMs: live.durationMs, cost: live.cost }
  }
  if (stored === null) return null
  if (stored.state !== 'ended') {
    return { kind: 'running', jobId: stored.jobId, waiting: stored.state === 'waiting', label: stored.progress?.label || null, helpers: stored.progress?.helpers ?? 0 }
  }
  return storedEnd(stored, messages)
}

function storedEnd(j: Job, messages: readonly ChatMessage[]): JobShown | null {
  if (j.outcome === null || j.endedAt === null || movedOn(messages, j.endedAt.ms)) return null
  return { kind: 'ended', jobId: j.jobId, outcome: j.outcome, durationMs: Math.max(0, j.endedAt.ms - j.startedAt.ms), cost: j.cost }
}

/** A message the person sent, or an answer, after the job ended: the chat has moved on. */
const movedOn = (messages: readonly ChatMessage[], endedMs: number): boolean =>
  messages.some(m => m.role !== 'event' && m.at !== undefined && m.at.ms > endedMs)
