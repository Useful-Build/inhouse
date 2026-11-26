// The job engine (M1-B, N3, N4) case by case, on the BrandAgent's real SQLite with the port fakes and a fake texts
// port. Expected values are literals written here from N3's table and the spike's answer, never read from the engine.
// Ways it can fail, written down first:
//  1. a turn becomes a job when it shouldn't (texts not wired, a routine's turn, a person's stop racing the cut, a
//     person's message queued behind it, a damaged session), or doesn't when it should (max_turns, the cut);
//  2. a continuation is submitted twice, under an old gen, past the cap, without `openJob` first, without the job on
//     its start hold, or with the person's own source;
//  3. a job turn's end is judged wrong (N3's table), the no-progress guard or the retry bound never fires;
//  4. recovery (N4, variant A): a killed job turn on either crash path damages the chat, or a mirror error, a non-job
//     turn or a turn with no prior checkpoint keeps it resumable; `session_damaged` is ever bypassed;
//  5. the cap, Cancel, Pause, a person's stop or a removed owner leave a turn running or a continuation pending;
//  6. a person's message ends the job (Q4 = B says it carries on) or runs as the job's own turn;
//  7. `job.ended` or the notice comes twice or never; a reload can't see the job; progress is lost.
import { beforeEach, describe, expect, it } from 'vitest'
import { setTimings } from '@test-controls'
import { GRACE_MS } from '../core.ts'
import { MEMBER, MIN, OTHER, SEC, d1Chat, ev, fullAnswer, inAgent, settle } from '../../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../../testing/brand-agent/core-harness.ts'
import { AFTER_CUT_OFF, CARRY_ON, allEvents, fakeJobDeps, jobsOf, wireJobs } from '../../../testing/brand-agent/job-kit.ts'
import type { FakeJobDeps } from '../../../testing/brand-agent/job-kit.ts'
import { createAgentTables } from '../schema.ts'
import type { RunEventBody } from '../../../../shared/protocol/index.ts'
import { JOB_STOPPED_BODY, MONTH_CAP_BODY, jobNoticeInput } from './notice.ts'
import { checkNotice } from '../../../notices/store.ts'
import { NOTICE_TEMPLATES } from '../../../notices/templates.ts'

const by = { kind: 'person' as const, memberId: MEMBER }
// A chat of its own per test: D1 is shared across the file, and a chat's flushed history is keyed by its positions.
let CHAT = ''
let chats = 0
beforeEach(() => { CHAT = `c_job${++chats}_${Math.random().toString(36).slice(2, 8)}` })
const HOUR = 60 * MIN

const cp = (n: number) => ({ mainEntries: n, lastUuid: `u${n}`, lastUuidIndex: n - 1 })
const maxTurns = (n: number): RunEventBody[] => [ev.started(), ev.tool('Bash'), ev.text('working'), ev.checkpoint(n, `u${n}`, n - 1), ev.finished('error_max_turns'), ev.released(cp(n))]
const idleMax = (n: number): RunEventBody[] => [ev.started(), ev.checkpoint(n, `u${n}`, n - 1), ev.finished('error_max_turns'), ev.released(cp(n), true)]

const liveTurn = (h: Harness) => h.turns().find(t => t.chat_id === CHAT && t.state === 'live')
const runOf = (h: Harness) => h.turns()[0].run_id
const jobEvents = (h: Harness) => allEvents(h).filter(e => e.type.startsWith('job.'))

/** A person's turn that hits max_turns at `entries`, then the job's first step: its first continuation is live. */
async function startJob(h: Harness, deps?: FakeJobDeps, entries = 3): Promise<{ deps: FakeJobDeps; rootId: string; jobId: string }> {
  await d1Chat(CHAT, MEMBER)
  const d = wireJobs(h, deps)
  const r = await h.submit(CHAT, 'key-root1')
  if (!('turnId' in r)) throw new Error(`refused ${JSON.stringify(r)}`)
  await settle()
  h.push(r.turnId, ...maxTurns(entries))
  await settle()
  await h.tick(0)
  return { deps: d, rootId: r.turnId, jobId: jobsOf(h)[0]?.job_id ?? '' }
}

describe('promotion (N3)', () => {
  it('a person\'s turn that hits max_turns becomes a job; the first step opens it and submits the carry-on turn', () => inAgent(async h => {
    const { rootId, jobId } = await startJob(h)
    expect(jobsOf(h)).toMatchObject([{ root_turn_id: rootId, state: 'running', pending_n: 2, gen: 0 }])
    expect(jobId).toMatch(/^j_[A-Za-z0-9_-]{22}$/)
    const cont = liveTurn(h)!
    expect(cont).toMatchObject({ job_id: jobId, job_n: 1, source: 'job', text: CARRY_ON(1), priority: 'next', client_key: `job_${jobId}_1`, on_end_json: JSON.stringify({ kind: 'job-step', id: `job-step:${jobId}:2` }) })
    // The ledger's job is opened before the continuation's start hold, and the hold names the job.
    const methods = h.usage.calls.map(c => c.method)
    expect(methods.indexOf('openJob')).toBeGreaterThan(-1)
    expect(methods.indexOf('openJob')).toBeLessThan(methods.lastIndexOf('reserve'))
    expect(h.usage.calls.filter(c => c.method === 'reserve').at(-1)!.args[0]).toMatchObject({ turnId: cont.turn_id, jobId })
    // One run carries the job: the root's run stays live between turns; the server's turn says it's the job's.
    expect(cont.run_id).toBe(runOf(h))
    const queued = h.events(runOf(h)).filter(e => e.type === 'turn.queued')
    expect(queued.map(e => ('source' in e ? e.source : undefined))).toEqual([undefined, 'job'])
    expect(jobEvents(h)).toEqual([{ type: 'job.started', jobId, rootTurnId: rootId }])
  }))

  it('no texts port: nothing is promoted (the port stays null until M1-P)', () => inAgent(async h => {
    const d = fakeJobDeps()
    d.texts = null
    await startJob(h, d)
    expect(jobsOf(h)).toEqual([])
    expect(h.events(runOf(h)).at(-1)!.type).toBe('run.finished')
  }))

  it('a turn_budget end promotes; done, a stop and an SDK error don\'t', () => inAgent(async h => {
    await d1Chat(CHAT, MEMBER)
    wireJobs(h)
    const ends: [string, RunEventBody[]][] = [
      ['done', fullAnswer('ok', 2)],
      ['sdk', [ev.started(), ev.tool('Bash'), ev.checkpoint(3, 'u3', 2), ev.finished('error_during_execution'), ev.released(cp(3))]],
      ['budget', [ev.started(), ev.tool('Bash'), ev.checkpoint(4, 'u4', 3), ev.finished('error_max_budget_usd'), ev.released(cp(4))]],
    ]
    for (const [k, events] of ends) {
      const r = await h.submit(CHAT, `key-${k}-000`)
      await settle()
      if ('turnId' in r) h.push(r.turnId, ...events)
      await settle()
    }
    expect(jobsOf(h).map(j => h.turn(j.root_turn_id).client_key)).toEqual(['key-budget-000'])
  }))

  it('a person\'s message queued behind the turn keeps it from becoming a job', () => inAgent(async h => {
    await d1Chat(CHAT, MEMBER)
    wireJobs(h)
    const a = await h.submit(CHAT, 'key-first01')
    await settle()
    await h.submit(CHAT, 'key-second1')
    if ('turnId' in a) h.push(a.turnId, ...maxTurns(3))
    await settle()
    expect(jobsOf(h)).toEqual([])
  }))

  it('a routine\'s turn (the system member) never becomes a job', () => inAgent(async h => {
    wireJobs(h)
    const r = await h.core.submitTurn({
      chatId: 'c_routine', by: { kind: 'service', memberId: 'm_system' }, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium',
      sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: null,
      input: { clientTurnKey: 'key-routine1', text: 'routine', priority: 'next', model: 'sonnet', attachments: [] },
    }, {})
    await settle()
    if ('turnId' in r) h.push(r.turnId, ...maxTurns(3))
    await settle()
    expect(jobsOf(h)).toEqual([])
  }))
})

describe('the server\'s cut (N3: 25 minutes)', () => {
  it('cuts a person\'s live turn at JOB_CUT_MS and the cut turn becomes a job', () => inAgent(async h => {
    await d1Chat(CHAT, MEMBER)
    wireJobs(h)
    const r = await h.submit(CHAT, 'key-cut0001')
    await settle()
    if (!('turnId' in r)) throw new Error('refused')
    h.push(r.turnId, ev.started(), ev.tool('Bash'))
    // Progress every 5 minutes (no inactivity fence), the runner answering live.
    h.pool.statusAnswer = { state: 'live', containerGone: false }
    for (let i = 0; i < 4; i++) { await h.tick(5 * MIN); h.push(r.turnId, ev.text(`step ${i}`)) }
    await h.tick(4 * MIN)
    h.push(r.turnId, ev.text('still going'))
    expect(h.turn(r.turnId).interrupt_asked).toBe(0)
    await h.tick(61 * SEC)
    expect(h.turn(r.turnId)).toMatchObject({ cut_cause: 'job_cut', interrupt_asked: 1 })
    expect(h.pool.calls.filter(c => c.method === 'interrupt').map(c => c.args[1])).toEqual([r.turnId])
    h.push(r.turnId, ev.checkpoint(3, 'u3', 2), ev.finished('error_during_execution'), ev.released(cp(3)))
    await settle()
    expect(h.turn(r.turnId).outcome).toBe('interrupted')
    expect(jobsOf(h)).toMatchObject([{ root_turn_id: r.turnId, state: 'running' }])
  }))

  it('a person\'s interrupt racing the cut never starts a job', () => inAgent(async h => {
    setTimings({ JOB_CUT_MS: MIN })
    try {
      await d1Chat(CHAT, MEMBER)
      wireJobs(h)
      const r = await h.submit(CHAT, 'key-race001')
      await settle()
      if (!('turnId' in r)) throw new Error('refused')
      h.push(r.turnId, ev.started(), ev.tool('Bash'))
      await h.tick(MIN + SEC)
      expect(h.turn(r.turnId).cut_cause).toBe('job_cut')
      expect(h.core.interrupt(r.turnId, by)).toEqual({ ok: true })
      h.push(r.turnId, ev.checkpoint(3, 'u3', 2), ev.finished('error_during_execution'), ev.released(cp(3)))
      await settle()
      expect(h.turn(r.turnId)).toMatchObject({ outcome: 'interrupted', person_stop: 1 })
      expect(jobsOf(h)).toEqual([])
    } finally {
      setTimings({})
    }
  }))

  it('never cuts a routine\'s turn', () => inAgent(async h => {
    setTimings({ JOB_CUT_MS: MIN })
    try {
      wireJobs(h)
      const r = await h.core.submitTurn({
        chatId: 'c_routine', by: { kind: 'service', memberId: 'm_system' }, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium',
        sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: null,
        input: { clientTurnKey: 'key-routine2', text: 'routine', priority: 'next', model: 'sonnet', attachments: [] },
      }, {})
      await settle()
      if (!('turnId' in r)) throw new Error('refused')
      h.push(r.turnId, ev.started(), ev.tool('Bash'))
      await h.tick(MIN + SEC)
      expect(h.turn(r.turnId)).toMatchObject({ cut_cause: null, interrupt_asked: 0 })
    } finally {
      setTimings({})
    }
  }))
})

describe('after each job turn (N3\'s table)', () => {
  it('done: the job ends done, one job.ended, the ledger closed and one job_finished notice; the run ends', () => inAgent(async h => {
    const { deps, jobId } = await startJob(h)
    const t = liveTurn(h)!
    h.push(t.turn_id, ...fullAnswer('all done', 5))
    await settle()
    await h.tick(0)
    expect(jobsOf(h)).toMatchObject([{ state: 'ended', outcome: 'done', result_sent: 1 }])
    expect(jobEvents(h).map(e => e.type)).toEqual(['job.started', 'job.ended'])
    expect(jobEvents(h)[1]).toMatchObject({ jobId, outcome: 'done', cost: { currency: 'USD' } })
    expect(h.usage.calls.filter(c => c.method === 'closeJob').map(c => c.args[0])).toEqual([jobId])
    expect(deps.sent).toEqual([{ id: `job_${jobId}`, jobId, chatId: CHAT, ownerId: MEMBER, outcome: 'done', cause: null, atMs: h.clock.now }])
    expect(h.events(runOf(h)).at(-1)!.type).toBe('run.finished')
    // A late second end task (an at-least-once alarm) changes nothing.
    await h.core.jobEnd({ id: `job-end:${jobId}`, kind: 'job-end', gen: 1, dueAtMs: h.clock.now, payload: null, attempts: 0 })
    expect(deps.sent).toHaveLength(1)
  }))

  it('max_turns carries on with the next step\'s text; two idle continuations end it stuck', () => inAgent(async h => {
    const { jobId } = await startJob(h)
    h.push(liveTurn(h)!.turn_id, ...maxTurns(5))
    await settle()
    await h.tick(0)
    expect(liveTurn(h)).toMatchObject({ job_n: 2, text: CARRY_ON(2) })
    h.push(liveTurn(h)!.turn_id, ...idleMax(6))
    await settle()
    await h.tick(0)
    expect(liveTurn(h)).toMatchObject({ job_n: 3 })
    h.push(liveTurn(h)!.turn_id, ...idleMax(7))
    await settle()
    await h.tick(0)
    expect(liveTurn(h)).toBeUndefined()
    expect(jobsOf(h)).toMatchObject([{ job_id: jobId, state: 'ended', outcome: 'stuck' }])
  }))

  it('an SDK error ends it failed; a stopped turn ends it cancelled', () => inAgent(async h => {
    await startJob(h)
    h.push(liveTurn(h)!.turn_id, ev.started(), ev.tool('Bash'), ev.checkpoint(5, 'u5', 4), ev.finished('error_during_execution'), ev.released(cp(5)))
    await settle()
    await h.tick(0)
    expect(jobsOf(h)[0]).toMatchObject({ state: 'ended', outcome: 'failed' })
  }))

  it('the job budget refuses a turn\'s start hold: the turn is cancelled job_budget (not retried), the job ends budget', () => inAgent(async h => {
    const { deps, jobId } = await startJob(h)
    const reserve = h.usage.reserve.bind(h.usage)
    h.usage.reserve = async t => (t.jobId !== undefined ? { refused: 'job_budget' } : reserve(t))
    h.push(liveTurn(h)!.turn_id, ...maxTurns(5))
    await settle()
    await h.tick(0)
    const cancelled = h.turns().find(t => t.job_n === 2)!
    expect(cancelled).toMatchObject({ state: 'cancelled', cancel_why: 'job_budget', started_at_ms: null })
    await h.tick(0)
    expect(jobsOf(h)[0]).toMatchObject({ state: 'ended', outcome: 'budget' })
    expect(h.turns().filter(t => t.job_id === jobId)).toHaveLength(3)
    expect(deps.sent.map(n => n.outcome)).toEqual(['budget'])
    const notice = jobNoticeInput(deps.sent[0])
    expect(notice).toMatchObject({ template: 'job_stopped', body: JOB_STOPPED_BODY.budget, audience: 'member', audienceMemberId: MEMBER, link: { to: 'chat', id: CHAT } })
    expect(() => checkNotice(NOTICE_TEMPLATES, notice)).not.toThrow()
    expect(() => checkNotice(NOTICE_TEMPLATES, jobNoticeInput({ ...deps.sent[0], outcome: 'done' }))).not.toThrow()
  }))
})

describe('recovery (N4, the spike\'s variant A)', () => {
  it('a job turn killed after checkpoint A (the runner\'s own crash, no fence) resumes at A with afterCutOff', () => inAgent(async h => {
    await startJob(h, undefined, 3)
    const t = liveTurn(h)!
    expect(JSON.parse(t.start_json!).expect).toMatchObject({ mainEntries: 3 })
    h.push(t.turn_id, ev.started(), ev.tool('Bash'), ev.text('half way'), ev.failed('session_crashed'), ev.released(null, true))
    await settle()
    expect(h.turn(t.turn_id)).toMatchObject({ outcome: 'failed', failure: 'session_crashed', recovered: 1, fenced: 0 })
    expect(h.sql.exec('SELECT session, checkpoint_main_entries FROM chat_state').one()).toEqual({ session: 'resumable', checkpoint_main_entries: 3 })
    await h.tick(0)
    const next = liveTurn(h)!
    expect(next).toMatchObject({ job_n: 2, text: AFTER_CUT_OFF(2) })
    expect(JSON.parse(next.start_json!).expect).toMatchObject({ mainEntries: 3, lastUuid: 'u3', lastUuidIndex: 2 })
  }))

  it('the same through the fence (the container exited, the grace ran out)', () => inAgent(async h => {
    await startJob(h, undefined, 3)
    const t = liveTurn(h)!
    h.push(t.turn_id, ev.started(), ev.tool('Bash'))
    h.pool.runnerTurns.set('runner-0', [t.turn_id])
    h.core.containerExited('runner-0', 1, true)
    expect(h.turn(t.turn_id)).toMatchObject({ state: 'ending', fenced: 1 })
    await h.tick(GRACE_MS)
    expect(h.turn(t.turn_id)).toMatchObject({ state: 'ended', recovered: 1 })
    expect(h.sql.exec('SELECT session FROM chat_state').one().session).toBe('resumable')
    await h.tick(0)
    expect(liveTurn(h)).toMatchObject({ job_n: 2, text: AFTER_CUT_OFF(2) })
  }))

  it('a mirror error keeps the chat damaged: the job ends failed on session_damaged, never bypassed', () => inAgent(async h => {
    await startJob(h)
    const t = liveTurn(h)!
    h.push(t.turn_id, ev.started(), ev.tool('Bash'), ev.mirrorError(), ev.failed('session_crashed'), ev.released(null, true))
    await settle()
    expect(h.turn(t.turn_id).recovered).toBe(0)
    expect(h.sql.exec('SELECT session FROM chat_state').one().session).toBe('damaged')
    await h.tick(0)
    expect(jobsOf(h)[0]).toMatchObject({ state: 'ended', outcome: 'failed' })
    expect(h.turns().filter(t2 => t2.job_n === 2)).toEqual([])
  }))

  it('a kill before any checkpoint: the chat is damaged as before and no job exists', () => inAgent(async h => {
    await d1Chat(CHAT, MEMBER)
    wireJobs(h)
    const r = await h.submit(CHAT, 'key-kill001')
    await settle()
    if (!('turnId' in r)) throw new Error('refused')
    h.push(r.turnId, ev.started(), ev.tool('Bash'), ev.failed('session_crashed'), ev.released(null, true))
    await settle()
    expect(h.turn(r.turnId).recovered).toBe(0)
    expect(h.sql.exec('SELECT session FROM chat_state').one().session).toBe('damaged')
    expect(jobsOf(h)).toEqual([])
  }))

  it('a non-job turn killed after a checkpoint still damages the chat (P3\'s rule, unchanged)', () => inAgent(async h => {
    await d1Chat(CHAT, MEMBER)
    wireJobs(h)
    const a = await h.submit(CHAT, 'key-first01')
    await settle()
    if ('turnId' in a) h.push(a.turnId, ...fullAnswer('ok', 3))
    await settle()
    const b = await h.submit(CHAT, 'key-second1')
    await settle()
    if (!('turnId' in b)) throw new Error('refused')
    h.push(b.turnId, ev.started(), ev.tool('Bash'), ev.failed('session_crashed'), ev.released(null, true))
    await settle()
    expect(h.sql.exec('SELECT session FROM chat_state').one().session).toBe('damaged')
  }))

  it('three infrastructure retries in a row, then the job ends failed', () => inAgent(async h => {
    await startJob(h)
    for (let i = 0; i < 4; i++) {
      h.push(liveTurn(h)!.turn_id, ev.started(), ev.tool('Bash'), ev.failed('session_crashed'), ev.released(null, true))
      await settle()
      await h.tick(0)
    }
    expect(jobsOf(h)[0]).toMatchObject({ state: 'ended', outcome: 'failed', infra_retries: 3 })
    expect(h.turns().filter(t => t.job_id !== null)).toHaveLength(5)
  }))
})

describe('the 8-hour cap, Cancel, Pause and authority', () => {
  it('the cap interrupts the live turn (cut job_deadline) and ends the job time; nothing starts after', () => inAgent(async h => {
    setTimings({ JOB_DEADLINE_MS: 20 * MIN })
    try {
      const { jobId } = await startJob(h)
      const t = liveTurn(h)!
      h.push(t.turn_id, ev.started(), ev.tool('Bash'))
      h.pool.statusAnswer = { state: 'live', containerGone: false }
      for (let i = 0; i < 5; i++) { h.push(t.turn_id, ev.text(`tick ${i}`)); await h.tick(5 * MIN + 1) }
      expect(jobsOf(h)[0]).toMatchObject({ state: 'ended', outcome: 'time' })
      expect(h.turn(t.turn_id)).toMatchObject({ cut_cause: 'job_deadline', interrupt_asked: 1 })
      h.push(t.turn_id, ev.checkpoint(5, 'u5', 4), ev.finished('error_during_execution'), ev.released(cp(5)))
      await settle()
      await h.tick(0)
      expect(h.turns().filter(x => x.job_id === jobId)).toHaveLength(2)
      expect(jobEvents(h).filter(e => e.type === 'job.ended')).toHaveLength(1)
    } finally {
      setTimings({})
    }
  }))

  it('a continuation held by a drain whose retry comes after the cap never starts: the job ends time', () => inAgent(async h => {
    setTimings({ JOB_DEADLINE_MS: 30 * MIN })
    try {
      const { jobId } = await startJob(h)
      h.core.drain()
      h.push(liveTurn(h)!.turn_id, ...maxTurns(5))
      await settle()
      await h.tick(0)
      expect(h.dueTasks().map(t => t.id)).toContain(`job-step:${jobId}:2`)
      h.pool.undrain()
      // The retry (due in a minute) runs only after the cap has passed, before the cap's own task.
      await h.tick(31 * MIN)
      expect(h.turns().filter(t => t.job_n === 2)).toEqual([])
      expect(jobsOf(h)[0]).toMatchObject({ state: 'ended', outcome: 'time' })
    } finally {
      setTimings({})
    }
  }))

  it('a stale continuation (an older gen, or past the cap) is refused conflict in admit()', () => inAgent(async h => {
    const { jobId } = await startJob(h)
    const r = await h.core.submitTurn({
      chatId: CHAT, by, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium', sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: [],
      input: { clientTurnKey: `job_${jobId}_2`, text: 'x', priority: 'next', model: 'sonnet', attachments: [] },
    }, { onEnd: { kind: 'job-step', id: `job-step:${jobId}:3` }, job: { jobId, gen: 7, n: 2 } })
    expect(r).toEqual({ refused: { code: 'conflict' } })
  }))

  it('Cancel: the owner only; the live turn is stopped, the job ends cancelled once, and a second Cancel answers it', () => inAgent(async h => {
    const { deps, jobId } = await startJob(h)
    const t = liveTurn(h)!
    expect(h.core.cancelJob(jobId, { kind: 'person', memberId: OTHER })).toEqual({ refused: { code: 'not_found' } })
    const a = h.core.cancelJob(jobId, by)
    expect(a).toMatchObject({ job: { jobId, state: 'ended', outcome: 'cancelled' } })
    expect(h.turn(t.turn_id)).toMatchObject({ fenced: 1, outcome: 'stopped', person_stop: 1 })
    expect(h.core.cancelJob(jobId, by)).toEqual(a)
    await h.tick(GRACE_MS)
    expect(h.turns().filter(x => x.job_id === jobId)).toHaveLength(2)
    expect(deps.sent.map(n => n.outcome)).toEqual(['cancelled'])
    expect(jobEvents(h).filter(e => e.type === 'job.ended')).toHaveLength(1)
  }))

  it('a person\'s stop on a job turn cancels the job; Pause cancels a running one and Resume starts nothing', () => inAgent(async h => {
    await startJob(h)
    expect(h.core.stop(liveTurn(h)!.turn_id, by)).toEqual({ ok: true })
    expect(jobsOf(h)[0]).toMatchObject({ outcome: 'cancelled' })
  }))

  it('Pause ends the job cancelled; Resume starts nothing', () => inAgent(async h => {
    await startJob(h)
    await h.core.pause({ kind: 'person', memberId: 'm_admin' })
    expect(jobsOf(h)[0]).toMatchObject({ state: 'ended', outcome: 'cancelled' })
    await h.core.resume({ kind: 'person', memberId: 'm_admin' })
    await h.tick(2 * GRACE_MS)
    expect(h.turns().filter(t => ['queued', 'starting', 'live'].includes(t.state))).toEqual([])
  }))

  it('authority on every continuation: an owner gone in D1 ends it cancelled; a model switched off ends it failed', () => inAgent(async h => {
    const { deps } = await startJob(h)
    deps.member.active = false
    h.push(liveTurn(h)!.turn_id, ...maxTurns(5))
    await settle()
    await h.tick(0)
    expect(jobsOf(h)[0]).toMatchObject({ outcome: 'cancelled' })
  }))

  it('a model switched off at a continuation ends the job failed', () => inAgent(async h => {
    const { deps } = await startJob(h)
    deps.settingsAnswer = { refused: 'model_off' }
    h.push(liveTurn(h)!.turn_id, ...maxTurns(5))
    await settle()
    await h.tick(0)
    expect(jobsOf(h)[0]).toMatchObject({ outcome: 'failed' })
  }))

  it('a drain holds the continuation: tried again a minute later, then it starts', () => inAgent(async h => {
    await startJob(h)
    h.push(liveTurn(h)!.turn_id, ...maxTurns(5))
    h.core.drain()
    await settle()
    await h.tick(0)
    expect(liveTurn(h)).toBeUndefined()
    expect(jobsOf(h)[0]).toMatchObject({ state: 'running', pending_n: 2 })
    h.pool.undrain()
    await h.tick(61 * SEC)
    expect(liveTurn(h)).toMatchObject({ job_n: 2 })
  }))
})

describe('a person\'s message during a job (Q4 = B)', () => {
  it('a next message is answered after the job\'s turn, then the job carries on', () => inAgent(async h => {
    const { jobId } = await startJob(h)
    const msg = await h.submit(CHAT, 'key-howsit1')
    expect(msg).toMatchObject({ position: 'queued' })
    h.push(liveTurn(h)!.turn_id, ...maxTurns(5))
    await settle()
    await h.tick(0)
    // The person's message runs first, as their own turn; the job's continuation waits behind it.
    expect(liveTurn(h)).toMatchObject({ client_key: 'key-howsit1', job_id: null, source: 'person' })
    expect(h.turns().find(t => t.job_n === 2)).toMatchObject({ state: 'queued' })
    h.push(liveTurn(h)!.turn_id, ...fullAnswer('it is going well', 6))
    await settle()
    expect(liveTurn(h)).toMatchObject({ job_id: jobId, job_n: 2 })
    expect(jobsOf(h)[0].state).toBe('running')
  }))

  it('a now message interrupts the job\'s turn without ending the job', () => inAgent(async h => {
    const { jobId } = await startJob(h)
    const jt = liveTurn(h)!
    await h.submit(CHAT, 'key-nowmsg1', { priority: 'now' })
    expect(h.turn(jt.turn_id)).toMatchObject({ cut_cause: 'message', interrupt_asked: 1 })
    h.push(jt.turn_id, ev.started(), ev.tool('Bash'), ev.checkpoint(5, 'u5', 4), ev.finished('error_during_execution'), ev.released(cp(5)))
    await settle()
    await h.tick(0)
    expect(liveTurn(h)).toMatchObject({ client_key: 'key-nowmsg1' })
    h.push(liveTurn(h)!.turn_id, ...fullAnswer('answered', 6))
    await settle()
    expect(liveTurn(h)).toMatchObject({ job_id: jobId, job_n: 2, text: CARRY_ON(2) })
  }))
})

describe('review round 1', () => {
  const deferredEnd = (n: number): RunEventBody[] => [ev.started(), ev.tool('Bash'), ev.deferred(), ev.checkpoint(n, `u${n}`, n - 1), ev.success(), ev.released(cp(n))]
  const questionOf = (h: Harness) => (JSON.parse(h.sql.exec<{ waiting_json: string }>('SELECT waiting_json FROM chat_state WHERE chat_id = ?', CHAT).one().waiting_json) as { questionId: string }).questionId

  it('a deferred job turn\'s resume is the job\'s turn: its hold names the job, Cancel stops it, a now message carries the job on', () => inAgent(async h => {
    const { jobId } = await startJob(h)
    const parked = liveTurn(h)!
    h.push(parked.turn_id, ...deferredEnd(5))
    await settle()
    expect(jobsOf(h)[0].state).toBe('waiting')
    const r = await h.core.resumeDeferred(CHAT, 'allow', questionOf(h))
    if (!('turnId' in r)) throw new Error(`refused ${JSON.stringify(r)}`)
    await settle()
    expect(h.turn(r.turnId)).toMatchObject({ job_id: jobId, job_n: 1, state: 'live' })
    expect(jobsOf(h)[0]).toMatchObject({ state: 'running', last_turn_id: r.turnId })
    expect(h.usage.calls.filter(c => c.method === 'reserve').at(-1)!.args[0]).toMatchObject({ turnId: r.turnId, jobId })
    // Q4 = B reaches it: a now message interrupts it as the job's own, and the job carries on after the answer.
    await h.submit(CHAT, 'key-nowres1', { priority: 'now' })
    expect(h.turn(r.turnId)).toMatchObject({ cut_cause: 'message', interrupt_asked: 1 })
    h.push(r.turnId, ev.checkpoint(6, 'u6', 5), ev.finished('error_during_execution'), ev.released(cp(6)))
    await settle()
    await h.tick(0)
    h.push(liveTurn(h)!.turn_id, ...fullAnswer('answered', 7))
    await settle()
    expect(liveTurn(h)).toMatchObject({ job_id: jobId, job_n: 2 })
    // Cancel reaches the job's live turn.
    h.core.cancelJob(jobId, by)
    expect(liveTurn(h)).toBeUndefined()
  }))

  it('two quick now messages that cut idle job turns never end the job stuck', () => inAgent(async h => {
    const { jobId } = await startJob(h)
    for (let i = 0; i < 2; i++) {
      const jt = liveTurn(h)!
      await h.submit(CHAT, `key-quick${i}000`, { priority: 'now' })
      h.push(jt.turn_id, ev.started(), ev.checkpoint(5 + 2 * i, `u${5 + 2 * i}`, 4 + 2 * i), ev.finished('error_during_execution'), ev.released(cp(5 + 2 * i)))
      await settle()
      await h.tick(0)
      h.push(liveTurn(h)!.turn_id, ...fullAnswer('answered', 6 + 2 * i))
      await settle()
    }
    expect(jobsOf(h)[0]).toMatchObject({ job_id: jobId, state: 'running', idle_steps: 0 })
    expect(liveTurn(h)).toMatchObject({ job_id: jobId, job_n: 3 })
  }))

  it('Cancel on a waiting job closes its question: the chat takes messages again and an answer resumes nothing', () => inAgent(async h => {
    const { jobId } = await startJob(h)
    h.push(liveTurn(h)!.turn_id, ...deferredEnd(5))
    await settle()
    const q = questionOf(h)
    h.core.cancelJob(jobId, by)
    expect(h.sql.exec('SELECT session, waiting_json FROM chat_state WHERE chat_id = ?', CHAT).one()).toEqual({ session: 'none', waiting_json: null })
    expect(await h.core.resumeDeferred(CHAT, 'allow', q)).toEqual({ refused: { code: 'not_found' } })
    expect(await h.submit(CHAT, 'key-afterq1')).toMatchObject({ position: 'starting' })
  }))

  it('Pause while a person\'s turn is ending at max_turns, then Resume: no job', () => inAgent(async h => {
    await d1Chat(CHAT, MEMBER)
    wireJobs(h)
    const r = await h.submit(CHAT, 'key-pausend')
    await settle()
    if (!('turnId' in r)) throw new Error('refused')
    h.push(r.turnId, ev.started(), ev.tool('Bash'), ev.checkpoint(3, 'u3', 2), ev.finished('error_max_turns'))
    expect(h.turn(r.turnId)).toMatchObject({ state: 'ending', outcome: 'failed', failure: 'max_turns' })
    await h.core.pause({ kind: 'person', memberId: 'm_admin' })
    h.push(r.turnId, ev.released(cp(3)))
    await settle()
    expect(h.turn(r.turnId)).toMatchObject({ state: 'ended', failure: 'max_turns', cancel_why: 'paused' })
    await h.core.resume({ kind: 'person', memberId: 'm_admin' })
    await h.tick(MIN)
    expect(jobsOf(h)).toEqual([])
    expect(h.turns()).toHaveLength(1)
  }))

  it('jobs off (no texts port): a person\'s turn is never cut, it runs on to the runner\'s own stop', () => inAgent(async h => {
    const d = fakeJobDeps()
    d.texts = null
    await d1Chat(CHAT, MEMBER)
    wireJobs(h, d)
    const r = await h.submit(CHAT, 'key-nocut01')
    await settle()
    if (!('turnId' in r)) throw new Error('refused')
    h.push(r.turnId, ev.started(), ev.tool('Bash'))
    h.pool.statusAnswer = { state: 'live', containerGone: false }
    for (let i = 0; i < 6; i++) { await h.tick(5 * MIN); h.push(r.turnId, ev.text(`step ${i}`)) }
    expect(h.turn(r.turnId)).toMatchObject({ state: 'live', cut_cause: null, interrupt_asked: 0 })
  }))

  it('a short JOB_CUT_MS cuts on time: the first watch comes no later than the cut', () => inAgent(async h => {
    setTimings({ JOB_CUT_MS: 30 * SEC })
    try {
      await d1Chat(CHAT, MEMBER)
      wireJobs(h)
      const r = await h.submit(CHAT, 'key-short01')
      await settle()
      if (!('turnId' in r)) throw new Error('refused')
      h.push(r.turnId, ev.started(), ev.tool('Bash'))
      await h.tick(31 * SEC)
      expect(h.turn(r.turnId)).toMatchObject({ cut_cause: 'job_cut', interrupt_asked: 1 })
    } finally {
      setTimings({})
    }
  }))

  it('the monthly cap ends the job budget with its own words: raise the monthly cap, not the job budget', () => inAgent(async h => {
    const { deps } = await startJob(h)
    const reserve = h.usage.reserve.bind(h.usage)
    h.usage.reserve = async t => (t.jobId !== undefined ? { refused: 'cap_reached' } : reserve(t))
    h.push(liveTurn(h)!.turn_id, ...maxTurns(5))
    await settle()
    await h.tick(0)
    await h.tick(0)
    expect(jobsOf(h)[0]).toMatchObject({ state: 'ended', outcome: 'budget', end_cause: 'month_cap' })
    expect(deps.sent.map(n => [n.outcome, n.cause])).toEqual([['budget', 'month_cap']])
    const notice = jobNoticeInput(deps.sent[0])
    expect(notice.body).toBe(MONTH_CAP_BODY)
    expect(() => checkNotice(NOTICE_TEMPLATES, notice)).not.toThrow()
  }))
})

describe('progress, the stored job and an older object', () => {
  it('the SDK\'s task events become job.progress; GET\'s read shows the job and its progress after a restart', () => inAgent(async h => {
    const { jobId, rootId } = await startJob(h)
    const t = liveTurn(h)!
    const sys = (m: Record<string, unknown>): RunEventBody => ({ type: 'sdk', truncated: false, message: { type: 'system', uuid: 'x', session_id: 's', ...m } })
    h.push(t.turn_id, ev.started(),
      sys({ subtype: 'task_started', task_id: 'tk1', task_type: 'local_agent', description: 'secret model text' }),
      sys({ subtype: 'task_progress', task_id: 'tk1', description: 'x', last_tool_name: 'WebFetch', usage: {} }),
      sys({ subtype: 'task_started', task_id: 'tk2', task_type: 'local_bash', description: 'y', ambient: true }),
      sys({ subtype: 'task_notification', task_id: 'tk1', status: 'completed', output_file: 'o', summary: 's' }))
    await settle()
    expect(jobEvents(h).filter(e => e.type === 'job.progress')).toEqual([
      { type: 'job.progress', jobId, label: 'Asking a helper', helpers: 1 },
      { type: 'job.progress', jobId, label: 'Reading a web page', helpers: 1 },
      { type: 'job.progress', jobId, label: 'A helper finished', helpers: 0 },
    ])
    const h2 = h.restart()
    wireJobs(h2)
    expect(h2.core.chatJob(CHAT)).toMatchObject({ jobId, chatId: CHAT, rootTurnId: rootId, state: 'running', outcome: null, progress: { label: 'A helper finished', helpers: 0 }, cost: null, endedAt: null })
    expect(h2.core.chatJob('c_none')).toBeNull()
  }))

  it('person data (P8 C1): busy while the job runs or its notice is unwritten; then its row is counted and deleted', () => inAgent(async h => {
    await startJob(h)
    expect(h.core.personData(MEMBER, 'delete')).toEqual({ busy: true })
    h.push(liveTurn(h)!.turn_id, ...fullAnswer('done', 5))
    await settle()
    await h.tick(MIN)
    expect(jobsOf(h)[0]).toMatchObject({ state: 'ended', result_sent: 1 })
    expect(h.core.personData(MEMBER, 'count')).toMatchObject({ counts: { jobs: 1 } })
    expect(h.core.personData(MEMBER, 'delete')).toMatchObject({ counts: { jobs: 1 } })
    expect(jobsOf(h)).toEqual([])
    expect(h.sql.exec("SELECT COUNT(*) AS n FROM due_tasks WHERE id LIKE 'job-%'").one().n).toBe(0)
  }))

  it('a pre-M1 object upgrades: the new turns columns and the jobs table arrive, its rows kept', () => inAgent(async h => {
    await h.submit('c_old', 'key-oldrow1')
    await settle()
    h.sql.exec('DROP INDEX turns_job')
    h.sql.exec('DROP TABLE jobs')
    for (const col of ['job_id', 'job_n', 'cut_cause', 'person_stop', 'recovered', 'source']) h.sql.exec(`ALTER TABLE turns DROP COLUMN ${col}`)
    createAgentTables(h.sql)
    const cols = h.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('turns')").toArray().map(r => r.name)
    expect(cols).toEqual(expect.arrayContaining(['job_id', 'job_n', 'cut_cause', 'person_stop', 'recovered', 'source']))
    expect(h.turns()).toHaveLength(1)
    expect(h.turns()[0]).toMatchObject({ client_key: 'key-oldrow1', job_id: null, person_stop: 0, recovered: 0, source: null })
    expect(jobsOf(h)).toEqual([])
    // The upgraded object runs jobs.
    const h2 = h.restart()
    await startJob(h2)
    expect(jobsOf(h2)).toHaveLength(1)
  }))

  it('a waiting job ends time at its cap and its question is closed', () => inAgent(async h => {
    setTimings({ JOB_DEADLINE_MS: 2 * HOUR })
    try {
      await startJob(h)
      const t = liveTurn(h)!
      h.push(t.turn_id, ev.started(), ev.tool('Bash'), ev.deferred(), ev.checkpoint(5, 'u5', 4), ev.success(), ev.released(cp(5)))
      await settle()
      expect(jobsOf(h)[0].state).toBe('waiting')
      await h.tick(2 * HOUR)
      expect(jobsOf(h)[0]).toMatchObject({ state: 'ended', outcome: 'time' })
      expect(h.sql.exec('SELECT session, waiting_json FROM chat_state').one()).toEqual({ session: 'none', waiting_json: null })
    } finally {
      setTimings({})
    }
  }))
})
