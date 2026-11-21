// The due-task scheduler (p3-design section 6) on the BrandAgent's real SQLite, its alarm fired through
// `runDurableObjectAlarm`, against a reference model written below that shares no code with scheduler.ts. Ways it can
// fail, written down first:
//  1. a pass runs the wrong tasks or in the wrong order (priority kinds first, then due time), runs one not yet due, or
//     more than 20;
//  2. a reschedule or cancel during a handler's await is overwritten by that handler's result (the replacement must
//     survive, the cancel must stay cancelled);
//  3. `ensure` moves an existing task; `schedule` keeps old attempts or a quarantine;
//  4. the alarm isn't the earliest ready task after a change, or a quarantined task sets it;
//  5. a retry isn't at the handler's time (or the default backoff after a throw), or a task isn't quarantined after 10
//     failures or on an unknown kind;
//  6. a crash between a handler's success and its delete loses the task (it must run once more, its keyed write
//     showing one effect);
//  7. some other file in the object's folder or a handler sets or deletes the alarm.
import { fc, test } from '@fast-check/vitest'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { alarmPort, backoffMs, createScheduler } from './scheduler.ts'
import type { AlarmPort, DueTask, SqlScheduler, TaskHandler, TaskResult } from './scheduler.ts'

/** Far past the wall clock, so the runtime never fires an alarm on its own: only `runDurableObjectAlarm` does. */
const T = 4_102_444_800_000
type Stub = DurableObjectStub<import('../../index.ts').BrandAgent>
let objects = 0
const freshStub = (): Stub => env.BRAND_AGENT.getByName(`scheduler-${++objects}`)
/**
 * A fresh BrandAgent whose own start seeds (its class's `ensureSeeds()`: W4's usage sweep and audit copy since PR 2b)
 * are cleared, so the scheduler under test starts from an empty table and no alarm.
 */
async function emptyStub(): Promise<Stub> {
  const stub = freshStub()
  await runInDurableObject(stub, async (_i, state) => {
    state.storage.sql.exec('DELETE FROM due_tasks')
    await state.storage.deleteAlarm()
  })
  return stub
}

interface Harness<C> {
  stub: Stub
  sched: SqlScheduler
  clock: { now: number }
  sql: SqlStorage
  /** Builds another scheduler over the same storage (an object restart), and routes the alarm to it. */
  restart(opts?: Partial<Opts<C>>): Promise<SqlScheduler>
}
interface Opts<C> {
  handlers: Record<string, TaskHandler<C>>
  afterHandler?: (task: DueTask, result: TaskResult) => void
}

/** A scheduler inside a fresh BrandAgent, with the object's `alarm()` routed to it (the class gets its own in W1's next PR). */
async function harness(opts: Opts<{ nowMs: number }>): Promise<Harness<{ nowMs: number }>> {
  const stub = await emptyStub()
  const clock = { now: T }
  let sql!: SqlStorage
  const build = (o: Opts<{ nowMs: number }>) => runInDurableObject(stub, (instance, state) => {
    sql = state.storage.sql
    const sched = createScheduler({
      sql: state.storage.sql, alarm: alarmPort(state.storage), now: () => clock.now, handlers: o.handlers,
      context: nowMs => ({ nowMs }), afterHandler: o.afterHandler,
    })
    ;(instance as unknown as { alarm: () => Promise<void> }).alarm = () => sched.alarm()
    return sched
  })
  const sched = await build(opts)
  return { stub, sched, clock, get sql() { return sql }, restart: async o => build({ ...opts, ...o }) }
}

const inObject = <R>(stub: Stub, fn: (state: DurableObjectState) => R | Promise<R>) => runInDurableObject(stub, (_i, state) => fn(state))
const alarmAt = (stub: Stub) => inObject(stub, s => s.storage.getAlarm())
const rows = (stub: Stub) => inObject(stub, s =>
  s.storage.sql.exec<{ id: string; kind: string; due_at_ms: number; attempts: number; state: string }>(
    'SELECT id, kind, due_at_ms, attempts, state FROM due_tasks ORDER BY id').toArray().map(r => ({ ...r })))

// ---------- the reference model (no code shared with scheduler.ts) ----------

type Outcome = { result: 'done' | 'throw' | { retryIn: number }; during: null | { reschedule: number } | { cancel: true } | { replace: number } | { other: string; dueIn: number } }
interface RefTask { kind: string; due: number; attempts: number; state: 'ready' | 'quarantined'; gen: number; why?: 'unknown' | 'attempts' }
const KNOWN = new Set(['a', 'b', 'grant-expiry', 'authority-sweep'])

class Reference {
  tasks = new Map<string, RefTask>()
  private gen = 0
  schedule(id: string, kind: string, due: number) { this.tasks.set(id, { kind, due, attempts: 0, state: 'ready', gen: ++this.gen }) }
  ensure(id: string, kind: string, due: number) {
    const t = this.tasks.get(id)
    // Only a task quarantined as an unknown kind comes back; one quarantined for its failures stays.
    if (!t || (t.state === 'quarantined' && t.why === 'unknown' && t.kind === kind)) this.schedule(id, kind, due)
  }
  cancel(id: string) { this.tasks.delete(id) }
  earliest(): number | null {
    let best: number | null = null
    for (const t of this.tasks.values()) if (t.state === 'ready' && (best === null || t.due < best)) best = t.due
    return best
  }
  /**
   * One pass at `now`: the ids whose handler ran, in order. `outcome()` hands out the scripted outcomes in the order
   * handlers ask.
   */
  pass(now: number, outcome: () => Outcome): string[] {
    const ran: string[] = []
    const called: string[] = []
    while (ran.length < 20) {
      const first = (k: string) => (k === 'grant-expiry' || k === 'authority-sweep' ? 0 : 1)
      const due = [...this.tasks].filter(([id, t]) => t.state === 'ready' && t.due <= now && !ran.includes(id))
        .sort(([ia, a], [ib, b]) => first(a.kind) - first(b.kind) || a.due - b.due || (ia < ib ? -1 : ia > ib ? 1 : 0))
      if (due.length === 0) break
      const [id, t] = due[0]
      ran.push(id)
      if (!KNOWN.has(t.kind)) { t.state = 'quarantined'; t.why = 'unknown'; continue }
      called.push(id)
      const startGen = t.gen, startAttempts = t.attempts
      const o = outcome()
      if (o.during && 'reschedule' in o.during) this.schedule(id, t.kind, now + o.during.reschedule)
      else if (o.during && 'cancel' in o.during) this.cancel(id)
      else if (o.during && 'replace' in o.during) { this.cancel(id); this.schedule(id, t.kind, now + o.during.replace) }
      else if (o.during) this.schedule(o.during.other, 'b', now + o.during.dueIn)
      const cur = this.tasks.get(id)
      if (!cur || cur.gen !== startGen) continue
      if (o.result === 'done') { this.tasks.delete(id); continue }
      cur.attempts += 1
      cur.due = o.result === 'throw' ? now + Math.min(30_000 * 2 ** startAttempts, 3_600_000) : now + o.result.retryIn
      cur.state = cur.attempts >= 10 ? 'quarantined' : 'ready'
      if (cur.state === 'quarantined') cur.why = 'attempts'
    }
    return called
  }
  rows() {
    return [...this.tasks].sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, t]) => ({ id, kind: t.kind, due_at_ms: t.due, attempts: t.attempts, state: t.state }))
  }
}

// ---------- the model test ----------

/** A time offset, often exactly 0 (due now: the case a pass must not run twice). */
const offset = (max: number) => fc.oneof(fc.constant(0), fc.constant(0), fc.integer({ min: 0, max }))
const ids = fc.constantFrom('x1', 'x2', 'x3', 'g1')
const kinds = fc.constantFrom('a', 'b', 'grant-expiry', 'authority-sweep', 'mystery')
const op = fc.oneof(
  fc.record({ schedule: ids, kind: kinds, dueIn: offset(300_000) }),
  fc.record({ ensure: ids, kind: kinds, dueIn: offset(300_000) }),
  fc.record({ cancel: ids }),
  fc.record({ advance: fc.integer({ min: 0, max: 400_000 }) }),
  fc.constant({ alarm: true as const }),
  fc.constant({ alarm: true as const }),
)
const outcome: fc.Arbitrary<Outcome> = fc.record({
  result: fc.oneof(fc.constantFrom<'done' | 'throw'>('done', 'done', 'throw'), fc.record({ retryIn: offset(200_000) })),
  during: fc.oneof(
    fc.constant(null), fc.constant(null),
    fc.record({ reschedule: offset(200_000) }),
    fc.constant({ cancel: true as const }),
    fc.record({ replace: offset(200_000) }),
    fc.record({ other: ids, dueIn: offset(200_000) }),
  ),
})

describe('the scheduler against its reference (failures 1-5)', () => {
  test.prop([fc.array(op, { minLength: 1, maxLength: 25 }), fc.array(outcome, { minLength: 1, maxLength: 8 })], { numRuns: 100 })(
    'runs, keeps and alarms exactly as the reference does, with changes during a handler\'s await',
    async (ops, outcomes) => {
      const ref = new Reference()
      let refNext = 0, implNext = 0
      const ranImpl: string[] = []
      let sched!: SqlScheduler
      const handler: TaskHandler<{ nowMs: number }> = async (task, ctx) => {
        ranImpl.push(task.id)
        const o = outcomes[implNext++ % outcomes.length]
        await null // the race window: a change from another request lands here
        if (o.during && 'reschedule' in o.during) sched.schedule({ id: task.id, kind: task.kind, dueAtMs: ctx.nowMs + o.during.reschedule })
        else if (o.during && 'cancel' in o.during) sched.cancel(task.id)
        else if (o.during && 'replace' in o.during) {
          sched.cancel(task.id)
          sched.schedule({ id: task.id, kind: task.kind, dueAtMs: ctx.nowMs + o.during.replace })
        }
        else if (o.during) sched.schedule({ id: o.during.other, kind: 'b', dueAtMs: ctx.nowMs + o.during.dueIn })
        await null
        if (o.result === 'throw') throw new Error('handler failed')
        return o.result === 'done' ? { done: true } : { retryAtMs: ctx.nowMs + o.result.retryIn, error: 'try later' }
      }
      const h = await harness({ handlers: { a: handler, b: handler, 'grant-expiry': handler, 'authority-sweep': handler } })
      sched = h.sched
      for (const o of ops) {
        if ('alarm' in o) {
          const armed = ref.earliest() !== null
          ranImpl.length = 0
          const expected = armed ? ref.pass(h.clock.now, () => outcomes[refNext++ % outcomes.length]) : []
          expect(await runDurableObjectAlarm(h.stub), JSON.stringify(o)).toBe(armed)
          expect(ranImpl, 'the pass ran').toEqual(expected)
        } else if ('advance' in o) {
          h.clock.now += o.advance
          continue
        } else {
          await inObject(h.stub, async () => {
            if ('schedule' in o) sched.schedule({ id: o.schedule, kind: o.kind, dueAtMs: h.clock.now + o.dueIn })
            else if ('ensure' in o) sched.ensure({ id: o.ensure, kind: o.kind, dueAtMs: h.clock.now + o.dueIn })
            else sched.cancel(o.cancel)
            await sched.settled()
          })
          if ('schedule' in o) ref.schedule(o.schedule, o.kind, h.clock.now + o.dueIn)
          else if ('ensure' in o) ref.ensure(o.ensure, o.kind, h.clock.now + o.dueIn)
          else ref.cancel(o.cancel)
        }
        expect(await rows(h.stub), 'the table').toEqual(ref.rows())
        expect(await alarmAt(h.stub), 'the alarm').toBe(ref.earliest())
      }
    },
  )
})

// ---------- fixed cases ----------

describe('a pass (failure 1)', () => {
  it('stops at 20 tasks; the alarm stays set for the rest', async () => {
    const seen: string[] = []
    const h = await harness({ handlers: { a: async t => { seen.push(t.id); return { done: true } } } })
    await inObject(h.stub, async () => {
      for (let i = 0; i < 25; i++) h.sched.schedule({ id: `t${String(i).padStart(2, '0')}`, kind: 'a', dueAtMs: T + i })
      await h.sched.settled()
    })
    h.clock.now = T + 100
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(seen).toHaveLength(20)
    expect(await alarmAt(h.stub)).toBe(T + 20)
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(seen).toHaveLength(25)
    expect(await alarmAt(h.stub)).toBeNull()
  })
})

describe('quarantine (failures 4, 5)', () => {
  it('after 10 failures the task never runs again and never sets the alarm', async () => {
    let runs = 0
    const h = await harness({ handlers: { a: async (_t, ctx) => { runs++; return { retryAtMs: ctx.nowMs + 1, error: 'no' } } } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'q', kind: 'a', dueAtMs: T }); await h.sched.settled() })
    for (let i = 0; i < 10; i++) {
      h.clock.now += 10
      expect(await runDurableObjectAlarm(h.stub), `run ${i + 1}`).toBe(true)
    }
    expect(runs).toBe(10)
    expect(await rows(h.stub)).toEqual([{ id: 'q', kind: 'a', due_at_ms: h.clock.now + 1, attempts: 10, state: 'quarantined' }])
    expect(await alarmAt(h.stub)).toBeNull()
    expect(await runDurableObjectAlarm(h.stub)).toBe(false)
    expect(await inObject(h.stub, () => h.sched.quarantinedCount())).toBe(1)
    // A schedule brings it back, from 0 attempts.
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'q', kind: 'a', dueAtMs: T + 5 }); await h.sched.settled() })
    expect(await rows(h.stub)).toEqual([{ id: 'q', kind: 'a', due_at_ms: T + 5, attempts: 0, state: 'ready' }])
  })
  it('an unknown kind is quarantined at once and its payload kept', async () => {
    const h = await harness({ handlers: {} })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'u', kind: 'nope', dueAtMs: T, payload: { x: 1 } }); await h.sched.settled() })
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(await inObject(h.stub, s => s.storage.sql.exec('SELECT state, payload_json FROM due_tasks').one())).toEqual({ state: 'quarantined', payload_json: '{"x":1}' })
    expect(await alarmAt(h.stub)).toBeNull()
  })
})

describe('a crash between a handler\'s success and its delete (failure 6)', () => {
  it('runs the task once more; its keyed write shows one effect', async () => {
    let calls = 0
    let crash = true
    const handler: TaskHandler<{ nowMs: number }> = async task => {
      calls++
      h.sql.exec('CREATE TABLE IF NOT EXISTS effects (task_id TEXT PRIMARY KEY)')
      h.sql.exec('INSERT OR IGNORE INTO effects (task_id) VALUES (?)', task.id)
      return { done: true }
    }
    const h = await harness({ handlers: { a: handler }, afterHandler: () => { if (crash) { crash = false; throw new Error('crashed') } } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'c', kind: 'a', dueAtMs: T }); await h.sched.settled() })
    // The pass fails after the handler: the task stays, and the alarm is left no sooner than the fallback delay.
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(await rows(h.stub)).toHaveLength(1)
    expect(await alarmAt(h.stub)).toBe(T + 30_000)
    // After a restart the new scheduler sets the alarm again from the table.
    const again = await h.restart({ afterHandler: undefined })
    await inObject(h.stub, () => again.syncAlarm())
    expect(await alarmAt(h.stub)).toBe(T)
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(calls).toBe(2)
    expect(await rows(h.stub)).toEqual([])
    expect(await inObject(h.stub, s => s.storage.sql.exec('SELECT COUNT(*) AS n FROM effects').one().n)).toBe(1)
  })
})

describe('a change during a handler\'s await (failure 2)', () => {
  it('a task cancelled and scheduled again while its handler awaits keeps the replacement', async () => {
    let h!: Harness<{ nowMs: number }>
    const handler: TaskHandler<{ nowMs: number }> = async task => {
      await null
      h.sched.cancel(task.id)
      h.sched.schedule({ id: task.id, kind: 'a', dueAtMs: T + 500 })
      await null
      return { done: true }
    }
    h = await harness({ handlers: { a: handler } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'r', kind: 'a', dueAtMs: T }); await h.sched.settled() })
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(await rows(h.stub)).toEqual([{ id: 'r', kind: 'a', due_at_ms: T + 500, attempts: 0, state: 'ready' }])
    expect(await alarmAt(h.stub)).toBe(T + 500)
  })
})

describe('a task due now again during its pass (failure 1)', () => {
  it('a handler that reschedules its own task to now runs once; the alarm is left at now', async () => {
    let calls = 0
    let h!: Harness<{ nowMs: number }>
    h = await harness({ handlers: { a: async (task, ctx) => { calls++; h.sched.schedule({ id: task.id, kind: 'a', dueAtMs: ctx.nowMs }); return { done: true } } } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 's', kind: 'a', dueAtMs: T }); await h.sched.settled() })
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(calls).toBe(1)
    expect(await alarmAt(h.stub)).toBe(T)
    expect(await rows(h.stub)).toEqual([{ id: 's', kind: 'a', due_at_ms: T, attempts: 0, state: 'ready' }])
  })
  it('a retry at now runs once; the alarm is left at now', async () => {
    let calls = 0
    const h = await harness({ handlers: { a: async (_t, ctx) => { calls++; return { retryAtMs: ctx.nowMs, error: 'again' } } } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'r', kind: 'a', dueAtMs: T - 5 }); await h.sched.settled() })
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(calls).toBe(1)
    expect(await alarmAt(h.stub)).toBe(T)
    expect(await rows(h.stub)).toEqual([{ id: 'r', kind: 'a', due_at_ms: T, attempts: 1, state: 'ready' }])
  })
})

describe('bounds and backoff (failures 1, 5)', () => {
  it('a pass stops once 10 s have gone by', async () => {
    let h!: Harness<{ nowMs: number }>
    const seen: string[] = []
    h = await harness({ handlers: { a: async t => { seen.push(t.id); h.clock.now += 6_000; return { done: true } } } })
    await inObject(h.stub, async () => {
      for (const id of ['p1', 'p2', 'p3']) h.sched.schedule({ id, kind: 'a', dueAtMs: T })
      await h.sched.settled()
    })
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    // p1 at 0 s, p2 at 6 s; at 12 s the pass is over its 10 s.
    expect(seen).toEqual(['p1', 'p2'])
    expect(await alarmAt(h.stub)).toBe(T)
  })
  it('backs off 30 s doubling, at most an hour', () => {
    expect([0, 1, 6, 7, 9, 30].map(backoffMs)).toEqual([30_000, 60_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000])
  })
  it('a throw retries after the backoff of the attempts before it', async () => {
    const h = await harness({ handlers: { a: async () => { throw new Error('no') } } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'b', kind: 'a', dueAtMs: T }); await h.sched.settled() })
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(await rows(h.stub)).toEqual([{ id: 'b', kind: 'a', due_at_ms: T + 30_000, attempts: 1, state: 'ready' }])
    h.clock.now = T + 30_000
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(await rows(h.stub)).toEqual([{ id: 'b', kind: 'a', due_at_ms: T + 90_000, attempts: 2, state: 'ready' }])
  })
  it('a result of another shape counts as a retry', async () => {
    const h = await harness({ handlers: { a: async () => ({ retryAtMs: 'soon' }) as unknown as TaskResult } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'x', kind: 'a', dueAtMs: T }); await h.sched.settled() })
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(await rows(h.stub)).toEqual([{ id: 'x', kind: 'a', due_at_ms: T + 30_000, attempts: 1, state: 'ready' }])
  })
})

describe('a failed alarm write (failure 4)', () => {
  /** The real alarm, except that `set` fails the first `failures` times. */
  const flaky = (state: DurableObjectState, failures: number, sets: number[]): AlarmPort => {
    const real = alarmPort(state.storage)
    return { ...real, set: async at => { sets.push(at); if (failures-- > 0) throw new Error('storage down'); await real.set(at) } }
  }
  it('settled() rethrows it once, then clears', async () => {
    await runInDurableObject(await emptyStub(), async (_i, state) => {
      const sched = createScheduler({ sql: state.storage.sql, alarm: flaky(state, 1, []), now: () => T, handlers: {}, context: n => ({ nowMs: n }) })
      sched.schedule({ id: 'f', kind: 'a', dueAtMs: T + 1 })
      await expect(sched.settled()).rejects.toThrow('storage down')
      await expect(sched.settled()).resolves.toBeUndefined()
    })
  })
  it('a pass whose alarm write fails leaves a fallback alarm 30 s on', async () => {
    const stub = await emptyStub()
    const sets: number[] = []
    await runInDurableObject(stub, async (instance, state) => {
      const sched = createScheduler({ sql: state.storage.sql, alarm: alarmPort(state.storage), now: () => T, handlers: { a: async () => ({ done: true }) }, context: n => ({ nowMs: n }) })
      sched.schedule({ id: 'k', kind: 'a', dueAtMs: T + 500 })
      sched.schedule({ id: 'd', kind: 'a', dueAtMs: T })
      await sched.settled()
      const failing = createScheduler({ sql: state.storage.sql, alarm: flaky(state, 1, sets), now: () => T, handlers: { a: async () => ({ done: true }) }, context: n => ({ nowMs: n }) })
      ;(instance as unknown as { alarm: () => Promise<void> }).alarm = () => failing.alarm()
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(sets).toEqual([T + 500, T + 30_000])
    expect(await alarmAt(stub)).toBe(T + 30_000)
  })
})

describe('ensure and schedule (failure 3)', () => {
  it('ensure never moves an existing task; schedule does', async () => {
    const h = await harness({ handlers: {} })
    await inObject(h.stub, async () => {
      h.sched.ensure({ id: 'e', kind: 'a', dueAtMs: T + 50 })
      h.sched.ensure({ id: 'e', kind: 'b', dueAtMs: T + 10 })
      await h.sched.settled()
    })
    expect(await rows(h.stub)).toEqual([{ id: 'e', kind: 'a', due_at_ms: T + 50, attempts: 0, state: 'ready' }])
    expect(await alarmAt(h.stub)).toBe(T + 50)
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'e', kind: 'b', dueAtMs: T + 10 }); await h.sched.settled() })
    expect(await rows(h.stub)).toEqual([{ id: 'e', kind: 'b', due_at_ms: T + 10, attempts: 0, state: 'ready' }])
    expect(await alarmAt(h.stub)).toBe(T + 10)
  })
})

describe('ensure (failure 3)', () => {
  it('during its own handler changes nothing: a done answer still deletes the task', async () => {
    let h!: Harness<{ nowMs: number }>
    h = await harness({ handlers: { a: async (task, ctx) => { h.sched.ensure({ id: task.id, kind: 'a', dueAtMs: ctx.nowMs + 1_000 }); await null; return { done: true } } } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'e1', kind: 'a', dueAtMs: T }); await h.sched.settled() })
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(await rows(h.stub)).toEqual([])
    expect(await alarmAt(h.stub)).toBeNull()
  })
  it('revives a quarantined task of the same kind, and only that kind', async () => {
    const h = await harness({ handlers: {} })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'seed', kind: 'usage-sweep', dueAtMs: T }); await h.sched.settled() })
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(await rows(h.stub)).toEqual([{ id: 'seed', kind: 'usage-sweep', due_at_ms: T, attempts: 0, state: 'quarantined' }])
    await inObject(h.stub, async () => { h.sched.ensure({ id: 'seed', kind: 'other', dueAtMs: T + 9 }); await h.sched.settled() })
    expect(await rows(h.stub)).toEqual([{ id: 'seed', kind: 'usage-sweep', due_at_ms: T, attempts: 0, state: 'quarantined' }])
    await inObject(h.stub, async () => { h.sched.ensure({ id: 'seed', kind: 'usage-sweep', dueAtMs: T + 9 }); await h.sched.settled() })
    expect(await rows(h.stub)).toEqual([{ id: 'seed', kind: 'usage-sweep', due_at_ms: T + 9, attempts: 0, state: 'ready' }])
    expect(await alarmAt(h.stub)).toBe(T + 9)
  })
})

describe('a pass that keeps failing (failure 4)', () => {
  it('moves the alarm forward by the fallback delay each time, never to a past time', async () => {
    let calls = 0
    const h = await harness({ handlers: { a: async () => { calls++; return { done: true } } }, afterHandler: () => { throw new Error('crashed') } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'p', kind: 'a', dueAtMs: T - 1_000 }); await h.sched.settled() })
    for (let i = 1; i <= 3; i++) {
      expect(await runDurableObjectAlarm(h.stub)).toBe(true)
      expect(await alarmAt(h.stub), `pass ${i}`).toBe(h.clock.now + 30_000)
      h.clock.now += 30_000
    }
    expect(calls).toBe(3)
  })
})

describe('a failed commit (failure 4)', () => {
  /** A trigger that makes every delete from due_tasks fail, as a storage error would. */
  const block = (sql: SqlStorage) => sql.exec("CREATE TRIGGER block_delete BEFORE DELETE ON due_tasks BEGIN SELECT RAISE(ABORT, 'blocked'); END")
  it('arms no sooner than the fallback delay, and the next pass starts clean', async () => {
    let h!: Harness<{ nowMs: number }>
    h = await harness({ handlers: { a: async () => ({ done: true }) } })
    await inObject(h.stub, async s => {
      block(s.storage.sql)
      h.sched.schedule({ id: 'c', kind: 'a', dueAtMs: T })
      h.sched.schedule({ id: 'later', kind: 'a', dueAtMs: T + 30_005 })
      await h.sched.settled()
    })
    // The delete fails: the task stays due at T, but the alarm waits 30 s.
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(await rows(h.stub)).toEqual([
      { id: 'c', kind: 'a', due_at_ms: T, attempts: 0, state: 'ready' },
      { id: 'later', kind: 'a', due_at_ms: T + 30_005, attempts: 0, state: 'ready' },
    ])
    expect(await alarmAt(h.stub)).toBe(T + 30_000)
    // Storage is back: this pass succeeds, so the alarm is the earliest task again, not another fallback.
    await inObject(h.stub, s => s.storage.sql.exec('DROP TRIGGER block_delete'))
    h.clock.now = T + 30_000
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(await rows(h.stub)).toEqual([{ id: 'later', kind: 'a', due_at_ms: T + 30_005, attempts: 0, state: 'ready' }])
    expect(await alarmAt(h.stub)).toBe(T + 30_005)
  })
})

describe('ensure and quarantine (failure 3)', () => {
  it('never revives a task quarantined after 10 failures', async () => {
    const h = await harness({ handlers: { a: async (_t, ctx) => ({ retryAtMs: ctx.nowMs, error: 'poison' }) } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'poison', kind: 'a', dueAtMs: T }); await h.sched.settled() })
    for (let i = 0; i < 10; i++) { expect(await runDurableObjectAlarm(h.stub)).toBe(true); h.clock.now += 1 }
    const quarantined = [{ id: 'poison', kind: 'a', due_at_ms: h.clock.now - 1, attempts: 10, state: 'quarantined' }]
    expect(await rows(h.stub)).toEqual(quarantined)
    await inObject(h.stub, async () => { h.sched.ensure({ id: 'poison', kind: 'a', dueAtMs: T + 99 }); await h.sched.settled() })
    expect(await rows(h.stub)).toEqual(quarantined)
    expect(await inObject(h.stub, () => h.sched.quarantinedCount())).toBe(1)
    expect(await alarmAt(h.stub)).toBeNull()
  })
  it('never revives a task whose own error text reads like an unknown kind', async () => {
    const h = await harness({ handlers: { a: async (_t, ctx) => ({ retryAtMs: ctx.nowMs, error: 'Unknown kind of file' }) } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'text', kind: 'a', dueAtMs: T }); await h.sched.settled() })
    for (let i = 0; i < 10; i++) { expect(await runDurableObjectAlarm(h.stub)).toBe(true); h.clock.now += 1 }
    await inObject(h.stub, async () => { h.sched.ensure({ id: 'text', kind: 'a', dueAtMs: T + 99 }); await h.sched.settled() })
    expect(await rows(h.stub)).toEqual([{ id: 'text', kind: 'a', due_at_ms: h.clock.now - 1, attempts: 10, state: 'quarantined' }])
  })
  it('revives an unknown-kind task with its attempts reset', async () => {
    const h = await harness({ handlers: { a: async (_t, ctx) => ({ retryAtMs: ctx.nowMs, error: 'not yet' }) } })
    await inObject(h.stub, async () => { h.sched.schedule({ id: 'late', kind: 'a', dueAtMs: T }); await h.sched.settled() })
    for (let i = 0; i < 3; i++) { expect(await runDurableObjectAlarm(h.stub)).toBe(true); h.clock.now += 1 }
    // A start without the handler (it isn't built yet): the task is quarantined as an unknown kind, attempts kept.
    await h.restart({ handlers: {} })
    expect(await runDurableObjectAlarm(h.stub)).toBe(true)
    expect(await rows(h.stub)).toEqual([{ id: 'late', kind: 'a', due_at_ms: h.clock.now - 1, attempts: 3, state: 'quarantined' }])
    const again = await h.restart({ handlers: { a: async () => ({ done: true }) } })
    await inObject(h.stub, async () => { again.ensure({ id: 'late', kind: 'a', dueAtMs: T + 50 }); await again.settled() })
    expect(await rows(h.stub)).toEqual([{ id: 'late', kind: 'a', due_at_ms: T + 50, attempts: 0, state: 'ready' }])
  })
})

describe('one owner of the alarm (failure 7)', () => {
  const sources = {
    ...import.meta.glob<string>(['./**/*.ts', '!./**/*.test.ts'], { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob<string>(['../../audit-copy.ts', '../../usage/sweep.ts', '../runner/pool-retry.ts'], { query: '?raw', import: 'default', eager: true }),
  }
  it('only scheduler.ts sets or deletes it', () => {
    expect(Object.keys(sources)).toContain('./tasks/index.ts')
    expect(Object.keys(sources)).toContain('../runner/pool-retry.ts')
    const owners = Object.entries(sources).filter(([, text]) => /\b(setAlarm|deleteAlarm)\b/.test(text)).map(([f]) => f)
    expect(owners).toEqual(['./scheduler.ts'])
  })
})
