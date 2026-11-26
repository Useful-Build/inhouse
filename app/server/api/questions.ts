// Routes 140 and 141 (Stage 1 M2-Q, N16): the open questions asked of this person, and answering one. Members and
// Admins only (the matrix); whose question it is is the question's own rule (`asked_of`: this member, or every admin).
// Both read the BrandAgent's waits, so a question whose turn no longer waits on it is withdrawn, never answered.
import { AnswerQuestionInputSchema, QuestionIdSchema, QuestionSchema, QuestionsListSchema } from '../../shared/contract/questions.ts'
import { readBody, readQuery, storesOf } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import type { HandlerContext } from '../routes.ts'
import { apiError, apiJson } from '../http.ts'
import { answerQuestion, openQuestions } from '../questions/flow.ts'
import type { QuestionAgent } from '../questions/flow.ts'
import { toQuestion } from '../questions/types.ts'
import type { QuestionViewer } from '../questions/types.ts'
import { z } from 'zod'

/** The person asking. The matrix lets only brand people through; anything else is a wiring bug. */
function viewerOf(c: ApiCtx): QuestionViewer {
  const p = c.principal
  if (p.kind !== 'person') throw new Error('questions: only a brand person reaches these routes')
  return { memberId: p.memberId, role: p.role }
}

/** The BrandAgent's waits and resume, over its RPC. */
function agentOf(c: Pick<HandlerContext, 'env'>): QuestionAgent {
  const agent = brandAgent(c.env)
  return { waits: chatIds => agent.questionWaits(chatIds), resume: (chatId, questionId) => agent.questionResume(chatId, questionId) }
}

/** Route 140, `GET /api/questions`: `{ items }`, the open questions asked of this person, oldest first. */
export async function listQuestions(c: HandlerContext): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  const rows = await openQuestions(storesOf(c).questions, agentOf(c), viewerOf(c), c.nowMs)
  return apiJson(QuestionsListSchema.parse({ items: rows.map(toQuestion) }))
}

/**
 * Route 141, `POST /api/questions/:id/answer` `{ choice }`: the answered question. 404 for a question not asked of this
 * person; 400 for a choice that isn't one of its options; 409 with `current` when it was answered by someone else, or
 * expired or was withdrawn (its `state` says which); 503 when the answer is kept but the waiting turn couldn't be
 * reached (the same answer again resumes it).
 */
export async function answerQuestionRoute(c: HandlerContext): Promise<Response> {
  const id = QuestionIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, AnswerQuestionInputSchema)
  if ('error' in body) return body.error
  const viewer = viewerOf(c)
  const out = await answerQuestion(storesOf(c).questions, agentOf(c), {
    id: id.data, choice: body.ok.choice, viewer, at: { actorId: viewer.memberId, requestId: c.requestId, nowMs: c.nowMs },
  })
  if ('ok' in out) return apiJson(QuestionSchema.parse(toQuestion(out.ok)))
  if ('unavailable' in out) return apiError('unavailable')
  if (out.refused === 'not_found') return apiError('not_found')
  if (out.refused === 'invalid') return apiError('invalid')
  return apiError('conflict', out.current ? { current: toQuestion(out.current) } : {})
}
