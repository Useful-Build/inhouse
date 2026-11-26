// A job's one bell notice (M1-B, N3: bell only, no Slack): `job_finished` when it's done, else `job_stopped` with a
// plain line saying why and, for the budget, what to raise. To the job's owner, linked to the chat. The id is the
// job's, so a repeated write (the `job-end` task retried) is one row.
import type { JobOutcome } from '../../../../shared/contract/jobs.ts'
import type { NoticeInput } from '../../../notices/store.ts'
import type { JobNotice } from './types.ts'

/** Why a job stopped, in the person's words. No em dashes, no names, no model text. */
export const JOB_STOPPED_BODY: Readonly<Record<Exclude<JobOutcome, 'done'>, string>> = {
  budget: 'It reached the most a job may spend. An admin can raise the job budget in Settings, then ask again.',
  time: 'It reached the 8-hour limit for one job.',
  stuck: 'It stopped making progress, so it was stopped.',
  failed: 'Something went wrong, so it stopped. You can ask again in the chat.',
  cancelled: 'It was stopped before it finished.',
  taken_over: 'A new message in the chat took over.',
}

export const jobNoticeId = (jobId: string): string => `job_${jobId}`

export function jobNoticeInput(n: JobNotice): NoticeInput {
  const base = { id: n.id, audience: 'member' as const, audienceMemberId: n.ownerId, fields: {}, link: { to: 'chat' as const, id: n.chatId }, atMs: n.atMs }
  if (n.outcome === 'done') return { ...base, template: 'job_finished', icon: 'check' }
  return { ...base, template: 'job_stopped', icon: 'error', body: JOB_STOPPED_BODY[n.outcome] }
}
