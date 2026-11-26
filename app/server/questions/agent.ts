// Stage 1 M2-Q: the BrandAgent side of a question. Read-only over the object's `chat_state` (core.ts owns it and
// writes `waiting_json` when a checkpoint leaves a chat waiting on a deferred call), and the in-object `QuestionAgent`
// a due task uses. The Worker's routes reach the same reads through `BrandAgent.questionWaits` and `questionResume`.
import type { TaskContext } from '../do/brand-agent/scheduler.ts'
import type { QuestionAgent } from './flow.ts'

/** The question this chat waits on (`chat_state.waiting_json`), or null when it waits on none. */
export function waitingQuestionOf(sql: SqlStorage, chatId: string): string | null {
  const r = sql.exec<{ session: string; waiting_json: string | null }>('SELECT session, waiting_json FROM chat_state WHERE chat_id = ?', chatId).toArray()[0]
  if (!r || r.session !== 'waiting' || r.waiting_json === null) return null
  const id = (JSON.parse(r.waiting_json) as { questionId?: unknown }).questionId
  if (typeof id !== 'string') throw new Error('chat_state.waiting_json without a questionId')
  return id
}

/** `BrandAgent.questionWaits`: the question each chat waits on. At most 100 chats per call. */
export function questionWaits(sql: SqlStorage, chatIds: string[]): Record<string, string | null> {
  if (!Array.isArray(chatIds) || chatIds.length > 100 || chatIds.some(c => typeof c !== 'string')) throw new Error('questionWaits: 1 to 100 chat ids')
  return Object.fromEntries(chatIds.map(c => [c, waitingQuestionOf(sql, c)]))
}

/**
 * Called once a question's resume was taken (BrandAgent `questionResume`), in the object: the seam for whatever must
 * wake on an answer. M1-B's job engine (PR #434) adds its line here so an answered question wakes a job waiting on the
 * chat (N3: `waiting_answer` moves to a real wake). None until then.
 */
export type QuestionWake = (chatId: string) => void

/** A task's view of the BrandAgent: the same reads and the same in-object resume as the routes'. */
export function inObjectAgent(ctx: Pick<TaskContext, 'sql' | 'resumeDeferred'>, wakes: readonly QuestionWake[] = []): QuestionAgent {
  return {
    waits: async chatIds => questionWaits(ctx.sql, chatIds),
    resume: async (chatId, questionId) => {
      const r = await ctx.resumeDeferred(chatId, 'allow', questionId)
      if (!('refused' in r)) for (const wake of wakes) wake(chatId)
      return r
    },
  }
}
