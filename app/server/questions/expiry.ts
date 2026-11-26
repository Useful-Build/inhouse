// Stage 1 M2-Q (N16): the `question-expiry:<questionId>` due task, armed when the question is asked, due 7 days later.
// At its time, a question still open whose turn still waits on it expires: `question.expired`, a bell notice ("A
// question was closed") to the people asked, and the waiting run is ended through the BrandAgent's own resume path:
// the call runs again and `question_ask` answers that nobody answered, so the agent closes the turn in its own words
// and the parked turn's end task (a routine's, a job's) fires once, with that turn's end. Also the backstop for an
// answer whose resume never landed: it resumes it now. Every step is idempotent, so a retry after a failure redoes
// only what is missing.
import type { TaskHandler } from '../do/brand-agent/scheduler.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { EXPIRY_KIND } from './ask.ts'
import { inObjectAgent, waitingQuestionOf } from './agent.ts'
import { deliver } from './flow.ts'
import { questionStore } from './store.ts'

/** How long an answer the object holds back waits before this task looks at it again. */
export const LATER_MS = 60 * 60_000

export const questionExpiry: TaskHandler = async (task, ctx) => {
  const questionId = task.id.slice(EXPIRY_KIND.length + 1)
  const store = questionStore({ db: ctx.env.DB })
  let row = await store.get(questionId)
  if (!row) return { done: true }
  if (row.state === 'answered' && row.delivered_at_ms === null) {
    // Held back (a pause, a drain, a full queue): look again later, without counting toward quarantine.
    if ((await deliver(store, inObjectAgent(ctx), row, ctx.nowMs)) === 'later') ctx.scheduler.schedule({ id: task.id, kind: EXPIRY_KIND, dueAtMs: ctx.nowMs + LATER_MS })
    return { done: true }
  }
  if (row.state === 'open') {
    // A clock that moved back: not yet.
    if (ctx.nowMs < row.expires_at_ms) return { retryAtMs: row.expires_at_ms, error: 'not_due' }
    if (waitingQuestionOf(ctx.sql, row.chat_id) !== row.id) {
      await store.withdraw(row.id, ctx.nowMs)
      return { done: true }
    }
    // A chat in the trash: withdrawn, not expired (no line, no notice); the wait is given up through the resume, which
    // finds the chat gone and ends the parked turn (core.ts `resumeDeferred`). The resume first: if it throws, the
    // retry finds the question still open and the chat still waiting, and comes back here; once the wait is gone, a
    // retry after a failed withdraw takes the branch above.
    if (await store.chatGone(row.chat_id)) {
      await ctx.resumeDeferred(row.chat_id, 'deny', row.id)
      await store.withdraw(row.id, ctx.nowMs)
      return { done: true }
    }
    await store.expire(row.id, { actorId: SYSTEM_MEMBER_ID, requestId: `question-${crypto.randomUUID()}`, nowMs: ctx.nowMs })
    row = (await store.get(questionId))!
  }
  if (row.state === 'expired') {
    await store.expiredNotice(row, ctx.nowMs)
    // `deny`: the decision the call runs again under; the tool reads the expired question and says so.
    if (waitingQuestionOf(ctx.sql, row.chat_id) === row.id) await ctx.resumeDeferred(row.chat_id, 'deny', row.id)
  }
  return { done: true }
}
