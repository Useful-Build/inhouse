// Stage 1 M1-D (N3, N18): a chat's long job over HTTP (routes 100 and 101). No zod here (the entry's size budget,
// schemas.ts): the transport parses each answer with the lazily loaded schemas.
import type { ChatJob, Job } from '../../../shared/contract/jobs'
import type { Transport } from './transport'

const enc = encodeURIComponent

/** Route 100: the chat's newest job, or null. */
export const readChatJob = async (http: Transport, chatId: string): Promise<Job | null> =>
  (await http.call({ method: 'GET', path: `/api/chats/${enc(chatId)}/job`, schema: 'chatJob' }) satisfies ChatJob).job

/** Route 101: the owner's Cancel; the job as it is after. The route answers a job for any job it found. */
export async function postCancelJob(http: Transport, jobId: string): Promise<Job> {
  const { job } = await http.call({ method: 'POST', path: `/api/jobs/${enc(jobId)}/cancel`, schema: 'chatJob' }) satisfies ChatJob
  if (job === null) throw new Error(`route 101 answered no job for ${jobId}`)
  return job
}
