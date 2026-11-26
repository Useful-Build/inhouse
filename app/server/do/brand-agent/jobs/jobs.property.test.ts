// The job engine (M1-B, N3, N4) as a property, written before the engine. Random sequences over one person's chat:
// turn ends of every class (done, max_turns, turn_budget, a turn with no step or part, a crash with and without a
// checkpoint, an SDK error, a deferral), the server's cut, person messages (`next` and `now`), the person's interrupt
// and stop on the live turn, Pause and Resume, Cancel, refused continuations (a drain, the owner gone in D1, a spent
// job budget), container loss, clock jumps up to past the 8-hour cap, and a question's answer. Checked after every step,
// on the stored rows and events only (no engine code is reused here):
//  1. at most one queued or live turn per job;
//  2. nothing is submitted for a job after it ended;
//  3. no job turn starts past the job's deadline, and none the job budget refused ever starts;
//  4. a person's stop or interrupt (which may race the server cut) never continues the job, and never starts one;
//  5. at most one `job.ended` per job and exactly one once it ended; at most one notice per job;
//  6. liveness: a job that hasn't ended has its cap's task and a way to its next step; one the budget refused has ended;
//  0. every turn that holds one of a job's end tasks (a question's resume too) is that job's own turn.
// At the end the chat is driven to rest (turns answered, the clock past every deadline): every job has ended, with
// exactly one `job.ended` and exactly one notice.
import { fc, test } from '@fast-check/vitest'
import { expect } from 'vitest'
import { setTimings } from '@test-controls'
import type { RunEventBody } from '../../../../shared/protocol/index.ts'
import { GRACE_MS } from '../core.ts'
import { MEMBER, MIN, SEC, d1Chat, ev, inAgent, settle } from '../../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../../testing/brand-agent/core-harness.ts'
import { allEvents, jobsOf, wireJobs } from '../../../testing/brand-agent/job-kit.ts'

type End = 'done' | 'max_turns' | 'turn_budget' | 'idle_max' | 'crash' | 'crash_ckpt' | 'sdk_error' | 'deferred'
type Op =
  | { op: 'send'; prio: 'next' | 'now' }
  | { op: 'end'; how: End }
  | { op: 'cut' }
  | { op: 'cutRace'; act: 'stop' | 'interrupt' }
  | { op: 'stop' | 'interrupt' }
  | { op: 'pause' } | { op: 'resume' }
  | { op: 'cancel' }
  | { op: 'drain' } | { op: 'undrain' }
  | { op: 'member'; active: boolean }
  | { op: 'budgetLow' }
  | { op: 'kill' }
  | { op: 'tick'; ms: number }
  | { op: 'answer' }

const END: End[] = ['done', 'max_turns', 'turn_budget', 'idle_max', 'crash', 'crash_ckpt', 'sdk_error', 'deferred']
// Mostly ends that carry a job on, so most runs reach long jobs; every class still comes up.
const endArb: fc.Arbitrary<End> = fc.oneof(
  { weight: 5, arbitrary: fc.constant('max_turns' as const) },
  { weight: 2, arbitrary: fc.constant('crash' as const) },
  { weight: 2, arbitrary: fc.constant('deferred' as const) },
  ...END.filter(e => e !== 'max_turns' && e !== 'crash' && e !== 'deferred').map(e => ({ weight: 1, arbitrary: fc.constant(e) })),
)
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ op: fc.constant('send' as const), prio: fc.constantFrom('next' as const, 'now' as const) }) },
  { weight: 8, arbitrary: fc.record({ op: fc.constant('end' as const), how: endArb }) },
  { weight: 3, arbitrary: fc.constant({ op: 'cut' as const }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('cutRace' as const), act: fc.constantFrom('stop' as const, 'interrupt' as const) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constantFrom('stop' as const, 'interrupt' as const) }) },
  { weight: 1, arbitrary: fc.constantFrom({ op: 'pause' as const }, { op: 'resume' as const }) },
  { weight: 2, arbitrary: fc.constant({ op: 'cancel' as const }) },
  { weight: 1, arbitrary: fc.constantFrom({ op: 'drain' as const }, { op: 'undrain' as const }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('member' as const), active: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ op: 'budgetLow' as const }) },
  { weight: 1, arbitrary: fc.constant({ op: 'kill' as const }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('tick' as const), ms: fc.constantFrom(0, 30 * SEC, 2 * MIN, 30 * MIN, 3 * 60 * MIN) }) },
  { weight: 3, arbitrary: fc.constant({ op: 'answer' as const }) },
)

// A chat of its own per run: D1 is shared across runs, and a chat's flushed history is keyed by its positions.
let CHAT = ''
let runs = 0
const CUT_MS = MIN
const by = { kind: 'person' as const, memberId: MEMBER }

function endEvents(how: End, entries: number): RunEventBody[] {
  const cp = { mainEntries: entries, lastUuid: `u${entries}`, lastUuidIndex: entries - 1 }
  const ckpt = ev.checkpoint(entries, cp.lastUuid, cp.lastUuidIndex)
  switch (how) {
    case 'done': return [ev.started(), ev.tool('Bash'), ev.text('ok'), ckpt, ev.success(), ev.released(cp)]
    case 'max_turns': return [ev.started(), ev.tool('Bash'), ckpt, ev.finished('error_max_turns'), ev.released(cp)]
    case 'turn_budget': return [ev.started(), ev.tool('Bash'), ckpt, ev.finished('error_max_budget_usd'), ev.released(cp)]
    case 'idle_max': return [ev.started(), ckpt, ev.finished('error_max_turns'), ev.released(cp, true)]
    case 'crash': return [ev.started(), ev.tool('Bash'), ev.failed('session_crashed'), ev.released(null, true)]
    case 'crash_ckpt': return [ev.started(), ev.tool('Bash'), ckpt, ev.failed('session_crashed'), ev.released(cp)]
    case 'sdk_error': return [ev.started(), ev.tool('Bash'), ckpt, ev.finished('error_during_execution'), ev.released(cp)]
    case 'deferred': return [ev.started(), ev.tool('Bash'), ev.deferred(), ckpt, ev.success(), ev.released(cp)]
  }
}

const liveTurn = (h: Harness) => h.turns().find(t => t.chat_id === CHAT && t.state === 'live')
const activeTurn = (h: Harness) => [...h.turns()].reverse().find(t => t.chat_id === CHAT && ['queued', 'starting', 'live'].includes(t.state))

/** What the checks remember between steps: each ended job's turn ids when it was first seen ended. */
interface Memory { endedTurns: Map<string, string[]>; startedAtEnd: Map<string, Set<string>>; budgetRefused: Set<string> }

function check(h: Harness, mem: Memory, deps: ReturnType<typeof wireJobs>) {
  const turns = h.turns()
  const events = allEvents(h)
  for (const j of jobsOf(h)) {
    const own = turns.filter(t => t.job_id === j.job_id)
    // 0. A turn holding one of the job's end tasks is the job's own (a question's resume included): its hold, its cost,
    // Cancel and the cap all reach it through `job_id`.
    const step = `job-step:${j.job_id}:`
    for (const t of turns.filter(o => o.on_end_json !== null && (JSON.parse(o.on_end_json) as { id: string }).id.startsWith(step))) {
      expect(t.job_id, `turn ${t.turn_id} holds an end task of ${j.job_id}`).toBe(j.job_id)
    }
    // 1. At most one queued or live turn per job.
    expect(own.filter(t => ['queued', 'starting', 'live'].includes(t.state)).length, `job ${j.job_id} in flight`).toBeLessThanOrEqual(1)
    // 2. Nothing submitted after the end.
    if (j.state === 'ended') {
      const ids = own.map(t => t.turn_id).sort()
      const was = mem.endedTurns.get(j.job_id)
      if (was === undefined) {
        mem.endedTurns.set(j.job_id, ids)
        mem.startedAtEnd.set(j.job_id, new Set(own.filter(t => t.started_at_ms !== null).map(t => t.turn_id)))
      }
      else expect(ids, `job ${j.job_id} got a turn after it ended`).toEqual(was)
      // Its turns not yet final are on their way out: fenced, or asked to interrupt (the cap's cut, a person's own).
      for (const t of own.filter(o => !['ended', 'cancelled'].includes(o.state))) {
        expect(t.fenced === 1 || t.interrupt_asked === 1, `turn ${t.turn_id} of ended job ${j.job_id} still runs`).toBe(true)
      }
    }
    // 3. Nothing starts past the deadline or past the budget, or after the job ended.
    for (const t of own) {
      if (t.started_at_ms !== null) expect(t.started_at_ms, `turn ${t.turn_id} started past the deadline`).toBeLessThan(j.deadline_ms)
      if (t.started_at_ms !== null && j.ended_at_ms !== null && t.job_n !== 0) {
        expect(mem.startedAtEnd.get(j.job_id)?.has(t.turn_id) ?? true, `turn ${t.turn_id} started after its job ended`).toBe(true)
      }
      if (t.cancel_why === 'job_budget' || t.failure === 'job_budget') expect(t.started_at_ms).toBeNull()
    }
    // A job whose budget refused a turn's start hold has ended (at rest after its step ran): nothing carries it on.
    if (mem.budgetRefused.has(j.job_id)) expect(j.state, `job ${j.job_id} carried on past its budget`).toBe('ended')
    // 6. Liveness: a job that hasn't ended has its cap's task, and its next step is either due or held by a turn whose
    // end will ensure it (a live turn, or the parked turn of a waiting job). A lost continuation fails here, not at the cap.
    if (j.state !== 'ended') {
      const due = new Set(h.dueTasks().map(d => d.id))
      expect(due.has(`job-deadline:${j.job_id}`), `job ${j.job_id} has no cap task`).toBe(true)
      const next = `${step}${j.pending_n}`
      const held = turns.some(t => t.on_end_json !== null && (JSON.parse(t.on_end_json) as { id: string }).id === next
        && (!['ended', 'cancelled'].includes(t.state) || j.state === 'waiting'))
      expect(due.has(next) || held, `job ${j.job_id} (${j.state}) has no way to its step ${j.pending_n}`).toBe(true)
    }
    // 4. A person's stop never continues the job.
    for (const t of own) {
      if (t.person_stop === 1) expect(own.filter(o => (o.job_n as number) > (t.job_n as number)), `job ${j.job_id} continued after a stop`).toEqual([])
    }
    // 5. One `job.ended` per job, exactly once it ended; at most one notice.
    const ended = events.filter(e => e.type === 'job.ended' && e.jobId === j.job_id)
    expect(ended.length, `job.ended for ${j.job_id}`).toBe(j.state === 'ended' ? 1 : 0)
    expect(new Set(deps.sent.filter(n => n.jobId === j.job_id).map(n => n.id)).size).toBeLessThanOrEqual(1)
    expect(events.filter(e => e.type === 'job.started' && e.jobId === j.job_id).length).toBe(1)
  }
  // 4. A person's stop never starts a job.
  for (const t of turns) {
    if (t.person_stop === 1 && t.job_id === null) expect(jobsOf(h).filter(j => j.root_turn_id === t.turn_id)).toEqual([])
  }
}

// Every run opens with a person's turn; half the runs end it at its turn limit at once (a job from the start), the rest
// leave it to the ops (a cut, a race with a stop, any other end).
const START: Op[] = [{ op: 'send', prio: 'next' }]

test.prop([fc.boolean(), fc.array(opArb, { minLength: 1, maxLength: 40 })], { numRuns: 150 })('the job engine keeps N3\'s invariants', (limit, rest) => inAgent(async h0 => {
  const ops = [...START, ...(limit ? [{ op: 'end', how: 'max_turns' } as const] : []), ...rest]
  // A 2-hour cap, so the clock jumps cross it with turns queued, live and between steps.
  setTimings({ JOB_CUT_MS: CUT_MS, JOB_DEADLINE_MS: 2 * 60 * MIN })
  try {
    let h = h0
    CHAT = `c_jobprop${++runs}_${Math.random().toString(36).slice(2, 8)}`
    await d1Chat(CHAT, MEMBER)
    const deps = wireJobs(h)
    h.pool.statusAnswer = { state: 'live', containerGone: false }
    // The job budget spent out: the ledger refuses every job turn's start hold from now on (`job_budget`, N5).
    const budget = { spent: false }
    const reserve = h.usage.reserve.bind(h.usage)
    const mem: Memory = { endedTurns: new Map(), startedAtEnd: new Map(), budgetRefused: new Set() }
    h.usage.reserve = async t => {
      if (!budget.spent || t.jobId === undefined) return reserve(t)
      mem.budgetRefused.add(t.jobId)
      return { refused: 'job_budget' }
    }
    let key = 0
    let entries = 1
    let gen = 0
    const send = (prio: 'next' | 'now') => h.submit(CHAT, `key-${String(++key).padStart(5, '0')}`, { priority: prio })
    for (const o of ops) {
      switch (o.op) {
        case 'send': await send(o.prio); break
        case 'end': {
          const t = liveTurn(h)
          if (t) h.push(t.turn_id, ...endEvents(o.how, ++entries))
          break
        }
        case 'cut': {
          const t = liveTurn(h)
          if (!t) break
          h.push(t.turn_id, ev.started())
          await h.tick(CUT_MS + SEC)
          // The cut (or anything else) may have ended it meanwhile: answer only a turn still live.
          if (h.turn(t.turn_id).state === 'live') h.push(t.turn_id, ev.tool('Bash'), ev.checkpoint(++entries, `u${entries}`, entries - 1), ev.finished('error_during_execution'), ev.released({ mainEntries: entries, lastUuid: `u${entries}`, lastUuidIndex: entries - 1 }))
          break
        }
        case 'cutRace': {
          // The server's cut and the person's stop or interrupt land together: the turn ends as the cut asked.
          const t = liveTurn(h)
          if (!t) break
          h.push(t.turn_id, ev.started())
          await h.tick(CUT_MS + SEC)
          if (h.turn(t.turn_id).state !== 'live') break
          void (o.act === 'stop' ? h.core.stop(t.turn_id, by) : h.core.interrupt(t.turn_id, by))
          if (h.turn(t.turn_id).state === 'live') h.push(t.turn_id, ev.tool('Bash'), ev.checkpoint(++entries, `u${entries}`, entries - 1), ev.finished('error_during_execution'), ev.released({ mainEntries: entries, lastUuid: `u${entries}`, lastUuidIndex: entries - 1 }))
          break
        }
        case 'stop': case 'interrupt': {
          const t = activeTurn(h)
          if (t) void (o.op === 'stop' ? h.core.stop(t.turn_id, by) : h.core.interrupt(t.turn_id, by))
          break
        }
        case 'pause': await h.core.pause({ kind: 'person', memberId: 'm_admin' }); break
        case 'resume': await h.core.resume({ kind: 'person', memberId: 'm_admin' }); break
        case 'cancel': {
          const j = jobsOf(h).at(-1)
          if (j) h.core.cancelJob(j.job_id, by)
          break
        }
        case 'drain': h.core.drain(); break
        case 'undrain': h.pool.undrain(); break
        case 'member': deps.member.active = o.active; break
        case 'budgetLow': budget.spent = true; break
        case 'kill': {
          const t = liveTurn(h)
          if (!t) break
          h.pool.runnerTurns.set('runner-0', [t.turn_id])
          h.core.containerExited('runner-0', ++gen, true)
          break
        }
        case 'tick': await h.tick(o.ms); break
        case 'answer': {
          const w = h.sql.exec<{ waiting_json: string | null }>('SELECT waiting_json FROM chat_state WHERE chat_id = ?', CHAT).toArray()[0]
          if (w?.waiting_json) await h.core.resumeDeferred(CHAT, 'allow', (JSON.parse(w.waiting_json) as { questionId: string }).questionId)
          break
        }
      }
      await settle()
      await h.tick(0)
      check(h, mem, deps)
    }

    // To rest: no pause, no drain, the owner back; answer every live turn; then past every deadline.
    await h.core.resume({ kind: 'person', memberId: 'm_admin' })
    h.pool.undrain()
    deps.member.active = true
    for (let i = 0; i < 40; i++) {
      const t = liveTurn(h)
      if (t) h.push(t.turn_id, ...endEvents('done', ++entries))
      await settle()
      await h.tick(t ? 0 : 60 * MIN)
      check(h, mem, deps)
    }
    for (let i = 0; i < 3; i++) {
      await h.tick(9 * 60 * MIN + GRACE_MS)
      const t = liveTurn(h)
      if (t) h.push(t.turn_id, ...endEvents('done', ++entries))
      await settle()
      await h.tick(GRACE_MS)
      check(h, mem, deps)
    }
    // Restarted once, as after an eviction: the jobs' state comes back from storage alone.
    h = h.restart()
    wireJobs(h, deps)
    await h.tick(GRACE_MS)
    check(h, mem, deps)
    for (const j of jobsOf(h)) {
      expect(j.state, `job ${j.job_id} at rest`).toBe('ended')
      expect(j.result_sent, `job ${j.job_id}'s notice`).toBe(1)
      expect(deps.sent.filter(n => n.jobId === j.job_id).length, `job ${j.job_id} notices`).toBe(1)
    }
  } finally {
    setTimings({})
  }
}), 600_000)
