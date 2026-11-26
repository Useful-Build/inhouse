// Stage 1 M2-Q (N16): answering a question and handing the answer to the turn that waits on it. The BrandAgent owns the
// wait (chat_state.waiting_json, core.ts): the question is answered in D1 first, by a compare-and-set, and only then
// is the wait resumed (`resumeDeferred`, idempotent by the question's id). So:
//  - one resume per question: the resume's key is the question's id, and only the first answer writes `answered`;
//  - no lost resume: an answer whose resume didn't land (the object unreachable, or the brand paused and the wait given
//    up before the object's own retry) stays `answered` with no `delivered_at_ms`; answering again with the same
//    choice, or the question's expiry task, resumes it or finds the wait gone and closes it;
//  - an answer after the wait was given up (the chat reset, deleted or its owner removed, a job cancelled or out of
//    time) resumes nothing: the question is `closed` and the person is told;
//  - a question whose wait is gone is withdrawn (`closed`) wherever it is next read: the list, an answer, its expiry.
import type { SendTurnResult } from '../../shared/contract/runs.ts'
import type { Refusal } from '../do/brand-agent/ports.ts'
import type { QuestionAt, QuestionStore } from './store.ts'
import { askedOfViewer, optionsOf } from './types.ts'
import type { QuestionRow, QuestionViewer } from './types.ts'

/** What the flow needs of the BrandAgent: the question each chat waits on, and the resume. */
export interface QuestionAgent {
  /** The question each of these chats waits on, or null when it waits on none. */
  waits(chatIds: string[]): Promise<Record<string, string | null>>
  /** Resumes the chat's wait on this question with its answer (core.ts `resumeDeferred`, decision `allow`). */
  resume(chatId: string, questionId: string): Promise<SendTurnResult | Refusal>
}

/**
 * Refusals the BrandAgent waits out by itself (core.ts `waitRefusal`: it schedules `deferred-resume` and tries again).
 * Any other refusal means the wait was given up (`not_found`) or abandoned there.
 */
const waitedOut = (r: Refusal) =>
  (r.refused.code === 'forbidden' && r.refused.reason === 'paused') || (r.refused.code === 'unavailable' && r.refused.reason === 'draining')
  || (r.refused.code === 'rate_limited' && r.refused.reason === 'queue_full')

/**
 * Hands an answered question to its waiting turn. `delivered` once a resume turn was taken; `later` when the object
 * holds the resume back for a pause, a drain or a full queue and tries it again itself (it may still find the wait
 * given up by then, so the question isn't marked delivered: a later call here, or its expiry task, settles it);
 * `closed` when nothing waits for the answer any more. Throws when the object can't be reached: the question stays
 * answered and undelivered, for a retry.
 */
export async function deliver(store: QuestionStore, agent: QuestionAgent, row: QuestionRow, nowMs: number): Promise<'delivered' | 'later' | 'closed'> {
  if (row.answer === null) throw new Error('deliver: the question has no answer')
  const r = await agent.resume(row.chat_id, row.id)
  if (!('refused' in r)) {
    await store.delivered(row.id, nowMs)
    return 'delivered'
  }
  if (waitedOut(r)) return 'later'
  await store.unanswerable(row.id)
  return 'closed'
}

export type AnswerOutcome =
  | { ok: QuestionRow }
  /** `invalid`: the choice isn't one of the options. `closed`: expired or withdrawn. `conflict`: someone answered first. */
  | { refused: 'not_found' | 'invalid' | 'closed' | 'conflict'; current?: QuestionRow }
  /** The answer is kept but the waiting turn couldn't be reached; the same answer again resumes it. */
  | { unavailable: QuestionRow }

/** A person answers a question asked of them. Idempotent for the same person and choice. */
export async function answerQuestion(
  store: QuestionStore, agent: QuestionAgent,
  p: { id: string; choice: string; viewer: QuestionViewer; at: QuestionAt },
): Promise<AnswerOutcome> {
  let row = await store.get(p.id)
  if (!row || !askedOfViewer(row, p.viewer)) return { refused: 'not_found' }
  if (!optionsOf(row).includes(p.choice)) return { refused: 'invalid', current: row }
  if (row.state === 'open') {
    if (p.at.nowMs >= row.expires_at_ms) return { refused: 'closed', current: row }
    // A chat in the trash: not answered (no line, nothing resumed), and left open so a restore brings it back.
    if (await store.chatGone(row.chat_id)) return { refused: 'not_found' }
    // Withdrawn: the turn no longer waits on it. Never answered, so nothing can resume it later.
    const waits = await agent.waits([row.chat_id])
    if (waits[row.chat_id] !== row.id) {
      await store.withdraw(row.id, p.at.nowMs)
      return { refused: 'closed', current: (await store.get(row.id))! }
    }
    await store.answer(row.id, p.choice, p.at)
    row = (await store.get(row.id))!
  }
  // Answered (by this call, or before it), expired or closed.
  if (row.answer === null || row.state === 'expired') return { refused: 'closed', current: row }
  if (row.answered_by !== p.viewer.memberId || row.answer !== p.choice) return { refused: 'conflict', current: row }
  if (row.state === 'closed') return { refused: 'closed', current: row }
  if (row.delivered_at_ms === null) {
    let out: 'delivered' | 'later' | 'closed'
    try {
      out = await deliver(store, agent, row, p.at.nowMs)
    } catch (err) {
      console.error({ event: 'question_resume_failed', questionId: row.id, error: err instanceof Error ? err.name : 'unknown' })
      return { unavailable: row }
    }
    row = (await store.get(row.id))!
    if (out === 'closed') return { refused: 'closed', current: row }
  }
  return { ok: row }
}

/** At most this many chats per `waits` call (BrandAgent `questionWaits` refuses more). */
export const WAITS_BATCH = 100

/** The question each chat waits on, asked in batches of `WAITS_BATCH`. */
async function waitsOf(agent: QuestionAgent, chatIds: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  for (let i = 0; i < chatIds.length; i += WAITS_BATCH) Object.assign(out, await agent.waits(chatIds.slice(i, i + WAITS_BATCH)))
  return out
}

/**
 * The open questions asked of this viewer, oldest first, each one's wait checked: a question its turn no longer waits
 * on is withdrawn here (`closed`) and left out. First, the viewer's own answers whose resume never landed (the object
 * was unreachable) are resumed again, so a reload unblocks the chat. Throws when the BrandAgent can't say.
 */
export async function openQuestions(store: QuestionStore, agent: QuestionAgent, viewer: QuestionViewer, nowMs: number): Promise<QuestionRow[]> {
  for (const r of await store.undeliveredBy(viewer.memberId)) await deliver(store, agent, r, nowMs)
  const rows = await store.openFor(viewer, nowMs)
  if (rows.length === 0) return []
  const waits = await waitsOf(agent, [...new Set(rows.map(r => r.chat_id))])
  const live: QuestionRow[] = []
  for (const r of rows) {
    if (waits[r.chat_id] === r.id) live.push(r)
    else await store.withdraw(r.id, nowMs)
  }
  return live
}
