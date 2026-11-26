// Stage 1 M2-Q (N16): asking. The runner deferred the main agent's lone `question_ask` (runner/src/guards/defer.ts),
// the checkpoint left the chat waiting, and the BrandAgent's `deferred-hook:<questionId>` task calls this hook (P6's
// `onDeferred`, retried until it answers ok). It makes the one question for that call, tells the people asked, and
// arms the 7-day expiry. Idempotent: a retry, or the same call deferred again, never asks twice.
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { stmt, storage } from '../db/sql.ts'
import type { OnDeferredHook } from '../do/brand-agent/ports.ts'
import { questionStore } from './store.ts'
import { QUESTION_TTL_MS, QuestionAskInputSchema } from './types.ts'
import type { AskedAs } from './types.ts'

/** The one tool a deferral asks a question for (the runner defers nothing else). */
export const QUESTION_TOOL = 'mcp__inhouse__question_ask'

export const EXPIRY_KIND = 'question-expiry'
export const expiryTaskId = (questionId: string): string => `${EXPIRY_KIND}:${questionId}`

/**
 * Who a question in this chat is for (N16): the chat's owner; in a routine's chat (`m_system`) the routine's creator
 * while they're an active person, else every admin (the first answer wins).
 */
export async function whoToAsk(db: D1Database, ownerId: string, chatId: string): Promise<{ askedOf: string; askedAs: AskedAs }> {
  if (ownerId !== SYSTEM_MEMBER_ID) return { askedOf: ownerId, askedAs: 'owner' }
  const s = stmt(
    `SELECT r.creator_id AS creator, m.kind AS kind, m.status AS status FROM routine_slots s JOIN routines r ON r.id = s.routine_id
      LEFT JOIN members m ON m.id = r.creator_id WHERE s.chat_id = ? ORDER BY s.claimed_at_ms DESC LIMIT 1`, chatId)
  const r = await storage('D1', () => db.prepare(s.sql).bind(...s.params).first<{ creator: string; kind: string | null; status: string | null }>())
  if (r && r.kind === 'person' && r.status === 'active') return { askedOf: r.creator, askedAs: 'creator' }
  return { askedOf: 'admins', askedAs: 'admins' }
}

/**
 * With questions off (server/questions/switch.ts): a deferral is resumed at once and nothing is asked, so no chat ever
 * waits on a question nobody can answer. The call then runs and the server refuses it (it isn't offered).
 */
export const questionsOffOnDeferred: OnDeferredHook = async (q, ctx) => {
  await ctx.resumeDeferred(q.chatId, 'deny', q.questionId)
  return { ok: true }
}

/** P6's `onDeferred` for this build (compose.ts): asks only when questions are on. */
export const questionHook = (on: boolean): OnDeferredHook => (on ? questionOnDeferred : questionsOffOnDeferred)

/** P6's `onDeferred` for questions, when they are on. */
export const questionOnDeferred: OnDeferredHook = async (q, ctx) => {
  // Only `question_ask` is ever deferred; anything else, or an input the tool would refuse, is let run on a resume,
  // where the tool answers it (a refusal the agent can read). The chat never waits on a question nobody can see.
  const input = QuestionAskInputSchema.safeParse(q.input)
  if (q.toolName !== QUESTION_TOOL || !input.success) {
    await ctx.resumeDeferred(q.chatId, 'deny', q.questionId)
    return { ok: true }
  }
  const db = ctx.env.DB
  const store = questionStore({ db })
  const before = await store.byToolUse(q.chatId, q.toolUseId)
  if (before !== null && before.id !== q.questionId) {
    // The same call deferred again on its resume: its question is already there; the call runs and reads it.
    await ctx.resumeDeferred(q.chatId, 'deny', q.questionId)
    return { ok: true }
  }
  const expiresAtMs = (before?.expires_at_ms ?? ctx.nowMs + QUESTION_TTL_MS)
  if (before === null) {
    const who = await whoToAsk(db, q.ownerId, q.chatId)
    await store.create({
      id: q.questionId, chatId: q.chatId, turnId: q.turnId, toolUseId: q.toolUseId, ...who,
      question: input.data.question, options: input.data.options, createdAtMs: ctx.nowMs, expiresAtMs,
    }, { actorId: q.ownerId, requestId: `question-${crypto.randomUUID()}`, nowMs: ctx.nowMs })
  }
  ctx.scheduler.ensure({ id: expiryTaskId(q.questionId), kind: EXPIRY_KIND, dueAtMs: expiresAtMs })
  return { ok: true }
}
