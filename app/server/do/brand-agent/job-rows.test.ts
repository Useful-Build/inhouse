// M1-D (from #441's review): what a reloaded chat keeps of a long job's turns and of every turn the server wrote, on the
// BrandAgent's real SQLite and the test D1. Expected values are literals written here. Ways it could fail, written first:
//  1. a promoted root keeps its failed end row, so a reload shows "needed more steps" and Try again while the job runs;
//  2. a continuation that hit its limit, or failed and is retried, keeps a failure row instead of carrying on;
//  3. a failure that ends the job loses its row, or its Try again names the server's text;
//  4. Cancel on a live continuation leaves no stopped note;
//  5. a reload shows an action's or a question's resume as the person's message, or a page loses rows to the filter;
//  6. the agent's history tools read the server's own notes back as something the person said.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import { chatStore } from '../../db/chats.ts'
import { historyStore } from '../../mcp/tools/history/store.ts'
import { MEMBER, d1Chat, ev, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../testing/brand-agent/core-harness.ts'
import { CARRY_ON, fakeJobDeps, jobsOf, wireJobs } from '../../testing/brand-agent/job-kit.ts'
import type { RunEventBody } from '../../../shared/protocol/index.ts'
import type { Refusal, SubmitTurn } from './ports.ts'
import { storedProjection } from './projection.ts'

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
let CHAT = ''
let chats = 0
beforeEach(() => { CHAT = `c_m1d${++chats}_${Math.random().toString(36).slice(2, 8)}` })

const turn = (key: string): SubmitTurn => ({
  chatId: CHAT, by: { kind: 'person', memberId: MEMBER }, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium',
  sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: [],
  input: { clientTurnKey: key, text: `question ${key}`, priority: 'next', model: 'sonnet', attachments: [] },
})
const cp = (n: number) => ({ mainEntries: n, lastUuid: `u${n}`, lastUuidIndex: n - 1 })
const maxTurns = (n: number): RunEventBody[] => [ev.started(), ev.tool('Bash'), ev.text('working'), ev.checkpoint(n, `u${n}`, n - 1), ev.finished('error_max_turns'), ev.released(cp(n))]
const ids = (h: Harness, turnId: string) => storedProjection(h.sql, turnId)!.rows.map(r => r.id)

/** A root that hit its limit and became a job, and its first continuation, submitted (not yet run). */
async function promoted(h: Harness, key: string) {
  await d1Chat(CHAT, MEMBER)
  wireJobs(h, fakeJobDeps())
  const root = ok(await h.core.submitTurn(turn(key)))
  await settle()
  h.push(root.turnId, ...maxTurns(3))
  await settle()
  await h.tick(0)
  const [job] = jobsOf(h)
  expect(job).toMatchObject({ root_turn_id: root.turnId, state: 'running' })
  const cont = h.turns().find(t => t.job_id === job!.job_id && t.turn_id !== root.turnId)!
  expect(cont).toMatchObject({ source: 'job', text: CARRY_ON(1) })
  return { root, job: job!, cont }
}

describe("a long job's turns after a reload", () => {
  it('a promoted root keeps no failed end row: only the question and its parts (failure 1)', () => inAgent(async h => {
    const { root } = await promoted(h, 'key-rows1')
    expect(ids(h, root.turnId)).toEqual([`${root.turnId}.u`, `${root.turnId}.0`])
  }))

  it('a continuation that hit its limit, or crashed and is retried, keeps no failure row (failure 2)', () => inAgent(async h => {
    const { cont } = await promoted(h, 'key-rows2')
    h.push(cont.turn_id, ...maxTurns(5))
    await settle()
    expect(ids(h, cont.turn_id).filter(id => id.endsWith('.f'))).toEqual([])
    await h.tick(0)
    const next = h.turns().find(t => t.job_id === cont.job_id && t.job_n === 2)!
    h.push(next.turn_id, ev.started(), ev.failed('session_crashed'), ev.released(cp(5)))
    await settle()
    expect(ids(h, next.turn_id)).toEqual([`${next.turn_id}.u`])
    expect(storedProjection(h.sql, next.turn_id)!.rows[0]).toMatchObject({ role: 'user', extra_json: JSON.stringify({ source: 'job' }) })
  }))

  it("a failure that ends the job keeps its row, and Try again asks the person's question (failure 3)", () => inAgent(async h => {
    const { cont } = await promoted(h, 'key-rows3')
    h.push(cont.turn_id, ev.started(), ev.failed('sdk_error'), ev.released(cp(3)))
    await settle()
    const end = storedProjection(h.sql, cont.turn_id)!.rows.at(-1)!
    expect(end.id).toBe(`${cont.turn_id}.f`)
    expect(JSON.parse(end.extra_json!)).toEqual({ failure: 'sdk_error', retryQuestion: 'question key-rows3' })
  }))

  it('a job row gone when a continuation ends: logged loudly, and the end row is still stored with no question (failure 3)', () => inAgent(async h => {
    const { cont, job } = await promoted(h, 'key-rows5')
    h.sql.exec('DELETE FROM jobs WHERE job_id = ?', job.job_id)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      h.push(cont.turn_id, ev.started(), ev.failed('sdk_error'), ev.released(cp(3)))
      await settle()
      expect(errors).toHaveBeenCalledWith({ event: 'projection_job_question_missing', turnId: cont.turn_id, jobId: job.job_id })
    } finally {
      errors.mockRestore()
    }
    const end = storedProjection(h.sql, cont.turn_id)!.rows.at(-1)!
    expect(end.id).toBe(`${cont.turn_id}.f`)
    expect(JSON.parse(end.extra_json!)).toEqual({ failure: 'sdk_error', retryQuestion: '' })
  }))

  it("Cancel on a live continuation keeps the stopped note (failure 4)", () => inAgent(async h => {
    const { cont, job } = await promoted(h, 'key-rows4')
    h.push(cont.turn_id, ev.started())
    await settle()
    const answer = h.core.cancelJob(job.job_id, { kind: 'person', memberId: MEMBER })
    expect(answer).toMatchObject({ job: { state: 'ended', outcome: 'cancelled' } })
    h.push(cont.turn_id, ev.released(cp(3)))
    await settle()
    const end = storedProjection(h.sql, cont.turn_id)!.rows.at(-1)!
    expect(end).toMatchObject({ id: `${cont.turn_id}.x`, extra_json: JSON.stringify({ outcome: 'stopped' }) })
  }))
})

describe('server-written rows in D1 (failures 5 and 6)', () => {
  const insert = async (rows: { id: string; pos: number; role: string; text: string; extra: object | null; part?: object }[]) => {
    for (const r of rows) {
      await env.DB.prepare(`INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, author_id, text, part_json, extra_json, model, at_ms)
        VALUES (?, ?, 'r_1', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .bind(r.id, CHAT, r.id.split('.')[0].slice(CHAT.length), r.pos, r.role, r.role === 'user' ? MEMBER : null, r.text, r.part ? JSON.stringify(r.part) : null,
          r.extra === null ? null : JSON.stringify(r.extra), 1_000 + r.pos).run()
    }
  }
  // Row ids are D1-wide: each test's are its chat's own.
  const rows = () => [
    { id: 't_a.u', pos: 0, role: 'user', text: 'Which zebra orders shipped?', extra: null },
    { id: 't_a.0', pos: 1, role: 'agent', text: 'Two zebra orders shipped.', extra: { trace: 't_a' }, part: { type: 'text', text: 'Two zebra orders shipped.' } },
    { id: 't_b.u', pos: 2, role: 'user', text: 'Automatic note from Inhouse: carry on with the zebra task.', extra: { source: 'job' } },
    { id: 't_c.u', pos: 3, role: 'user', text: 'Automatic note from Inhouse: the zebra action was sent.', extra: { source: 'action' } },
    { id: 't_d.u', pos: 4, role: 'user', text: '', extra: { source: 'question' } },
  ].map(r => ({ ...r, id: `${CHAT}${r.id}` }))

  it("a reload shows a job's and an action's resume as the server's note, and leaves a question's out without losing a page row", async () => {
    await d1Chat(CHAT, MEMBER)
    await insert(rows())
    const page = await chatStore({ db: env.DB }).messages(CHAT, null, 4)
    expect(page.map(m => [m.id.slice(CHAT.length), m.role, m.role === 'agent' ? '' : m.text])).toEqual([
      ['t_c.u', 'event', 'Your Inhouse agent went on once the action was settled.'],
      ['t_b.u', 'event', 'Your Inhouse agent carried on with this task by itself.'],
      ['t_a.0', 'agent', ''],
      ['t_a.u', 'user', 'Which zebra orders shipped?'],
    ])
  })

  it("the agent's history tools read only what the person and the agent said", async () => {
    await d1Chat(CHAT, MEMBER)
    await insert(rows())
    const read = await historyStore({ db: env.DB }).read(MEMBER, CHAT, { fromPos: 0, limit: 10 })
    expect(read!.messages.map(m => [m.role, m.text])).toEqual([['user', 'Which zebra orders shipped?'], ['agent', 'Two zebra orders shipped.']])
    const hits = await historyStore({ db: env.DB }).search(MEMBER, 'zebra', { afterMs: null, beforeMs: null, limit: 10 })
    expect(hits.filter(x => x.chatId === CHAT).map(x => x.messageId.slice(CHAT.length)).sort()).toEqual(['t_a.0', 't_a.u'])
  })
})
