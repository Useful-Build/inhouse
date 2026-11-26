// Questions (Stage 1 M2-Q, N16), case by case, on the real turn engine and D1. Ways it could fail, written first:
//  1. a deferral asks twice (a retried hook, or the same call deferred again), asks with the tool's input unchecked,
//     or leaves the chat waiting on a question nobody can see;
//  2. a routine's question goes to someone other than its creator (while an active person), else every admin;
//  3. the bell or the audit line is missing, doubled, or carries the question's words;
//  4. a question is answered by someone it wasn't asked of, with a choice that isn't an option, or twice by two admins;
//  5. expiry: an open question past 7 days isn't closed, its people aren't told, or its turn keeps waiting; a question
//     whose turn no longer waits is expired (and resumed) instead of withdrawn;
//  6. the list shows another person's question, an admin's question to a member, or one already expired.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { RunEventBody } from '../../shared/protocol/index.ts'
import type { SendTurnResult } from '../../shared/contract/runs.ts'
import { MEMBER, OTHER, SEC, d1Chat, ev, inAgent, settle } from '../testing/brand-agent/core-harness.ts'
import type { Harness } from '../testing/brand-agent/core-harness.ts'
import type { InternalSubmit, Refusal } from '../do/brand-agent/ports.ts'
import { internalSubmit } from '../do/brand-agent/task-ops.ts'
import { questionWaits, waitingQuestionOf } from './agent.ts'
import { expiryTaskId, questionOnDeferred } from './ask.ts'
import { answerQuestion, openQuestions } from './flow.ts'
import type { QuestionAgent } from './flow.ts'
import { questionStore } from './store.ts'
import { QUESTION_TTL_MS, toQuestion } from './types.ts'
import type { QuestionRow } from './types.ts'

const db = env.DB
const store = questionStore({ db })
const OPTIONS = ['Yes', 'No']
const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
const agentOf = (h: Harness): QuestionAgent => ({ waits: async ids => questionWaits(h.sql, ids), resume: (c, q) => h.core.resumeDeferred(c, 'allow', q) })
const resumes = (h: Harness, id: string) => h.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM turns WHERE client_key = ?', `resume_${id}`).one().n
const at = (h: Harness, actorId = MEMBER) => ({ actorId, requestId: `req-${crypto.randomUUID()}`, nowMs: h.clock.now })
const lines = async (action: string, id: string) =>
  (await db.prepare("SELECT args_json FROM audit_log WHERE action = ? AND json_extract(args_json, '$.questionId') = ?").bind(action, id).all<{ args_json: string }>()).results.map(r => JSON.parse(r.args_json) as unknown)
const notices = async (id: string) =>
  (await db.prepare("SELECT id, audience, audience_member_id, template, body, waiting FROM notices WHERE id IN (?, ?)").bind(`qw_${id}`, `qc_${id}`).all()).results

let n = 0
/** A turn in `chatId` that defers `question_ask` with `input`; the hook runs. Returns the asking turn. */
async function ask(h: Harness, chatId: string, input: unknown, o: { submit?: () => Promise<SendTurnResult | Refusal>; toolUseId?: string } = {}) {
  const a = ok(await (o.submit ? o.submit() : h.submit(chatId, `key-q-${String(++n).padStart(6, '0')}`)))
  await settle()
  const deferred: RunEventBody = { type: 'deferred', toolUseId: o.toolUseId ?? 'tu_ask', toolName: 'mcp__inhouse__question_ask', input }
  h.push(a.turnId, ev.started(), deferred, ev.checkpoint(2, 'u2', 1), ev.success(), ev.released({ mainEntries: 2, lastUuid: 'u2', lastUuidIndex: 1 }))
  await h.tick(SEC)
  return a
}
const qid = (turnId: string) => `q_${turnId.slice(2)}`
const row = async (id: string) => (await store.get(id))!

describe('asking (failures 1 and 3)', () => {
  it('one question per deferral: the row, one asked line with no words, one waiting bell notice for the owner, and its expiry', () => inAgent(async h => {
    h.core.setOnDeferred(questionOnDeferred)
    await d1Chat('c-ask-1', MEMBER)
    const a = await ask(h, 'c-ask-1', { question: ' Ship the late order today? ', options: OPTIONS })
    const id = qid(a.turnId)
    expect(await row(id)).toMatchObject({
      chat_id: 'c-ask-1', turn_id: a.turnId, tool_use_id: 'tu_ask', asked_of: MEMBER, asked_as: 'owner', question: 'Ship the late order today?',
      options_json: JSON.stringify(OPTIONS), state: 'open', answer: null, created_at_ms: h.clock.now, expires_at_ms: h.clock.now + QUESTION_TTL_MS,
    })
    expect(await lines('question.asked', id)).toEqual([{ questionId: id, askedOf: 'owner', options: 2 }])
    expect(await notices(id)).toEqual([{ id: `qw_${id}`, audience: 'member', audience_member_id: MEMBER, template: 'question_waiting', body: null, waiting: 1 }])
    expect(h.dueTasks().find(t => t.id === expiryTaskId(id))).toEqual({ id: expiryTaskId(id), due_at_ms: h.clock.now + QUESTION_TTL_MS })
    expect(waitingQuestionOf(h.sql, 'c-ask-1')).toBe(id)
    // The hook again (a revive, a retry): nothing new.
    await questionOnDeferred({ questionId: id, chatId: 'c-ask-1', turnId: a.turnId, runId: a.runId, ownerId: MEMBER, toolUseId: 'tu_ask', toolName: 'mcp__inhouse__question_ask', input: { question: 'Ship the late order today?', options: OPTIONS } },
      { env, nowMs: h.clock.now, scheduler: h.sched, resumeDeferred: () => { throw new Error('no resume') } } as never)
    expect(await lines('question.asked', id)).toHaveLength(1)
    expect(await notices(id)).toHaveLength(1)
  }))

  it('an input the tool would refuse asks nothing: the call runs again at once (a resume), so the agent reads the refusal', () => inAgent(async h => {
    h.core.setOnDeferred(questionOnDeferred)
    await d1Chat('c-ask-bad', MEMBER)
    for (const input of [{ question: 'Which?', options: ['Only one'] }, { question: 'Which?', options: ['A', 'A'] }, { question: '', options: OPTIONS }, { q: 1 }]) {
      const a = await ask(h, 'c-ask-bad', input)
      expect(await store.get(qid(a.turnId))).toBeNull()
      expect(resumes(h, qid(a.turnId))).toBe(1)
      expect(waitingQuestionOf(h.sql, 'c-ask-bad')).toBeNull()
      const r = h.turns().find(t => t.client_key === `resume_${qid(a.turnId)}`)!
      h.push(r.turn_id, ev.started(), ev.text('fixed'), ev.checkpoint(3, 'u3', 2), ev.success(), ev.released({ mainEntries: 3, lastUuid: 'u3', lastUuidIndex: 2 }))
      await settle()
    }
  }))

  it('the same call deferred again on its resume asks nothing new: the call runs and reads its question', () => inAgent(async h => {
    h.core.setOnDeferred(questionOnDeferred)
    await d1Chat('c-ask-again', MEMBER)
    const a = await ask(h, 'c-ask-again', { question: 'Which?', options: OPTIONS }, { toolUseId: 'tu_same' })
    const first = qid(a.turnId)
    const out = await answerQuestion(store, agentOf(h), { id: first, choice: 'Yes', viewer: { memberId: MEMBER, role: 'member' }, at: at(h) })
    expect('ok' in out).toBe(true)
    const r = h.turns().find(t => t.client_key === `resume_${first}`)!
    await settle()
    // The resume turn defers the same call again (the runner never should; this is the server's own guard).
    h.push(r.turn_id, ev.started(), { type: 'deferred', toolUseId: 'tu_same', toolName: 'mcp__inhouse__question_ask', input: { question: 'Which?', options: OPTIONS } },
      ev.checkpoint(3, 'u3', 2), ev.success(), ev.released({ mainEntries: 3, lastUuid: 'u3', lastUuidIndex: 2 }))
    await h.tick(SEC)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM questions WHERE chat_id = ?').bind('c-ask-again').first<number>('n'))).toBe(1)
    expect(resumes(h, qid(r.turn_id))).toBe(1)
  }))
})

describe("who is asked (failure 2)", () => {
  /** A routine's slot naming this chat, its routine made by `creator`. */
  async function routineChat(chatId: string, creator: string, status: 'active' | 'removed', kind = 'person') {
    const rt = `rt_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO members (id, kind, role, status, created_at_ms) VALUES (?, ?, 'member', ?, 0)").bind(creator, kind, status),
      db.prepare(`INSERT INTO routines (id, origin, name, instruction, days_mask, hour, minute, missed, need, creator_id, checked_until_ms, created_at_ms, updated_at_ms)
        VALUES (?, 'team', 'Stock check', 'Check stock', 127, 6, 0, 'skip', 0, ?, 0, 0, 0)`).bind(rt, creator),
      db.prepare(`INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, tz, due_at_ms, deadline_ms, state, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, claimed_at_ms)
        VALUES (?, ?, 'manual', '2100-01-01', 'UTC', 0, 0, 'started', ?, ?, 'x', '{}', 1, ?, 0)`).bind(`${rt}:m`, rt, chatId, `k_${rt}`, creator),
    ])
    await d1Chat(chatId, 'm_system')
  }
  const routineSubmit = (h: Harness, chatId: string) => () => internalSubmit(h.core, h.sql, h.registry, {
    chatId, by: { kind: 'service', memberId: 'm_system' }, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'high', sideModel: 'claude-haiku-5-5',
    maxTurns: 25, webFetchDomains: null, input: { clientTurnKey: `key-r-${String(++n).padStart(6, '0')}`, text: 'routine', priority: 'next', model: 'sonnet', attachments: [] },
  } satisfies InternalSubmit)

  it("a routine's question goes to its creator while an active person; the admins see it, but no chat", () => inAgent(async h => {
    h.core.setOnDeferred(questionOnDeferred)
    await routineChat('c-rt-1', 'm_creator1', 'active')
    const a = await ask(h, 'c-rt-1', { question: 'Reorder?', options: OPTIONS }, { submit: routineSubmit(h, 'c-rt-1') })
    const r = await row(qid(a.turnId))
    expect({ asked_of: r.asked_of, asked_as: r.asked_as }).toEqual({ asked_of: 'm_creator1', asked_as: 'creator' })
    expect(toQuestion(r).chatId).toBeNull()
    expect(await lines('question.asked', r.id)).toEqual([{ questionId: r.id, askedOf: 'creator', options: 2 }])
  }))

  it('a removed creator: every admin, the first answer wins, a member is refused, and a second admin gets the first answer', () => inAgent(async h => {
    h.core.setOnDeferred(questionOnDeferred)
    await routineChat('c-rt-2', 'm_creator2', 'removed')
    const a = await ask(h, 'c-rt-2', { question: 'Reorder?', options: OPTIONS }, { submit: routineSubmit(h, 'c-rt-2') })
    const id = qid(a.turnId)
    expect(await row(id)).toMatchObject({ asked_of: 'admins', asked_as: 'admins' })
    expect(await notices(id)).toEqual([{ id: `qw_${id}`, audience: 'admins', audience_member_id: null, template: 'question_waiting', body: null, waiting: 1 }])
    for (const m of ['m_adm1', 'm_adm2']) await db.prepare("INSERT OR IGNORE INTO members (id, kind, role, status, created_at_ms) VALUES (?, 'person', 'admin', 'active', 0)").bind(m).run()
    const agent = agentOf(h)
    expect(await answerQuestion(store, agent, { id, choice: 'No', viewer: { memberId: OTHER, role: 'member' }, at: at(h, OTHER) })).toEqual({ refused: 'not_found' })
    expect((await openQuestions(store, agent, { memberId: OTHER, role: 'member' }, h.clock.now))).toEqual([])
    expect((await openQuestions(store, agent, { memberId: 'm_adm1', role: 'admin' }, h.clock.now)).map(r => r.id)).toEqual([id])
    const [x, y] = await Promise.all([
      answerQuestion(store, agent, { id, choice: 'Yes', viewer: { memberId: 'm_adm1', role: 'admin' }, at: at(h, 'm_adm1') }),
      answerQuestion(store, agent, { id, choice: 'No', viewer: { memberId: 'm_adm2', role: 'admin' }, at: at(h, 'm_adm2') }),
    ])
    const won = [x, y].filter(o => 'ok' in o)
    expect(won).toHaveLength(1)
    expect([x, y].filter(o => 'refused' in o && o.refused === 'conflict')).toHaveLength(1)
    expect(resumes(h, id)).toBe(1)
    expect(await lines('question.answered', id)).toHaveLength(1)
  }))

  it("a person's chat: the owner only; a choice that isn't an option is refused", () => inAgent(async h => {
    h.core.setOnDeferred(questionOnDeferred)
    await d1Chat('c-own', MEMBER)
    const a = await ask(h, 'c-own', { question: 'Which?', options: OPTIONS })
    const id = qid(a.turnId)
    const agent = agentOf(h)
    expect(await answerQuestion(store, agent, { id, choice: 'Yes', viewer: { memberId: OTHER, role: 'admin' }, at: at(h, OTHER) })).toEqual({ refused: 'not_found' })
    expect(await answerQuestion(store, agent, { id, choice: 'Maybe', viewer: { memberId: MEMBER, role: 'member' }, at: at(h) })).toMatchObject({ refused: 'invalid' })
    expect((await openQuestions(store, agent, { memberId: OTHER, role: 'admin' }, h.clock.now))).toEqual([])
    const out = await answerQuestion(store, agent, { id, choice: 'No', viewer: { memberId: MEMBER, role: 'member' }, at: at(h) })
    expect('ok' in out && out.ok).toMatchObject({ state: 'answered', answer: 'No', answered_by: MEMBER, answered_at_ms: h.clock.now })
    expect(await lines('question.answered', id)).toEqual([{ questionId: id }])
    expect(resumes(h, id)).toBe(1)
    expect((await openQuestions(store, agent, { memberId: MEMBER, role: 'member' }, h.clock.now))).toEqual([])
  }))
})

describe('expiry (failure 5)', () => {
  it('7 days on: expired, one closed notice, its line, and the turn resumes once to read that nobody answered', () => inAgent(async h => {
    h.core.setOnDeferred(questionOnDeferred)
    await d1Chat('c-exp', MEMBER)
    const a = await ask(h, 'c-exp', { question: 'Which?', options: OPTIONS })
    const id = qid(a.turnId)
    await h.tick(QUESTION_TTL_MS - 2 * SEC)
    expect((await row(id)).state).toBe('open')
    await h.tick(2 * SEC)
    const r: QuestionRow = await row(id)
    expect(r).toMatchObject({ state: 'expired', answer: null, ended_at_ms: h.clock.now })
    expect(await lines('question.expired', id)).toEqual([{ questionId: id }])
    expect((await notices(id)).map(x => x.id)).toEqual([`qw_${id}`, `qc_${id}`].sort())
    expect(resumes(h, id)).toBe(1)
    expect(waitingQuestionOf(h.sql, 'c-exp')).toBeNull()
    // An answer now: closed.
    expect(await answerQuestion(store, agentOf(h), { id, choice: 'Yes', viewer: { memberId: MEMBER, role: 'member' }, at: at(h) })).toMatchObject({ refused: 'closed' })
  }))

  it('a question whose turn no longer waits (the chat reset) is withdrawn at its expiry: no expiry line, no notice, no resume', () => inAgent(async h => {
    h.core.setOnDeferred(questionOnDeferred)
    await d1Chat('c-exp-reset', MEMBER)
    const a = await ask(h, 'c-exp-reset', { question: 'Which?', options: OPTIONS })
    const id = qid(a.turnId)
    expect(h.core.resetSession('c-exp-reset', { kind: 'person', memberId: MEMBER })).toEqual({ ok: true })
    await h.tick(QUESTION_TTL_MS)
    expect(await row(id)).toMatchObject({ state: 'closed', answer: null })
    expect(await lines('question.expired', id)).toEqual([])
    expect((await notices(id)).map(x => x.id)).toEqual([`qw_${id}`])
    expect(resumes(h, id)).toBe(0)
  }))
})
