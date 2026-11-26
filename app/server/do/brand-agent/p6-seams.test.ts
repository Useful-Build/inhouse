// PR 6, the P6 seams (p3-w1.md "Added by A2: PR 6", "Added by A7", p3-w1-pr6.md's A8 notes; p6-design section 14,
// asks 3-5) and P8 C1's person data. Every expected value is a literal written here from the design (payloads, counts,
// orders), never read back from core.ts. Ways it can fail, written down first:
//  1. ensureSeeds re-arms a seed on every start (moves its due time) or misses one that's absent;
//  2. a pause hook runs before the flag is set (or a resume hook before it's cleared), out of order, or a throwing hook
//     rolls the flag back or is swallowed; P6's anchor isn't wired, or `TaskContext.paused` reads a stale value;
//  3. `onDeferred` runs inline in the turn's step, twice for one wait (the checkpoint event, then `released`), never
//     retries, never quarantines, or revive re-runs it with another payload;
//  4. `resumeDeferred` needs text, submits twice for one question, resumes a question the chat doesn't wait on, or
//     starts a turn in a chat that is in the trash in D1 (a failed restore leaves the object saying live);
//  5. the parked end task fires on the deferral, never, twice (a stop, a pause or the parked turn's late `released`
//     next to the resume), with the wrong turn's payload, or strands when the wait is abandoned (deleted, reset); a
//     resume refused for a pause counts toward quarantine and strands the slot;
//  6. `chats.status` writes, or misreads a waiting chat, a live run, an idle or an unknown chat;
//  7. personData counts differ from what delete removes, deletes while a turn of the person is live or waiting,
//     touches another member's rows, or deletes again on a second call.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import { MEMBER, MIN, OTHER, SEC, d1Chat, ev, fullAnswer, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../testing/brand-agent/core-harness.ts'
import { p6Hooks, wireP6 } from './compose.ts'
import type { DeferredQuestion, InternalSubmit, PauseEvent, Refusal } from './ports.ts'
import { withSeed } from './scheduler.ts'
import type { TaskContext, TaskHandler } from './scheduler.ts'
import { revive } from './task-ops.ts'
import { internalSubmit } from './task-ops.ts'

const SYSTEM = { kind: 'service' as const, memberId: 'm_system' }
const ADMIN = { kind: 'person' as const, memberId: 'm_admin' }
const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
const released = (n = 2) => ev.released({ mainEntries: n, lastUuid: null, lastUuidIndex: null })

/** Every end task the test kind received, in order (the scheduler ran them). */
function endKind(log: { id: string; payload: unknown }[]): TaskHandler {
  return async task => { log.push({ id: task.id, payload: task.payload }); return { done: true } }
}

/** A routine-shaped submit (the system member, an end task) into `chatId`. */
function routine(h: Harness, chatId: string, key: string, o: Partial<InternalSubmit> = {}) {
  return internalSubmit(h.core, h.sql, h.registry, {
    chatId, by: SYSTEM, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'high', sideModel: 'claude-haiku-5-5',
    maxTurns: 25, webFetchDomains: null, onEnd: { kind: 'test-end', id: `test-end:${key}` },
    input: { clientTurnKey: key, text: `routine ${key}`, priority: 'next', model: 'sonnet', attachments: [] },
    ...o,
  })
}

/** Runs a turn to a deferral: its checkpoint leaves the chat waiting; `release` sends its `released` too. */
function defer(h: Harness, turnId: string, release = true) {
  h.push(turnId, ev.started(), ev.text('asking'), ev.deferred(), ev.checkpoint(2, 'u2', 1), ev.success())
  if (release) h.push(turnId, ev.released({ mainEntries: 2, lastUuid: 'u2', lastUuidIndex: 1 }))
}

/** `q_` and the turn id's random part (p6-design: P3's questionId). Written here, not imported. */
const qid = (turnId: string) => `q_${turnId.slice(2)}`
const chatRow = (h: Harness, chatId: string) =>
  h.sql.exec<{ session: string; waiting_json: string | null }>('SELECT session, waiting_json FROM chat_state WHERE chat_id = ?', chatId).one()
const taskRow = (h: Harness, id: string) =>
  h.sql.exec<{ kind: string; state: string; attempts: number; payload_json: string | null }>('SELECT kind, state, attempts, payload_json FROM due_tasks WHERE id = ?', id).toArray()[0] ?? null

describe('seeds keep ENSURE semantics (failure 1)', () => {
  it('an existing seed keeps its due time across starts; a missing one is created due now', () => {
    const seeded = withSeed<TaskContext>(async () => ({ done: true }), { id: 'p6-sweep' })
    return inAgent(async h0 => {
      h0.sched.ensure({ id: 'p6-sweep', kind: 'p6-sweep', dueAtMs: h0.clock.now + 30 * MIN })
      const h1 = h0.restart()
      expect(h1.dueTasks().find(t => t.id === 'p6-sweep')).toEqual({ id: 'p6-sweep', due_at_ms: h0.clock.now + 30 * MIN })
      h1.sched.cancel('p6-sweep')
      h1.clock.now += 5 * SEC
      const h2 = h1.restart()
      expect(h2.dueTasks().find(t => t.id === 'p6-sweep')).toEqual({ id: 'p6-sweep', due_at_ms: h1.clock.now })
    }, { handlers: { 'p6-sweep': seeded } })
  })
})

describe('pause hooks (P6 ask 3, failure 2)', () => {
  const recorder = (log: string[], name: string, h: () => Harness, throwOn?: 'pause' | 'resume') => ({
    async onPause(e: PauseEvent) {
      log.push(`${name}.pause:${String(h().core.isPaused())}:${e.by.memberId}:${e.atMs}`)
      if (throwOn === 'pause') throw new Error(`${name} failed`)
    },
    async onResume(e: PauseEvent) {
      log.push(`${name}.resume:${String(h().core.isPaused())}:${e.by.memberId}:${e.atMs}`)
      if (throwOn === 'resume') throw new Error(`${name} failed`)
    },
  })

  it('awaited in order after the flag is set (pause) and cleared (resume)', () => inAgent(async h => {
    const log: string[] = []
    h.core.registerPauseHook(recorder(log, 'a', () => h))
    h.core.registerPauseHook(recorder(log, 'b', () => h))
    const t = h.clock.now
    expect((await h.core.pause(ADMIN)).paused).toBe(true)
    expect(await h.core.resume(ADMIN)).toEqual({ paused: false, at: null, by: null })
    expect(log).toEqual([`a.pause:true:m_admin:${t}`, `b.pause:true:m_admin:${t}`, `a.resume:false:m_admin:${t}`, `b.resume:false:m_admin:${t}`])
  }))

  it('a throwing hook makes pause() and resume() throw, the flag change kept, later hooks not run', () => inAgent(async h => {
    const log: string[] = []
    h.core.registerPauseHook(recorder(log, 'a', () => h))
    h.core.registerPauseHook(recorder(log, 'b', () => h, 'pause'))
    h.core.registerPauseHook(recorder(log, 'c', () => h))
    await expect(h.core.pause(ADMIN)).rejects.toThrow('b failed')
    expect(h.core.pauseState().paused).toBe(true)
    expect(log).toEqual([`a.pause:true:m_admin:${h.clock.now}`, `b.pause:true:m_admin:${h.clock.now}`])
    log.length = 0
    // A retried pause runs every hook again (still paused, still throwing).
    await expect(h.core.pause(ADMIN)).rejects.toThrow('b failed')
    expect(log).toEqual([`a.pause:true:m_admin:${h.clock.now}`, `b.pause:true:m_admin:${h.clock.now}`])
  }))

  it('a throwing resume hook keeps the flag cleared', () => inAgent(async h => {
    const log: string[] = []
    h.core.registerPauseHook(recorder(log, 'a', () => h, 'resume'))
    await h.core.pause(ADMIN)
    await expect(h.core.resume(ADMIN)).rejects.toThrow('a failed')
    expect(h.core.pauseState()).toEqual({ paused: false, at: null, by: null })
  }))

  it("P6's anchor: the outbox's one pause hook (Stage 1 M2-B) and no onDeferred; an anchor returning one throwing hook makes pause() throw with the flag kept", () => inAgent(async h => {
    expect(p6Hooks(env, { sql: h.sql, scheduler: h.sched, now: () => h.clock.now, hooks: { retryPlacement: () => {}, placementExpired: () => {} } }))
      .toEqual({ pause: [{ onPause: expect.any(Function), onResume: expect.any(Function) }], onDeferred: null })
    wireP6(h.core, { pause: [{ onPause: async () => { throw new Error('T10 failed') }, onResume: async () => {} }], onDeferred: null })
    await expect(h.core.pause(ADMIN)).rejects.toThrow('T10 failed')
    expect(h.core.pauseState().paused).toBe(true)
    expect(await h.submit('c-anchor', 'key-anch01')).toEqual({ refused: { code: 'forbidden', reason: 'paused' } })
  }))

  it('TaskContext.paused reads the stored flag at each access', () => {
    const seen: boolean[] = []
    return inAgent(async h => {
      h.sched.schedule({ id: 'probe', kind: 'probe', dueAtMs: h.clock.now })
      await h.tick(SEC)
      await h.core.pause(ADMIN)
      h.sched.schedule({ id: 'probe', kind: 'probe', dueAtMs: h.clock.now })
      await h.tick(SEC)
      expect(seen).toEqual([false, true, true, false])
    }, {
      handlers: {
        probe: async (_t, ctx) => {
          seen.push(ctx.paused)
          if (ctx.paused) {
            // Read again after a change in the same task: never a value captured when the context was built.
            seen.push(ctx.paused)
            await (ctx.agent as unknown as Harness['core']).resume(ADMIN)
            seen.push(ctx.paused)
          }
          return { done: true }
        },
      },
    })
  })
})

describe('onDeferred through deferred-hook:<questionId> (P6 ask 4, failure 3)', () => {
  it('called once the checkpoint marks the chat waiting, from the task, never inline; once per wait', () => inAgent(async h => {
    const calls: DeferredQuestion[] = []
    h.core.setOnDeferred(async q => { calls.push(q); return { ok: true } })
    const a = ok(await h.submit('c-ask', 'key-ask001')); await settle()
    defer(h, a.turnId, false)
    expect(calls).toEqual([])
    const question: DeferredQuestion = {
      questionId: qid(a.turnId), chatId: 'c-ask', turnId: a.turnId, runId: a.runId, ownerId: MEMBER, toolUseId: 'tu_9',
      toolName: 'mcp__inhouse__ask_approval', input: { q: 1 },
    }
    expect(taskRow(h, `deferred-hook:${qid(a.turnId)}`)).toEqual({ kind: 'deferred-hook', state: 'ready', attempts: 0, payload_json: JSON.stringify(question) })
    await h.tick(SEC)
    expect(calls).toEqual([question])
    expect(taskRow(h, `deferred-hook:${qid(a.turnId)}`)).toBeNull()
    // The same wait's second checkpoint (in `released`, after the hook ran): no second call.
    h.push(a.turnId, ev.released({ mainEntries: 2, lastUuid: 'u2', lastUuidIndex: 1 }))
    await h.tick(SEC)
    expect(calls).toEqual([question])
    expect(JSON.parse(chatRow(h, 'c-ask').waiting_json!)).toEqual({ questionId: qid(a.turnId), turnId: a.turnId, toolUseId: 'tu_9', toolName: 'mcp__inhouse__ask_approval', input: { q: 1 } })
  }))

  it('fails 10 times → quarantined, the scheduler signal red; revive runs the same payload once more and the question reaches P6', () => inAgent(async h => {
    const calls: DeferredQuestion[] = []
    let up = false
    h.core.setOnDeferred(async q => { calls.push(q); return up ? { ok: true } : { retry: 'unavailable' } })
    await d1Chat('c-quar', MEMBER)  // its turn's history flushes (a failing flush would quarantine too)
    const a = ok(await h.submit('c-quar', 'key-quar01')); await settle()
    defer(h, a.turnId)
    const id = `deferred-hook:${qid(a.turnId)}`
    const stored = taskRow(h, id)!.payload_json
    for (let i = 0; i < 12 && taskRow(h, id)!.state === 'ready'; i++) await h.tick(60 * MIN)
    expect(calls).toHaveLength(10)
    expect(taskRow(h, id)).toMatchObject({ state: 'quarantined', attempts: 10, payload_json: stored })
    expect(h.core.runsHealth(h.sched.quarantinedCount()).quarantined.ok).toBe(false)
    up = true
    expect(revive(h.sched, h.registry, { kind: 'deferred-hook', id })).toBe('revived')
    await h.tick(SEC)
    expect(calls).toHaveLength(11)
    expect(calls[10]).toEqual({
      questionId: qid(a.turnId), chatId: 'c-quar', turnId: a.turnId, runId: a.runId, ownerId: MEMBER, toolUseId: 'tu_9',
      toolName: 'mcp__inhouse__ask_approval', input: { q: 1 },
    })
    expect(taskRow(h, id)).toBeNull()
    expect(h.core.runsHealth(h.sched.quarantinedCount()).quarantined.ok).toBe(true)
  }))

  it('no hook registered yet: retried, never done', () => inAgent(async h => {
    const a = ok(await h.submit('c-nohook', 'key-nohk01')); await settle()
    defer(h, a.turnId)
    await h.tick(SEC)
    expect(taskRow(h, `deferred-hook:${qid(a.turnId)}`)).toMatchObject({ state: 'ready', attempts: 1 })
  }))
})

describe('resumeDeferred (P6 ask 5, failure 4)', () => {
  it('submits the resume turn: empty text, next, the parked turn\'s settings, resume:true from the checkpoint', () => inAgent(async h => {
    await d1Chat('c-res', MEMBER)
    const a = ok(await h.submit('c-res', 'key-res001')); await settle()
    defer(h, a.turnId)
    const r = ok(await h.core.resumeDeferred('c-res', 'allow', qid(a.turnId))); await settle()
    expect(r.position).toBe('starting')
    expect(h.turn(r.turnId)).toMatchObject({
      text: '', priority: 'next', owner_id: MEMBER, client_key: `resume_${qid(a.turnId)}`, model: 'claude-sonnet-5-5',
      resume_json: JSON.stringify({ questionId: qid(a.turnId), decision: 'allow', toolUseId: 'tu_9' }),
    })
    expect(chatRow(h, 'c-res')).toEqual({ session: 'resumable', waiting_json: null })
    const start = h.pool.calls.filter(c => c.method === 'place').map(c => c.args[0] as Record<string, unknown>).find(s => s.runId === r.turnId)!
    expect({ prompt: start.prompt, resume: start.resume, expect: start.expect, sessionId: start.sessionId })
      .toEqual({ prompt: '', resume: true, expect: { mainEntries: 2, lastUuid: 'u2', lastUuidIndex: 1 }, sessionId: '00000000-0000-4000-8000-000000000001' })
  }))

  it('idempotent by questionId: a second call (either decision) answers the first turn; one turn only', () => inAgent(async h => {
    await d1Chat('c-twice', MEMBER)
    const a = ok(await h.submit('c-twice', 'key-twice1')); await settle()
    defer(h, a.turnId)
    const first = ok(await h.core.resumeDeferred('c-twice', 'deny', qid(a.turnId)))
    expect(await h.core.resumeDeferred('c-twice', 'deny', qid(a.turnId))).toEqual(first)
    expect(await h.core.resumeDeferred('c-twice', 'allow', qid(a.turnId))).toEqual(first)
    // A plain send waits while the resume isn't running yet (r1 item 2).
    expect(await h.submit('c-twice', 'key-twice2')).toEqual({ refused: { code: 'conflict', reason: 'waiting_answer' } })
    expect(h.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM turns WHERE client_key LIKE 'resume_%'").one().n).toBe(1)
  }))

  it('a question the chat does not wait on is not_found; a plain send into the waiting chat is waiting_answer', () => inAgent(async h => {
    await d1Chat('c-nowait', MEMBER)
    const a = ok(await h.submit('c-nowait', 'key-nowt01')); await settle()
    defer(h, a.turnId)
    expect(await h.core.resumeDeferred('c-nowait', 'allow', 'q_AAAAAAAAAAAAAAAAAAAAAA')).toEqual({ refused: { code: 'not_found' } })
    expect(await h.core.resumeDeferred('c-other', 'allow', qid(a.turnId))).toEqual({ refused: { code: 'not_found' } })
    expect(await h.submit('c-nowait', 'key-nowt02')).toEqual({ refused: { code: 'conflict', reason: 'waiting_answer' } })
  }))

  it('two concurrent resumes for one question start one turn', () => inAgent(async h => {
    await d1Chat('c-race', MEMBER)
    const a = ok(await h.submit('c-race', 'key-race01')); await settle()
    defer(h, a.turnId)
    const [x, y] = await Promise.all([h.core.resumeDeferred('c-race', 'allow', qid(a.turnId)), h.core.resumeDeferred('c-race', 'allow', qid(a.turnId))])
    expect(ok(x)).toEqual(ok(y))
    expect(h.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM turns WHERE client_key LIKE 'resume_%'").one().n).toBe(1)
  }))

  it('a failed restore (D1 deleted, the object live): resumeDeferred refused, nothing starts', () => inAgent(async h => {
    await d1Chat('c-trash', MEMBER)
    const a = ok(await h.submit('c-trash', 'key-trash1')); await settle()
    defer(h, a.turnId)
    await d1Chat('c-trash', MEMBER, h.clock.now)
    const before = h.placed().length
    expect(await h.core.resumeDeferred('c-trash', 'allow', qid(a.turnId))).toEqual({ refused: { code: 'not_found' } })
    await settle()
    expect(h.placed()).toHaveLength(before)
    expect(h.turns().map(t => t.turn_id)).toEqual([a.turnId])
  }))

  it("an internal submit into a person's trashed chat is refused; into a live one it's admitted", () => inAgent(async h => {
    // (the end task's kind is registered below)
    const person = { kind: 'person' as const, memberId: MEMBER }
    await d1Chat('c-int-live', MEMBER)
    await d1Chat('c-int-gone', MEMBER, h.clock.now)
    expect(await routine(h, 'c-int-gone', 'key-intg01', { by: person })).toEqual({ refused: { code: 'not_found' } })
    expect(await routine(h, 'c-int-none', 'key-intn01', { by: person })).toEqual({ refused: { code: 'not_found' } })
    expect(ok(await routine(h, 'c-int-live', 'key-intl01', { by: person })).position).toBe('starting')
  }, { handlers: { 'test-end': async () => ({ done: true }) } }))
})

describe('onEnd across a deferral: parked, fired exactly once (A7, A8; failure 5)', () => {
  const inEnds = (fn: (h: Harness, ends: { id: string; payload: unknown }[]) => Promise<void>) => {
    const ends: { id: string; payload: unknown }[] = []
    return inAgent(h => fn(h, ends), { handlers: { 'test-end': endKind(ends) } })
  }
  const end = (r: SendTurnResult, chatId: string, outcome: string, failure: string | null, structuredOutput: unknown = null) =>
    ({ turnId: r.turnId, runId: r.runId, chatId, outcome, failure, structuredOutput })

  it('defers → no end task; resume → one, at the resumed turn\'s true end, with its outcome and structured output', () => inEnds(async (h, ends) => {
    await d1Chat('rc-a', 'm_system')
    const a = ok(await routine(h, 'rc-a', 'key-ra0001')); await settle()
    defer(h, a.turnId)
    await h.tick(SEC)
    expect(ends).toEqual([])
    const r = ok(await h.core.resumeDeferred('rc-a', 'allow', qid(a.turnId))); await settle()
    h.push(r.turnId, ev.started(), ev.text('done'), ev.checkpoint(4), { type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0.01, usage: {}, structuredOutput: { ok: 1 } }, released(4))
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-ra0001', payload: end(r, 'rc-a', 'done', null, { ok: 1 }) }])
    await h.tick(10 * MIN)
    expect(ends).toHaveLength(1)
  }))

  it('the 7-day expiry ends through resumeDeferred(deny): one end task', () => inEnds(async (h, ends) => {
    await d1Chat('rc-exp', 'm_system')
    const a = ok(await routine(h, 'rc-exp', 'key-rexp01')); await settle()
    defer(h, a.turnId)
    const r = ok(await h.core.resumeDeferred('rc-exp', 'deny', qid(a.turnId))); await settle()
    h.push(r.turnId, ...fullAnswer('closed', 4))
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rexp01', payload: end(r, 'rc-exp', 'done', null) }])
  }))

  it('a pause while the parked turn is still ending, and a stop of it, fire nothing; the resume then fires one', () => inEnds(async (h, ends) => {
    await d1Chat('rc-p', 'm_system')
    const a = ok(await routine(h, 'rc-p', 'key-rp0001')); await settle()
    defer(h, a.turnId, false)
    expect(h.core.stop(a.turnId, SYSTEM)).toEqual({ refused: { code: 'conflict', reason: 'turn_ended' } })
    await h.core.pause(ADMIN)
    h.push(a.turnId, released())
    await h.tick(SEC)
    expect(h.turn(a.turnId).state).toBe('ended')
    expect(chatRow(h, 'rc-p').session).toBe('waiting')
    expect(ends).toEqual([])
    await h.core.resume(ADMIN)
    const r = ok(await h.core.resumeDeferred('rc-p', 'allow', qid(a.turnId))); await settle()
    h.push(r.turnId, ev.started(), ev.text('x'), ev.checkpoint(4), ev.finished('error_max_turns'), released(4))
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rp0001', payload: end(r, 'rc-p', 'failed', 'max_turns') }])
  }))

  it('a resume admitted before the parked turn released: its late released neither re-parks nor fires; one end', () => inEnds(async (h, ends) => {
    await d1Chat('rc-late', 'm_system')
    const calls: string[] = []
    h.core.setOnDeferred(async q => { calls.push(q.questionId); return { ok: true } })
    const a = ok(await routine(h, 'rc-late', 'key-rlat01')); await settle()
    defer(h, a.turnId, false)
    await h.tick(SEC)
    const r = ok(await h.core.resumeDeferred('rc-late', 'allow', qid(a.turnId)))
    expect(r.position).toBe('queued')
    h.push(a.turnId, ev.released({ mainEntries: 2, lastUuid: 'u2', lastUuidIndex: 1 }))
    await h.tick(SEC)
    expect(chatRow(h, 'rc-late')).toEqual({ session: 'resumable', waiting_json: null })
    expect(calls).toEqual([qid(a.turnId)])
    expect(h.turn(r.turnId).state).toBe('starting')
    await settle()
    h.push(r.turnId, ...fullAnswer('fine', 4))
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rlat01', payload: end(r, 'rc-late', 'done', null) }])
  }))

  it('the waiting chat deleted → the expiry\'s deny fires one end task (cancelled, deleted); a second expiry run none', () => inEnds(async (h, ends) => {
    await d1Chat('rc-del', 'm_system')
    const a = ok(await routine(h, 'rc-del', 'key-rdel01')); await settle()
    defer(h, a.turnId)
    await d1Chat('rc-del', 'm_system', h.clock.now)
    expect(await h.core.resumeDeferred('rc-del', 'deny', qid(a.turnId))).toEqual({ refused: { code: 'not_found' } })
    expect(chatRow(h, 'rc-del')).toEqual({ session: 'none', waiting_json: null })
    expect(await h.core.resumeDeferred('rc-del', 'deny', qid(a.turnId))).toEqual({ refused: { code: 'not_found' } })
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rdel01', payload: end(a, 'rc-del', 'cancelled', 'deleted') }])
  }))

  it('route 27 marked the waiting chat deleted here (D1 still live): the deny fires one end task (cancelled, deleted)', () => inEnds(async (h, ends) => {
    await d1Chat('rc-mark', 'm_system')
    const a = ok(await routine(h, 'rc-mark', 'key-rmrk01')); await settle()
    defer(h, a.turnId)
    h.core.endChats([{ id: 'rc-mark', rev: 2 }])
    expect(chatRow(h, 'rc-mark').session).toBe('waiting')
    expect(await h.core.resumeDeferred('rc-mark', 'deny', qid(a.turnId))).toEqual({ refused: { code: 'not_found' } })
    expect(await h.core.resumeDeferred('rc-mark', 'deny', qid(a.turnId))).toEqual({ refused: { code: 'not_found' } })
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rmrk01', payload: end(a, 'rc-mark', 'cancelled', 'deleted') }])
  }))

  it('route 49 reset of the waiting chat fires one end task (cancelled, session_reset)', () => inEnds(async (h, ends) => {
    await d1Chat('rc-rst', 'm_system')
    const a = ok(await routine(h, 'rc-rst', 'key-rrst01')); await settle()
    defer(h, a.turnId)
    expect(h.core.resetSession('rc-rst', SYSTEM)).toEqual({ ok: true })
    expect(h.core.resetSession('rc-rst', SYSTEM)).toEqual({ ok: true })
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rrst01', payload: end(a, 'rc-rst', 'cancelled', 'session_reset') }])
    expect(await h.core.resumeDeferred('rc-rst', 'allow', qid(a.turnId))).toEqual({ refused: { code: 'not_found' } })
  }))

  it('a resume refused while paused is retried every minute, 11+ times, never quarantined; after resume it runs once', () => inEnds(async (h, ends) => {
    await d1Chat('rc-wait', 'm_system')
    const a = ok(await routine(h, 'rc-wait', 'key-rwai01')); await settle()
    defer(h, a.turnId)
    await h.core.pause(ADMIN)
    expect(await h.core.resumeDeferred('rc-wait', 'allow', qid(a.turnId))).toEqual({ refused: { code: 'forbidden', reason: 'paused' } })
    const id = `deferred-resume:${qid(a.turnId)}`
    for (let i = 0; i < 14; i++) await h.tick(MIN)
    expect(taskRow(h, id)).toEqual({ kind: 'deferred-resume', state: 'ready', attempts: 0, payload_json: JSON.stringify({ chatId: 'rc-wait', decision: 'allow', questionId: qid(a.turnId) }) })
    expect(h.sched.quarantinedCount()).toBe(0)
    expect(chatRow(h, 'rc-wait').session).toBe('waiting')
    await h.core.resume(ADMIN)
    await h.tick(MIN)
    expect(taskRow(h, id)).toBeNull()
    const resumed = h.turns().find(t => t.client_key === `resume_${qid(a.turnId)}`)!
    expect(resumed.state).toBe('live')
    h.push(resumed.turn_id, ...fullAnswer('ok', 4))
    await h.tick(SEC)
    expect(ends).toEqual([{ id: 'test-end:key-rwai01', payload: { turnId: resumed.turn_id, runId: resumed.run_id, chatId: 'rc-wait', outcome: 'done', failure: null, structuredOutput: null } }])
  }))
})

describe('TaskContext.chats.status (P4, B2; failure 6)', () => {
  it('waiting chat, live run, idle chat, unknown chat', () => {
    const seen: unknown[] = []
    return inAgent(async h => {
      const w = ok(await h.submit('c-st-wait', 'key-stw001')); await settle()
      defer(h, w.turnId)
      const live = ok(await h.submit('c-st-live', 'key-stl001')); await settle()
      h.push(live.turnId, ev.started(), ev.text('a'))
      const idle = ok(await h.submit('c-st-idle', 'key-sti001')); await settle()
      h.push(idle.turnId, ...fullAnswer('a', 2))
      const snapshot = () => [
        h.sql.exec('SELECT * FROM chat_state ORDER BY chat_id').toArray(), h.sql.exec('SELECT * FROM turns ORDER BY turn_id').toArray(),
        h.sql.exec('SELECT * FROM runs ORDER BY run_id').toArray(),
      ]
      await h.tick(SEC)  // the idle turn's settle and other due work first
      const before = snapshot()
      h.sched.schedule({ id: 'probe', kind: 'probe', dueAtMs: h.clock.now })
      await h.tick(SEC)
      expect(seen).toEqual([
        { waiting: true, liveRunId: null },
        { waiting: false, liveRunId: live.runId },
        { waiting: false, liveRunId: null },
        { waiting: false, liveRunId: null },
      ])
      // The reads wrote nothing.
      expect(snapshot()).toEqual(before)
    }, {
      handlers: {
        probe: async (_t, ctx) => {
          for (const id of ['c-st-wait', 'c-st-live', 'c-st-idle', 'c-st-none']) seen.push(ctx.chats.status(id))
          return { done: true }
        },
      },
    })
  })
})

describe('personData (P8 C1; failure 7)', () => {
  /** One person's finished turn with a trace step, a file confirm still queued, and a second member's alike. */
  async function twoMembers(h: Harness, tag: string) {
    // In D1 as route 23 leaves them, so each finished turn's history flushes (delete is busy until it has).
    await d1Chat(`c-pd-mine-${tag}`, MEMBER)
    await d1Chat(`c-pd-their-${tag}`, OTHER)
    const mine = ok(await h.submit(`c-pd-mine-${tag}`, 'key-pdm001')); await settle()
    h.push(mine.turnId, ev.started(), ev.tool('Read'), ev.text('a'), ev.checkpoint(2), ev.success(), released())
    const theirs = ok(await h.submit(`c-pd-their-${tag}`, 'key-pdt001', { member: OTHER })); await settle()
    h.push(theirs.turnId, ev.started(), ev.tool('Read'), ev.text('b'), ev.checkpoint(2), ev.success(), released())
    // Past the flush's durable retry: both turns' history is in D1 whichever immediate flush landed.
    await h.tick(MIN)
    expect(h.turns().map(t => t.d1_flushed)).toEqual([1, 1])
    return { mine, theirs }
  }
  const ZERO = {
    runs: 0, turns: 0, events: 0, chat_state: 0, run_tokens: 0, model_calls: 0, ledger_queue: 0, pool_queue: 0, due_tasks: 0, turn_effects: 0,
    turn_trace: 0, turn_rows: 0, chat_deletion: 0,
  }

  it('count equals delete\'s counts; other members\' rows untouched; a second delete is zeros', () => inAgent(async h => {
    await twoMembers(h, 'a')
    // From the script: one run (run.started, turn.queued, turn.started, step, part, turn.finished, run.finished = 7
    // events), one turn, one chat, one token, one trace record (the Read step), the settle on the ledger queue, the
    // turn's fixed D1 rows (one `turn_rows` row).
    const expected = { ...ZERO, runs: 1, turns: 1, events: 7, chat_state: 1, run_tokens: 1, ledger_queue: 1, turn_trace: 1, turn_rows: 1 }
    expect(h.core.personData(MEMBER, 'count')).toEqual({ counts: expected })
    const theirsBefore = h.core.personData(OTHER, 'count')
    expect(theirsBefore).toEqual({ counts: expected })
    expect(h.core.personData(MEMBER, 'delete')).toEqual({ counts: expected })
    expect(h.core.personData(MEMBER, 'count')).toEqual({ counts: ZERO })
    expect(h.core.personData(MEMBER, 'delete')).toEqual({ counts: ZERO })
    expect(h.core.personData(OTHER, 'count')).toEqual(theirsBefore)
    expect(h.sql.exec<{ owner_id: string }>('SELECT DISTINCT owner_id FROM turns').toArray().map(r => r.owner_id)).toEqual([OTHER])
  }))

  it('due tasks naming the person\'s turns or chats are counted and deleted; others kept', () => inAgent(async h => {
    const { mine, theirs } = await twoMembers(h, 'b')
    h.sched.schedule({ id: `flush-turn:${mine.turnId}`, kind: 'flush-turn', dueAtMs: h.clock.now + 60 * MIN })
    h.sched.schedule({ id: 'test-end:x', kind: 'flush-turn', dueAtMs: h.clock.now + 60 * MIN, payload: { chatId: 'c-pd-mine-b', turnId: mine.turnId } })
    h.sched.schedule({ id: `flush-turn:${theirs.turnId}`, kind: 'flush-turn', dueAtMs: h.clock.now + 60 * MIN })
    expect((h.core.personData(MEMBER, 'count') as { counts: Record<string, number> }).counts.due_tasks).toBe(2)
    expect((h.core.personData(MEMBER, 'delete') as { counts: Record<string, number> }).counts.due_tasks).toBe(2)
    expect(h.sql.exec<{ id: string }>("SELECT id FROM due_tasks WHERE kind = 'flush-turn'").toArray().map(r => r.id)).toEqual([`flush-turn:${theirs.turnId}`])
  }))

  it('busy while a final turn\'s history is not in D1 yet; the chat_deletion mark is the person\'s row', () => inAgent(async h => {
    // No D1 chat row: the flush can't land (chat_messages references chats), so the turn stays unflushed.
    const a = ok(await h.submit('c-unfl', 'key-unfl01')); await settle()
    h.push(a.turnId, ...fullAnswer('a', 2))
    // Settled (the hold given back), so only the flush holds the delete.
    for (let i = 0; i < 5 && h.turn(a.turnId).settled === 0; i++) await h.tick(MIN)
    expect(h.turn(a.turnId)).toMatchObject({ state: 'ended', d1_flushed: 0, settled: 1 })
    expect(h.core.personData(MEMBER, 'delete')).toEqual({ busy: true })
    expect(h.turns()).toHaveLength(1)
    await d1Chat('c-unfl', MEMBER)
    await h.tick(10 * MIN)
    expect(h.turn(a.turnId).d1_flushed).toBe(1)
    h.core.endChats([{ id: 'c-unfl', rev: 2 }])
    const counts = (h.core.personData(MEMBER, 'delete') as { counts: Record<string, number> }).counts
    expect({ chat_deletion: counts.chat_deletion, turn_rows: counts.turn_rows, turns: counts.turns }).toEqual({ chat_deletion: 1, turn_rows: 1, turns: 1 })
    expect(h.sql.exec('SELECT chat_id FROM chat_deletion').toArray()).toEqual([])
  }))

  it('busy while a turn of the person is queued, starting, live or ending, or a chat of theirs waits; nothing deleted', () => inAgent(async h => {
    const live = ok(await h.submit('c-busy', 'key-busy01')); await settle()
    h.push(live.turnId, ev.started(), ev.text('a'))
    expect(h.core.personData(MEMBER, 'delete')).toEqual({ busy: true })
    expect(h.turns()).toHaveLength(1)
    h.push(live.turnId, ev.deferred(), ev.checkpoint(2), ev.success())
    expect(h.turn(live.turnId).state).toBe('ending')
    expect(h.core.personData(MEMBER, 'delete')).toEqual({ busy: true })
    h.push(live.turnId, released())
    await h.tick(SEC)
    expect(chatRow(h, 'c-busy').session).toBe('waiting')
    expect(h.core.personData(MEMBER, 'delete')).toEqual({ busy: true })
    expect((h.core.personData(MEMBER, 'count') as { counts: Record<string, number> }).counts.turns).toBe(1)
    const q = ok(await h.submit('c-busy-2', 'key-busy02', { member: OTHER }))
    expect(q.position).toBe('starting')
    expect(h.core.personData(OTHER, 'delete')).toEqual({ busy: true })
  }))
})
