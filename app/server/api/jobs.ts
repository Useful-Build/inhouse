// Long jobs (Stage 1 M1-B, N3): routes 100 and 101. A job is its chat owner's (BD11): another person's chat or job is
// 404 before the object check, as routes 29 to 31 answer a turn. The BrandAgent keeps the job (jobs/engine.ts); these
// read it and cancel it.
import { ChatIdSchema } from '../../shared/contract/chat-ids.ts'
import { JobIdSchema } from '../../shared/contract/jobs.ts'
import type { ChatJob } from '../../shared/contract/jobs.ts'
import { apiError, apiJson } from '../http.ts'
import { storesOf } from '../db/handler-kit.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import type { Handler } from '../routes.ts'
import { actorOf } from './runs.ts'

/** Route 100, `GET /api/chats/:id/job`: `{ job }`, the chat's newest job (null when it has none), so a reload shows it. */
export const getChatJob: Handler = async c => {
  const by = actorOf(c.principal)
  if (!by) return apiError('forbidden')
  const chatId = ChatIdSchema.safeParse(c.params.id)
  if (!chatId.success) return apiError('not_found')
  const chat = await storesOf(c).chats.ownerOf(chatId.data)
  if (!chat || chat.ownerId !== by.memberId || chat.deleted) return apiError('not_found')
  c.access.requireObject({ ownerId: chat.ownerId })
  const body: ChatJob = { job: await brandAgent(c.env).chatJob(chatId.data) }
  return apiJson(body)
}

/** Route 101, `POST /api/jobs/:id/cancel`: the owner's Cancel, `{ job }` as it is after (an ended job answers as it is). */
export const cancelJob: Handler = async c => {
  const by = actorOf(c.principal)
  if (!by) return apiError('forbidden')
  const jobId = JobIdSchema.safeParse(c.params.id)
  if (!jobId.success) return apiError('not_found')
  const agent = brandAgent(c.env)
  const owner = await agent.jobOwner(jobId.data)
  if (owner !== by.memberId) return apiError('not_found')
  c.access.requireObject({ ownerId: owner })
  const answer = await agent.cancelJob(jobId.data, by)
  if ('refused' in answer) return apiError(answer.refused.code, answer.refused.reason === undefined ? {} : { reason: answer.refused.reason })
  const body: ChatJob = { job: answer.job }
  return apiJson(body)
}
