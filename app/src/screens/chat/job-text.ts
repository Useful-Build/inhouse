// The words about a long job (Stage 1 M1-D, N3): its progress row and its result card (JobStatus.tsx). The bell
// notice says the same outcome in the server's words (server/do/brand-agent/jobs/notice.ts). House voice: contractions,
// no dashes, plain outcomes (standing decision 5).
import type { JobOutcome } from '../../../shared/contract/jobs'

/** The live line while a continuation reads the chat back (the store shows it until the first step). */
export const JOB_THINKING = 'Carrying on with this task…'

export const JOB_RUNNING_TITLE = 'Working on a long job'
/** Under the title while the job runs and has said nothing yet. */
export const JOB_RUNNING_TEXT = 'Your Inhouse agent keeps going on its own. You can close this tab.'
export const JOB_WAITING_TEXT = 'Your Inhouse agent is waiting for your answer to its question.'
export const JOB_CANCEL = 'Cancel job'
export const JOB_CANCELLING = 'Cancelling…'
export const JOB_CANCEL_FAILED = "Couldn't cancel the job. Try again."

/** The result card's title. */
export const jobEndTitle = (outcome: JobOutcome): string => (outcome === 'done' ? 'Long job finished' : 'Long job stopped')

/** Why the job ended, in the person's words (the bell's stopped-job lines, said to the person who sees the chat). */
export const JOB_END_TEXT: Readonly<Record<JobOutcome, string>> = {
  done: 'Your Inhouse agent finished this task. Its answer is above.',
  failed: 'Something went wrong, so it stopped. You can ask again.',
  budget: 'It reached the most one job may spend. An admin can raise the job budget in Settings.',
  cancelled: 'It was stopped before it finished.',
  time: 'It reached the 8-hour limit for one job.',
  stuck: 'It stopped making progress, so it was stopped.',
  taken_over: 'A new message in the chat took over.',
}

/** "1 helper", "3 helpers". */
export const helpersText = (n: number): string => `${n} ${n === 1 ? 'helper' : 'helpers'} working`

/** A job's length: "under a minute", "12 min", "2 h", "2 h 5 min". */
export function durationText(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'under a minute'
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** The card's facts line: how long it ran, when known. No cost (DESIGN.md section 1: no cost per run). */
export const jobFacts = (durationMs: number | null): string => (durationMs === null ? '' : `Ran for ${durationText(durationMs)}.`)

/** What a screen reader hears when the row or the card appears or changes (JobStatus's status line). */
export const jobAnnouncement = (title: string, detail: string): string => `${title}. ${detail}`
