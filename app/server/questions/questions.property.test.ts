// The wait, the answer and the resume (Stage 1 M2-Q, N16), as random sequences against the real turn engine (AgentCore
// over a BrandAgent's real SQLite, core-harness.ts) and the real `questions` table in D1. Each step is one of: the
// agent asks (a turn defers its lone `question_ask`), the owner or another member answers (some choices twice, some
// at once), the object can't be reached for one resume (before it, or after it landed with the reply lost), the chat
// is reset or deleted (the wait given up), the brand pauses or resumes, the list is read, the resume turn ends, and the
// clock jumps (a minute, or past the 7-day expiry). Invariants, written before the code:
//  Q1. no doubled resume: a question is resumed by at most one turn;
//  Q2. a question is answered once (one `question.answered` line), and a resume is for an answered question with that
//      first answer, or for an expired one (no answer), never another;
//  Q3. an answer after its wait was given up resumes nothing: refused `closed`, and no resume turn for that question;
//  Q4. a question its turn no longer waits on is withdrawn when the list is read: no open, unexpired question of the
//      chat is left that the chat doesn't wait on (unless the chat is in the trash: kept open, unlisted, for a restore);
//  Q5. no lost resume: once the object is reachable again and the answer is retried (or its expiry runs), every
//      answered question has exactly one resume turn and is marked delivered; and the call the SDK runs again on that
//      resume reads the stored answer (the option chosen).
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { describe, expect } from 'vitest'
import { OTHER, MIN, SEC, d1Chat, ev, fullAnswer, inAgent, settle } from '../testing/brand-agent/core-harness.ts'
import type { Harness } from '../testing/brand-agent/core-harness.ts'
import type { RunEventBody } from '../../shared/protocol/index.ts'
import { handlers } from '../mcp/tools/questions/index.ts'
import { questionWaits, waitingQuestionOf } from './agent.ts'
import { questionOnDeferred } from './ask.ts'
import { answerQuestion, openQuestions } from './flow.ts'
import type { AnswerOutcome, QuestionAgent } from './flow.ts'
import { questionStore } from './store.ts'
import { QUESTION_TTL_MS } from './types.ts'
import type { QuestionRow } from './types.ts'
import { dataOf } from '../mcp/server/test-support.ts'

const ADMIN = { kind: 'person' as const, memberId: 'm_admin' }
const OPTIONS = ['Ship today', 'Wait for stock', 'Ask the supplier']

type Op =
  | { k: 'ask' }
  | { k: 'answer'; who: 'owner' | 'other'; choice: number; twice: boolean; together: boolean }
  | { k: 'unreachable'; lost: boolean }
  | { k: 'reset' } | { k: 'delete' }
  | { k: 'pause' } | { k: 'unpause' }
  | { k: 'list' } | { k: 'finish' }
  | { k: 'tick'; ms: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.constant({ k: 'ask' as const }) },
  { weight: 6, arbitrary: fc.record({ k: fc.constant('answer' as const), who: fc.constantFrom('owner' as const, 'owner' as const, 'other' as const), choice: fc.integer({ min: 0, max: 2 }), twice: fc.boolean(), together: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('unreachable' as const), lost: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ k: 'reset' as const }) },
  { weight: 1, arbitrary: fc.constant({ k: 'delete' as const }) },
  { weight: 1, arbitrary: fc.constant({ k: 'pause' as const }) },
  { weight: 2, arbitrary: fc.constant({ k: 'unpause' as const }) },
  { weight: 2, arbitrary: fc.constant({ k: 'list' as const }) },
  { weight: 3, arbitrary: fc.constant({ k: 'finish' as const }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('tick' as const), ms: fc.constantFrom(MIN, 2 * MIN, QUESTION_TTL_MS + SEC) }) },
)

let cases = 0
const store = questionStore({ db: env.DB })

/** The flow's BrandAgent: the harness's own object, as the routes reach it (questionWaits, questionResume). */
function agentOf(h: Harness, fault: { next: null | 'before' | 'lost' }): QuestionAgent {
  return {
    waits: async ids => questionWaits(h.sql, ids),
    resume: async (chatId, questionId) => {
      const f = fault.next
      fault.next = null
      if (f === 'before') throw new Error('the object could not be reached')
      const r = await h.core.resumeDeferred(chatId, 'allow', questionId)
      if (f === 'lost') throw new Error('the reply was lost')
      return r
    },
  }
}

const resumes = (h: Harness, id: string) =>
  h.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM turns WHERE client_key = ?', `resume_${id}`).one().n
/** Each case's own owner, so the shared D1's rows of another case (an undelivered answer) are never this one's. */
let MEMBER = ''
const viewerOf = (who: 'owner' | 'other') => ({ memberId: who === 'owner' ? MEMBER : OTHER, role: 'member' as const })

async function run(ops: Op[]): Promise<void> {
  const chat = `c-qprop-${++cases}`
  MEMBER = `m_qprop_${cases}`
  await d1Chat(chat, MEMBER)
  await d1Chat(`c-qprop-other-${cases}`, OTHER)
  await inAgent(async h => {
    h.core.setOnDeferred(questionOnDeferred)
    const fault: { next: null | 'before' | 'lost' } = { next: null }
    const agent = agentOf(h, fault)
    const asked: string[] = []
    /** Questions whose wait was given up before any resume (the reset, the delete). */
    const givenUp = new Set<string>()
    /** The first answer each question took, as the flow reported it. */
    const first = new Map<string, string>()
    let entries = 1
    let deleted = false
    let paused = false
    const rows = async () => (await env.DB.prepare('SELECT * FROM questions WHERE chat_id = ?').bind(chat).all<QuestionRow>()).results
    const answer = async (id: string, who: 'owner' | 'other', choice: string): Promise<AnswerOutcome> => {
      const out = await answerQuestion(store, agent, { id, choice, viewer: viewerOf(who), at: { actorId: viewerOf(who).memberId, requestId: `req-${crypto.randomUUID()}`, nowMs: h.clock.now } })
      // The answer the question took, as the flow reported it (kept, even when its resume couldn't be reached).
      const took = 'ok' in out ? out.ok : 'unavailable' in out ? out.unavailable : null
      if (took !== null && !first.has(id)) first.set(id, took.answer!)
      return out
    }
    /** Ends every turn that is running (the resume turns), as a whole answer. */
    const finish = async () => {
      for (const t of h.turns().filter(t => t.state === 'live' || t.state === 'starting')) {
        h.push(t.turn_id, ...fullAnswer('done', ++entries))
        await settle()
      }
    }

    for (const op of ops) {
      switch (op.k) {
        case 'ask': {
          if (deleted || paused) break
          // The resume turn before it (if any) ends first, so a chat can ask again.
          await finish()
          const n = asked.length
          const a = await h.submit(chat, `key-ask-${String(n).padStart(4, '0')}`, { member: MEMBER })
          if ('refused' in a) break
          await settle()
          const deferred: RunEventBody = { type: 'deferred', toolUseId: `tu_${n}`, toolName: 'mcp__inhouse__question_ask', input: { question: `Which way, ${n}?`, options: OPTIONS } }
          entries++
          h.push(a.turnId, ev.started(), deferred, ev.checkpoint(entries, `u${entries}`, entries - 1), ev.success(),
            ev.released({ mainEntries: entries, lastUuid: `u${entries}`, lastUuidIndex: entries - 1 }))
          await h.tick(SEC)
          const q = await store.byToolUse(chat, `tu_${n}`)
          if (q) asked.push(q.id)
          break
        }
        case 'answer': {
          const id = asked.at(-1)
          if (id === undefined) break
          const gone = givenUp.has(id)
          const choice = OPTIONS[op.choice]!
          const outs = op.together
            ? await Promise.all([answer(id, op.who, choice), answer(id, op.who, op.twice ? choice : OPTIONS[(op.choice + 1) % 3]!)])
            : [await answer(id, op.who, choice), ...(op.twice ? [await answer(id, op.who, choice)] : [])]
          await settle()
          for (const out of outs) {
            if (op.who === 'other') expect(out).toEqual({ refused: 'not_found' })
            // Q3: after a give-up, nothing resumes: refused, or kept for a retry when the object couldn't be reached (a
            // deleted chat's wait is only found gone by the resume itself).
            if (gone && op.who === 'owner') expect(!('ok' in out), JSON.stringify(out)).toBe(true)
          }
          if (gone) expect(resumes(h, id)).toBe(0)
          break
        }
        case 'unreachable': fault.next = op.lost ? 'lost' : 'before'; break
        case 'reset': {
          const w = waitingQuestionOf(h.sql, chat)
          if ('ok' in h.core.resetSession(chat, { kind: 'person', memberId: MEMBER }) && w !== null && resumes(h, w) === 0) givenUp.add(w)
          break
        }
        case 'delete': {
          const w = waitingQuestionOf(h.sql, chat)
          await d1Chat(chat, MEMBER, h.clock.now)
          deleted = true
          if (w !== null && resumes(h, w) === 0) givenUp.add(w)
          break
        }
        case 'pause': await h.core.pause(ADMIN); paused = true; break
        case 'unpause': await h.core.resume(ADMIN); paused = false; break
        case 'list': {
          // The list resumes this person's undelivered answers first, so an unreachable object fails it (loud), as the
          // route's 500 would; nothing else is checked then.
          try {
            await openQuestions(store, agent, { memberId: MEMBER, role: 'member' }, h.clock.now)
          } catch (e) {
            if (!(e instanceof Error) || !/could not be reached|reply was lost/.test(e.message)) throw e
            break
          }
          // Q4.
          const waits = waitingQuestionOf(h.sql, chat)
          // (A chat in the trash keeps its question open, unlisted, so a restore brings it back.)
          if (!deleted) for (const r of await rows()) if (r.state === 'open' && r.expires_at_ms > h.clock.now) expect(r.id).toBe(waits)
          break
        }
        case 'finish': await finish(); break
        case 'tick': await h.tick(op.ms); break
      }
      // Q1 and Q2 after every step.
      for (const r of await rows()) {
        const n = resumes(h, r.id)
        expect(n, r.id).toBeLessThanOrEqual(1)
        if (n === 1) {
          expect(r.state === 'answered' || r.state === 'expired' || (r.state === 'closed' && r.answer !== null), JSON.stringify(r)).toBe(true)
          if (r.state === 'expired') expect(r.answer).toBeNull()
          if (r.answer !== null) expect(r.answer).toBe(first.get(r.id) ?? r.answer)
        }
        if (first.has(r.id)) expect(r.answer).toBe(first.get(r.id))
        // The first answer wins: answered once, one `question.answered` line.
        const lines = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'question.answered' AND json_extract(args_json, '$.questionId') = ?").bind(r.id).first<number>('n')
        expect(lines, r.id).toBeLessThanOrEqual(1)
      }
    }

    // Q5: the object reachable again, the brand resumed; each undelivered answer retried by its answerer, the core's own
    // retries and the expiry tasks run.
    fault.next = null
    if (paused) await h.core.resume(ADMIN)
    await h.tick(2 * MIN)
    for (const r of await rows()) {
      if (r.state === 'answered' && r.delivered_at_ms === null) await answer(r.id, r.answered_by === MEMBER ? 'owner' : 'other', r.answer!)
    }
    await openQuestions(store, agent, { memberId: MEMBER, role: 'member' }, h.clock.now)
    for (const r of await rows()) {
      const n = resumes(h, r.id)
      if (r.state === 'answered') {
        expect(n, `answered ${r.id}`).toBe(1)
        expect(r.delivered_at_ms).not.toBeNull()
        // The call the SDK runs again on the resume: the option the person chose.
        const out = await handlers.question_ask!.call({ question: r.question, options: JSON.parse(r.options_json) as string[] }, {
          memberId: MEMBER, chatId: chat, runId: 'r_x', turnId: 't_x', nowMs: h.clock.now, requestId: 'req-x', toolUseId: r.tool_use_id,
        }, { db: env.DB })
        expect(dataOf(out)).toEqual({ question_id: r.id, state: 'answered', answer: first.get(r.id) })
      }
      if (r.state === 'open' && !deleted) expect(r.expires_at_ms > h.clock.now && waitingQuestionOf(h.sql, chat) === r.id, JSON.stringify(r)).toBe(true)
      if (givenUp.has(r.id)) expect(n).toBe(0)
    }
  })
}

describe('questions: the wait, the answer and the resume (property)', () => {
  test.prop([fc.array(opArb, { minLength: 1, maxLength: 14 })], { numRuns: 100 })('Q1 to Q5 hold over random steps', ops => run(ops))

  test('Q5 by example: a reply lost after the resume landed, then the same answer again: one resume, delivered', () =>
    run([{ k: 'ask' }, { k: 'unreachable', lost: true }, { k: 'answer', who: 'owner', choice: 1, twice: false, together: false }, { k: 'answer', who: 'owner', choice: 1, twice: false, together: false }]))

  test('Q5 by example (the paused-brand bug): ask, pause, answer, reset, unpause: the answer is closed, never read as delivered', () =>
    run([{ k: 'ask' }, { k: 'pause' }, { k: 'answer', who: 'owner', choice: 2, twice: false, together: false }, { k: 'reset' }, { k: 'unpause' }, { k: 'tick', ms: 2 * MIN }]))

  test('Q3 by example: reset, then the answer: closed, nothing resumed', () =>
    run([{ k: 'ask' }, { k: 'reset' }, { k: 'answer', who: 'owner', choice: 0, twice: true, together: false }]))
})
