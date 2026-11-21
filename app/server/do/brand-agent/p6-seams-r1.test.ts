// #173 round 1 (p3-w1-pr6-fold-r1.md, items 1-8): the Sonnet and Opus findings, each as a test with literal oracles.
// Ways it can fail, written down first:
//  1. a wait given up while the parked turn is still `ending` (D1 trash, route 27's mark, damage) is re-parked by its
//     late `released`: no end task, a second deferred-hook; or its end fires `done` (an abandoned question's result);
//  2. the resume interrupts a parked turn still live, or a person's send overtakes a resume not yet running;
//  3. a non-wait refusal of the resume (the owner removed) leaves the chat waiting with the end parked forever;
//  4. personData deletes while a file confirm is pending (D1 and R2 writes after an await);
//  5. a revived or retried deferred-hook calls P6 for a question already resumed, reset or expired;
//  6. an interleaved pause and resume leave the hooks' last word out of step with the flag;
//  7. a busy condition or a counted table is masked by another; the old-table ALTER misses PR 6's columns; a draining
//     or full-queue resume counts toward quarantine; a delete landing inside the resume's D1 await is missed;
//  8. personData counts or deletes the system member's rows.
import { describe, expect, it } from 'vitest'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import { MEMBER, MIN, OTHER, SEC, d1Chat, deferred, ev, fullAnswer, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../testing/brand-agent/core-harness.ts'
import type { InternalSubmit, PauseEvent, Refusal } from './ports.ts'
import type { TaskHandler } from './scheduler.ts'
import { createAgentTables } from './schema.ts'
import { internalSubmit } from './task-ops.ts'

const SYSTEM = { kind: 'service' as const, memberId: 'm_system' }
const ADMIN = { kind: 'person' as const, memberId: 'm_admin' }
const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
const qid = (turnId: string) => `q_${turnId.slice(2)}`
const CP = { mainEntries: 2, lastUuid: 'u2', lastUuidIndex: 1 }
const chatRow = (h: Harness, chatId: string) =>
  h.sql.exec<{ session: string; waiting_json: string | null }>('SELECT session, waiting_json FROM chat_state WHERE chat_id = ?', chatId).one()
const taskRow = (h: Harness, id: string) =>
  h.sql.exec<{ state: string; attempts: number }>('SELECT state, attempts FROM due_tasks WHERE id = ?', id).toArray()[0] ?? null

type End = { id: string; payload: unknown }
const endKind = (log: End[]): TaskHandler => async task => { log.push({ id: task.id, payload: task.payload }); return { done: true } }
const inEnds = (fn: (h: Harness, ends: End[]) => Promise<void>) => {
  const ends: End[] = []
  return inAgent(h => fn(h, ends), { handlers: { 'test-end': endKind(ends) } })
}
function routine(h: Harness, chatId: string, key: string, o: Partial<InternalSubmit> = {}) {
  return internalSubmit(h.core, h.sql, h.registry, {
    chatId, by: SYSTEM, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'high', sideModel: 'claude-haiku-5-5',
    maxTurns: 25, webFetchDomains: null, onEnd: { kind: 'test-end', id: `test-end:${key}` },
    input: { clientTurnKey: key, text: `routine ${key}`, priority: 'next', model: 'sonnet', attachments: [] },
    ...o,
  })
}
const end = (r: SendTurnResult, chatId: string, outcome: string, failure: string | null) =>
  ({ turnId: r.turnId, runId: r.runId, chatId, outcome, failure, structuredOutput: null })

describe('item 1: a wait given up while the parked turn is still ending fires its end once, cancelled', () => {
  /** Defers with its checkpoint and terminal in, `released` not yet: the chat waits, the turn is `ending`. */
  async function parkedEnding(h: Harness, chatId: string, key: string) {
    await d1Chat(chatId, 'm_system')
    const calls: string[] = []
    h.core.setOnDeferred(async q => { calls.push(q.questionId); return { ok: true } })
    const a = ok(await routine(h, chatId, key)); await settle()
    h.push(a.turnId, ev.started(), ev.text('asking'), ev.deferred(), ev.checkpoint(2, 'u2', 1),
      { type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0.01, usage: {}, structuredOutput: { saved: 1 } })
    await h.tick(SEC)
    expect([h.turn(a.turnId).state, chatRow(h, chatId).session, calls]).toEqual(['ending', 'waiting', [qid(a.turnId)]])
    return { a, calls }
  }

  it('trashed in D1, then resume(deny), then the late released: one end {cancelled, deleted}, no re-park', () => inEnds(async (h, ends) => {
    const { a, calls } = await parkedEnding(h, 'rc-p1', 'key-rp1001')
    await d1Chat('rc-p1', 'm_system', h.clock.now)
    expect(await h.core.resumeDeferred('rc-p1', 'deny', qid(a.turnId))).toEqual({ refused: { code: 'not_found' } })
    h.push(a.turnId, ev.released(CP))
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rp1001', payload: end(a, 'rc-p1', 'cancelled', 'deleted') }])
    expect(chatRow(h, 'rc-p1')).toEqual({ session: 'none', waiting_json: null })
    expect(calls).toEqual([qid(a.turnId)])
    expect(taskRow(h, `deferred-hook:${qid(a.turnId)}`)).toBeNull()
    await h.tick(10 * MIN)
    expect(ends).toHaveLength(1)
  }))

  it("route 27's mark (D1 still live), then resume(deny), then the late released: the same", () => inEnds(async (h, ends) => {
    const { a, calls } = await parkedEnding(h, 'rc-p2', 'key-rp2001')
    h.core.endChats([{ id: 'rc-p2', rev: 2 }])
    expect(await h.core.resumeDeferred('rc-p2', 'deny', qid(a.turnId))).toEqual({ refused: { code: 'not_found' } })
    h.push(a.turnId, ev.released(CP))
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rp2001', payload: end(a, 'rc-p2', 'cancelled', 'deleted') }])
    expect(chatRow(h, 'rc-p2').session).toBe('none')
    expect(calls).toEqual([qid(a.turnId)])
  }))

  it('a delete landing inside the resume\'s D1 read counts (the mark is read after the await)', () => inEnds(async (h, ends) => {
    await d1Chat('rc-p3', 'm_system')
    const a = ok(await routine(h, 'rc-p3', 'key-rp3001')); await settle()
    h.push(a.turnId, ...[ev.started(), ev.text('x'), ev.deferred(), ev.checkpoint(2, 'u2', 1), ev.success(), ev.released(CP)])
    const gate = deferred()
    h.chatCheck.gate = gate.promise
    const pending = h.core.resumeDeferred('rc-p3', 'allow', qid(a.turnId))
    await settle()
    h.core.endChats([{ id: 'rc-p3', rev: 2 }])
    gate.resolve()
    expect(await pending).toEqual({ refused: { code: 'not_found' } })
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rp3001', payload: end(a, 'rc-p3', 'cancelled', 'deleted') }])
  }))

  it("damage (mirror_error after the parked turn's checkpoint) fires its end once {cancelled, session_damaged}", () => inEnds(async (h, ends) => {
    const { a } = await parkedEnding(h, 'rc-dmg', 'key-rdmg01')
    h.push(a.turnId, ev.mirrorError(), ev.released(CP))
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rdmg01', payload: end(a, 'rc-dmg', 'cancelled', 'session_damaged') }])
    expect(chatRow(h, 'rc-dmg').session).toBe('damaged')
  }))
})

describe('item 2: the resume never interrupts the parked turn, and runs before any later send', () => {
  it('resume while the parked turn is live: the parked turn ends done uninterrupted, then the resume runs', () => inEnds(async (h, ends) => {
    await d1Chat('rc-live', 'm_system')
    const a = ok(await routine(h, 'rc-live', 'key-rlive1')); await settle()
    h.push(a.turnId, ev.started(), ev.text('asking'), ev.deferred(), ev.checkpoint(2, 'u2', 1))
    expect([h.turn(a.turnId).state, chatRow(h, 'rc-live').session]).toEqual(['live', 'waiting'])
    const r = ok(await h.core.resumeDeferred('rc-live', 'allow', qid(a.turnId)))
    expect([r.position, h.turn(a.turnId).interrupt_asked, h.pool.calls.filter(c => c.method === 'interrupt')]).toEqual(['queued', 0, []])
    h.push(a.turnId, ev.success(), ev.released(CP))
    await settle()
    expect([h.turn(a.turnId).outcome, h.turn(r.turnId).state]).toEqual(['done', 'live'])
    h.push(r.turnId, ...fullAnswer('fine', 4))
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rlive1', payload: end(r, 'rc-live', 'done', null) }])
  }))

  it("a person's now-send into a chat whose resume is queued waits (waiting_answer)", () => inAgent(async h => {
    await d1Chat('c-nowq', MEMBER)
    const a = ok(await h.submit('c-nowq', 'key-nowq01')); await settle()
    h.push(a.turnId, ev.started(), ev.text('asking'), ev.deferred(), ev.checkpoint(2, 'u2', 1))
    expect(ok(await h.core.resumeDeferred('c-nowq', 'allow', qid(a.turnId))).position).toBe('queued')
    expect(await h.submit('c-nowq', 'key-nowq02', { priority: 'now' })).toEqual({ refused: { code: 'conflict', reason: 'waiting_answer' } })
  }))
})

describe('item 3: a non-wait refusal of the resume gives the wait up once', () => {
  it('owner removed while waiting → resume refused removed; one end {cancelled, removed}; chat not waiting', () => inEnds(async (h, ends) => {
    const person = { kind: 'person' as const, memberId: MEMBER }
    await d1Chat('c-rm', MEMBER)
    const a = ok(await routine(h, 'c-rm', 'key-rrm001', { by: person })); await settle()
    h.push(a.turnId, ev.started(), ev.text('x'), ev.deferred(), ev.checkpoint(2, 'u2', 1), ev.success(), ev.released(CP))
    h.core.onMemberRemoved(MEMBER)
    expect(await h.core.resumeDeferred('c-rm', 'deny', qid(a.turnId))).toEqual({ refused: { code: 'forbidden', reason: 'removed' } })
    expect(chatRow(h, 'c-rm')).toEqual({ session: 'none', waiting_json: null })
    expect(await h.core.resumeDeferred('c-rm', 'deny', qid(a.turnId))).toEqual({ refused: { code: 'not_found' } })
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rrm001', payload: end(a, 'c-rm', 'cancelled', 'removed') }])
  }))
})

describe('item 5: a deferred-hook runs only while the chat still waits on its question', () => {
  it('resumed before the task ran: P6 is never called and the task ends', () => inAgent(async h => {
    const calls: string[] = []
    h.core.setOnDeferred(async q => { calls.push(q.questionId); return { ok: true } })
    await d1Chat('c-hk', MEMBER)
    const a = ok(await h.submit('c-hk', 'key-hk0001')); await settle()
    h.push(a.turnId, ev.started(), ev.text('x'), ev.deferred(), ev.checkpoint(2, 'u2', 1), ev.success(), ev.released(CP))
    ok(await h.core.resumeDeferred('c-hk', 'allow', qid(a.turnId)))
    await h.tick(SEC)
    expect(calls).toEqual([])
    expect(taskRow(h, `deferred-hook:${qid(a.turnId)}`)).toBeNull()
  }))
})

describe('item 6: pause and resume run in order with their hooks', () => {
  it('a resume landing while a pause hook is awaited waits for it: the hooks end on "resumed", as the flag', () => inAgent(async h => {
    const gate = deferred()
    const log: string[] = []
    let hookState = 'none'
    h.core.registerPauseHook({
      async onPause(_e: PauseEvent) { log.push('pause:start'); await gate.promise; hookState = 'paused'; log.push('pause:end') },
      async onResume(_e: PauseEvent) { hookState = 'resumed'; log.push('resume') },
    })
    const p = h.core.pause(ADMIN)
    expect(h.core.isPaused()).toBe(true)
    const r = h.core.resume(ADMIN)
    await settle()
    gate.resolve()
    await Promise.all([p, r])
    expect([log, hookState, h.core.isPaused()]).toEqual([['pause:start', 'pause:end', 'resume'], 'resumed', false])
  }))
})

describe('items 4 and 7: personData', () => {
  /** One finished turn of `owner`, its history in D1 and its hold given back: nothing busy. */
  async function settled(h: Harness, chatId: string, owner = MEMBER) {
    await d1Chat(chatId, owner)
    const t = ok(await h.submit(chatId, `key-${chatId.replace(/[^A-Za-z0-9]/g, '')}`, { member: owner })); await settle()
    h.push(t.turnId, ...fullAnswer('a', 2))
    for (let i = 0; i < 5 && (h.turn(t.turnId).settled === 0 || h.turn(t.turnId).d1_flushed === 0); i++) await h.tick(MIN)
    expect(h.turn(t.turnId)).toMatchObject({ state: 'ended', settled: 1, d1_flushed: 1 })
    return t
  }

  it('each busy condition alone, the others satisfied; the clean baseline deletes', async () => {
    const conditions: [string, (h: Harness, t: SendTurnResult, chatId: string) => void][] = [
      ['live turn', (h, t) => { h.sql.exec("UPDATE turns SET state = 'live' WHERE turn_id = ?", t.turnId) }],
      ['waiting chat', (h, _t, c) => { h.sql.exec("UPDATE chat_state SET session = 'waiting' WHERE chat_id = ?", c) }],
      ['unsettled hold', (h, t) => { h.sql.exec('UPDATE turns SET settled = 0 WHERE turn_id = ?', t.turnId) }],
      ['unflushed history', (h, t) => { h.sql.exec('UPDATE turns SET d1_flushed = 0 WHERE turn_id = ?', t.turnId) }],
      ['pending file confirm', (h, t) => { h.sql.exec("INSERT INTO turn_effects (turn_id, seq, kind, json) VALUES (?, 9, 'confirm', '{}')", t.turnId) }],
    ]
    for (const [name, apply] of conditions) {
      await inAgent(async h => {
        const chatId = `c-busy-${name.replace(/ /g, '-')}`
        const t = await settled(h, chatId)
        apply(h, t, chatId)
        expect(h.core.personData(MEMBER, 'delete'), name).toEqual({ busy: true })
        expect(h.turns(), name).toHaveLength(1)
      })
    }
    await inAgent(async h => {
      await settled(h, 'c-busy-none')
      expect('counts' in h.core.personData(MEMBER, 'delete')).toBe(true)
      expect(h.turns()).toHaveLength(0)
    })
  })

  it('a real file_saved whose confirm is pending keeps delete busy until the confirm lands', () => inAgent(async h => {
    await d1Chat('c-file', MEMBER)
    const confirm = h.files.confirm.bind(h.files)
    h.files.confirm = async () => { throw new Error('d1 down') }
    const t = ok(await h.submit('c-file', 'key-file01')); await settle()
    h.push(t.turnId, ev.started(), ev.fileSaved('outputs/a.txt', 'ab'.repeat(32)), ev.text('a'), ev.checkpoint(2), ev.success(), ev.released({ mainEntries: 2, lastUuid: null, lastUuidIndex: null }))
    for (let i = 0; i < 3; i++) await h.tick(MIN)
    expect(h.turn(t.turnId)).toMatchObject({ state: 'ended', settled: 1, d1_flushed: 1 })
    expect(h.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM turn_effects').one().n).toBe(1)
    expect((h.core.personData(MEMBER, 'count') as { counts: Record<string, number> }).counts.turn_effects).toBe(1)
    expect(h.core.personData(MEMBER, 'delete')).toEqual({ busy: true })
    h.files.confirm = confirm
    await h.tick(MIN)
    expect(h.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM turn_effects').one().n).toBe(0)
    expect('counts' in h.core.personData(MEMBER, 'delete')).toBe(true)
  }))

  it('non-zero model_calls and pool_queue rows are counted and deleted; the other member keeps theirs', () => inAgent(async h => {
    const mine = await settled(h, 'c-nz-mine')
    const theirs = await settled(h, 'c-nz-their', OTHER)
    for (const t of [mine, theirs]) {
      h.sql.exec(`INSERT INTO model_calls (turn_id, call_id, n, model, input_tokens, max_tokens, modifiers_json, worst_micro, state, arrived_at_ms)
        VALUES (?, 'call-1', 0, 'claude-sonnet-5-5', 1, 1, '{}', 1, 'done', 0), (?, 'call-2', 1, 'claude-sonnet-5-5', 1, 1, '{}', 1, 'done', 0)`, t.turnId, t.turnId)
      h.sql.exec('INSERT INTO pool_queue (turn_id, queued_at_ms) VALUES (?, 0)', t.turnId)
    }
    const counts = (r: unknown) => { const c = (r as { counts: Record<string, number> }).counts; return { model_calls: c.model_calls, pool_queue: c.pool_queue } }
    expect(counts(h.core.personData(MEMBER, 'count'))).toEqual({ model_calls: 2, pool_queue: 1 })
    expect(counts(h.core.personData(MEMBER, 'delete'))).toEqual({ model_calls: 2, pool_queue: 1 })
    expect(counts(h.core.personData(MEMBER, 'count'))).toEqual({ model_calls: 0, pool_queue: 0 })
    expect(counts(h.core.personData(OTHER, 'count'))).toEqual({ model_calls: 2, pool_queue: 1 })
  }))

  it('the system member is refused invalid (item 8)', () => inAgent(async h => {
    expect(h.core.personData('m_system', 'count')).toEqual({ refused: { code: 'invalid' } })
    expect(h.core.personData('m_system', 'delete')).toEqual({ refused: { code: 'invalid' } })
  }))
})

describe('item 7: resume waits for draining and a full queue without counting; the old-table ALTER', () => {
  it('draining: refused, retried with attempts 0, never quarantined', () => inAgent(async h => {
    await d1Chat('c-dr', MEMBER)
    const a = ok(await h.submit('c-dr', 'key-dr0001')); await settle()
    h.push(a.turnId, ev.started(), ev.text('x'), ev.deferred(), ev.checkpoint(2, 'u2', 1), ev.success(), ev.released(CP))
    h.core.drain()
    expect(await h.core.resumeDeferred('c-dr', 'allow', qid(a.turnId))).toEqual({ refused: { code: 'unavailable', reason: 'draining' } })
    for (let i = 0; i < 12; i++) await h.tick(MIN)
    expect(taskRow(h, `deferred-resume:${qid(a.turnId)}`)).toEqual({ state: 'ready', attempts: 0 })
    expect(chatRow(h, 'c-dr').session).toBe('waiting')
  }))

  it('a full queue (20 queued for the member): refused queue_full, retried with attempts 0; runs once there is room', () => inAgent(async h => {
    await d1Chat('rc-qf', 'm_system')
    const a = ok(await routine(h, 'rc-qf', 'key-qf0000', { onEnd: undefined })); await settle()
    h.push(a.turnId, ev.started(), ev.text('x'), ev.deferred(), ev.checkpoint(2, 'u2', 1), ev.success(), ev.released(CP))
    for (const c of ['rc-qf1', 'rc-qf2']) {
      await d1Chat(c, 'm_system')
      const live = ok(await routine(h, c, `key-${c}-l`.replace(/-/g, '_'), { onEnd: undefined })); await settle()
      h.push(live.turnId, ev.started(), ev.text('busy'))
      for (let i = 0; i < 10; i++) expect(ok(await routine(h, c, `key_${c}_${i}`.replace(/-/g, '_'), { onEnd: undefined })).position).toBe('queued')
    }
    expect(await h.core.resumeDeferred('rc-qf', 'allow', qid(a.turnId))).toEqual({ refused: { code: 'rate_limited', reason: 'queue_full' } })
    // Two retries while the live turns still hold the queue full (the fake runner's silence ends them after ~3 min).
    for (let i = 0; i < 2; i++) await h.tick(MIN)
    expect(taskRow(h, `deferred-resume:${qid(a.turnId)}`)).toEqual({ state: 'ready', attempts: 0 })
    h.core.stop(h.turns().find(t => t.client_key === 'key_rc_qf1_0')!.turn_id, SYSTEM)
    await h.tick(MIN)
    expect(taskRow(h, `deferred-resume:${qid(a.turnId)}`)).toBeNull()
    expect(h.turns().filter(t => t.client_key === `resume_${qid(a.turnId)}`)).toHaveLength(1)
  }))

  it("createAgentTables adds PR 6's columns to an older turns table, keeping its rows", () => inAgent(async h => {
    ok(await h.submit('c-old6', 'key-old601'))
    for (const col of ['resume_json', 'abandoned']) h.sql.exec(`ALTER TABLE turns DROP COLUMN ${col}`)
    createAgentTables(h.sql)
    const cols = h.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('turns')").toArray().map(r => r.name)
    expect(cols.slice(-2)).toEqual(['resume_json', 'abandoned'])
    expect(h.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM turns').one().n).toBe(1)
  }))
})
