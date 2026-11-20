// The runner pool (pool.ts) on the BrandAgent's real SQLite, with W1's `turns`, `runs` and `flags` tables created here
// in the shape of p3-design 4.1 (W1 creates them in the object) and the Runner objects behind a fake. Routing is checked
// against a reference model written in this file with literal constants (25 per runner, 60 s queue, 5 s retry, 5 s
// refusal cool-down); it shares no code with pool.ts. Ways it can fail, written down first:
//  1. a placement goes to the wrong runner (not fill-first by index, a sleeping one woken before an up one has room,
//     a refused or protocol runner picked);
//  2. more than 25 unfinished turns derived on one runner, including two placements racing for the 25th slot;
//  3. an ambiguous admission is followed by a placement of that turn on any runner;
//  4. the queue isn't FIFO, a newcomer overtakes it, a 409 is placed elsewhere, a turn waits past 60 s, or a freed
//     slot / the 5 s retry doesn't hand the head back;
//  5. a container exit fences the turns twice, or the wrong turns;
//  6. drain: an admission after the drain step, counts that don't reach 0, an expiry that doesn't clear or advance runs;
//     warm-up clearing the drain with a failed /health, or not starting a run's queued follow-up;
//  7. the signals miss a protocol runner, a restart storm or a shortfall.
import { fc } from '@fast-check/vitest'
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { RunStart } from '../../../shared/protocol/index.ts'
import type { Scheduler } from '../brand-agent/scheduler.ts'
import type { PlacementHooks } from '../brand-agent/ports.ts'
import { RunnerPool, type RunnerRpc } from './pool.ts'
import type { AdmitResult, WarmResult } from './runner.ts'

const T0 = 4_102_444_800_000
const RS: RunStart = {
  runId: 't_0',
  chatId: 'chat-1',
  sessionId: '0b9a3f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  resume: false,
  prompt: 'hello',
  model: 'claude-sonnet-5-5',
  sideModel: 'claude-haiku-5-5',
  systemPrompt: '',
  attachments: [],
  expect: null,
  effort: 'medium',
  maxTurns: 25,
  maxBudgetUsd: 10,
  runToken: 'tok_not_a_real_token_0123456789',
  webFetchDomains: [],
  fileCaps: { maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 1, allowedTypes: ['text/plain'] },
}
const rs = (turnId: string): RunStart => ({ ...RS, runId: turnId })

/** W1's tables, as p3-design 4.1 names the columns the pool reads. */
function w1Tables(sql: SqlStorage) {
  sql.exec('CREATE TABLE turns (turn_id TEXT PRIMARY KEY, run_id TEXT, state TEXT NOT NULL, gen INTEGER NOT NULL DEFAULT 1, runner TEXT)')
  sql.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('live', 'ended')))")
  sql.exec('CREATE TABLE flags (key TEXT PRIMARY KEY, value)')
}

class FakeScheduler implements Scheduler {
  tasks = new Map<string, { kind: string; dueAtMs: number; payload?: unknown }>()
  schedule(t: { id: string; kind: string; dueAtMs: number; payload?: unknown }) { this.tasks.set(t.id, { kind: t.kind, dueAtMs: t.dueAtMs, payload: t.payload }) }
  ensure(t: { id: string; kind: string; dueAtMs: number; payload?: unknown }) { if (!this.tasks.has(t.id)) this.schedule(t) }
  cancel(id: string) { this.tasks.delete(id) }
}

let objects = 0
const inObject = <R>(fn: (sql: SqlStorage) => Promise<R>) =>
  runInDurableObject(env.BRAND_AGENT.getByName(`pool-test-${++objects}`), (_i, s) => fn(s.storage.sql))

// ---------------------------------------------------------------------------------------------------------------
// Routing: random histories against the reference model.

type Mode = 'ok' | 'exhausted' | 'chat_live' | 'parked' | 'ambiguous' | 'down' | 'protocol'
type Op =
  | { k: 'start' }
  | { k: 'end'; i: number }
  | { k: 'mode'; r: number; mode: Mode }
  | { k: 'exit'; r: number }
  | { k: 'tick'; ms: number }

const N = 2
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 12, arbitrary: fc.constant<Op>({ k: 'start' }) },
  { weight: 4, arbitrary: fc.nat(1000).map<Op>(i => ({ k: 'end', i })) },
  { weight: 2, arbitrary: fc.record({ r: fc.nat(N - 1), mode: fc.constantFrom<Mode>('ok', 'ok', 'ok', 'exhausted', 'chat_live', 'parked', 'ambiguous', 'down', 'protocol') }).map<Op>(x => ({ k: 'mode', ...x })) },
  { weight: 1, arbitrary: fc.nat(N - 1).map<Op>(r => ({ k: 'exit', r })) },
  { weight: 3, arbitrary: fc.constantFrom(1_000, 5_000, 30_000, 61_000).map<Op>(ms => ({ k: 'tick', ms })) },
)

/** The reference: the pool's routing rules and W1's side of the hooks, as plain data. */
class Reference {
  now = T0
  log: string[] = []
  runners = Array.from({ length: N }, () => ({ state: 'sleeping' as string, until: 0, mode: 'ok' as Mode, started: false }))
  turns = new Map<string, { state: 'starting' | 'live' | 'ended'; runner: number | null; ambiguous: boolean }>()
  queue: { id: string; at: number }[] = []
  retryDue: number | null = null
  n = 0

  count(r: number) {
    let c = 0
    for (const t of this.turns.values()) if (t.runner === r && t.state !== 'ended') c++
    return c
  }
  pick(tried: Set<number>): number | null {
    const free = (i: number) => !tried.has(i) && this.count(i) < 25 && this.runners[i].until <= this.now
    for (let i = 0; i < N; i++) if (['up', 'starting', 'refused'].includes(this.runners[i].state) && free(i)) return i
    for (let i = 0; i < N; i++) if (this.runners[i].state === 'sleeping' && free(i)) return i
    return null
  }
  enqueue(id: string) {
    if (!this.queue.some(q => q.id === id)) this.queue.push({ id, at: this.now })
    if (this.retryDue === null) this.retryDue = this.now + 5_000
  }
  dequeue(id: string) { this.queue = this.queue.filter(q => q.id !== id) }

  place(id: string) {
    const turn = this.turns.get(id)!
    let result: string
    if (this.queue.length > 0 && this.queue[0].id !== id) {
      this.enqueue(id)
      result = 'queued'
    } else {
      const tried = new Set<number>()
      for (;;) {
        const r = this.pick(tried)
        if (r === null) { this.enqueue(id); result = 'queued'; break }
        tried.add(r)
        const rr = this.runners[r]
        turn.runner = r
        if (rr.state === 'sleeping') rr.state = 'starting'
        this.log.push(`admit ${id} runner-${r}`)
        if (rr.mode !== 'down') rr.started = true
        if (rr.mode === 'ok') { rr.state = 'up'; rr.until = 0; this.dequeue(id); result = `admitted runner-${r}`; break }
        if (rr.mode === 'ambiguous') { this.dequeue(id); result = `ambiguous runner-${r}`; break }
        turn.runner = null
        if (rr.mode === 'down') { rr.state = 'sleeping'; rr.until = this.now + 5_000; continue }
        if (rr.mode === 'protocol') { rr.state = 'protocol'; continue }
        if (rr.mode === 'exhausted') { rr.state = 'refused'; rr.until = this.now + 5_000; continue }
        rr.state = 'up'
        if (rr.mode === 'parked') { this.dequeue(id); result = 'files'; break }
        this.enqueue(id) // chat_live
        result = 'queued'
        break
      }
    }
    this.log.push(`place ${id} ${result}`)
    if (result.startsWith('admitted')) turn.state = 'live'
    else if (result.startsWith('ambiguous')) turn.ambiguous = true
    else if (result === 'files') turn.state = 'ended'
  }

  retry() {
    while (this.queue.length > 0 && this.queue[0].at + 60_000 <= this.now) {
      const h = this.queue.shift()!
      this.log.push(`expire ${h.id}`)
      this.turns.get(h.id)!.state = 'ended'
    }
    while (this.queue.length > 0) {
      if (this.pick(new Set()) === null) break
      const head = this.queue[0].id
      this.place(head)
      if (this.queue[0]?.id === head) break
    }
    if (this.queue.length > 0) this.retryDue = Math.max(this.now, Math.min(this.now + 5_000, this.queue[0].at + 60_000))
  }

  ended(id: string) {
    this.turns.get(id)!.state = 'ended'
    this.dequeue(id)
    if (this.queue.length > 0) this.retryDue = this.now
  }

  apply(op: Op) {
    if (op.k === 'start') {
      const id = `t_${this.n++}`
      this.turns.set(id, { state: 'starting', runner: null, ambiguous: false })
      this.place(id)
    } else if (op.k === 'end') {
      const placed = [...this.turns].filter(([, t]) => t.runner !== null && t.state !== 'ended').map(([id]) => id).sort()
      if (placed.length > 0) this.ended(placed[op.i % placed.length])
    } else if (op.k === 'mode') {
      this.runners[op.r].mode = op.mode
    } else if (op.k === 'exit') {
      const rr = this.runners[op.r]
      if (rr.started) {
        rr.started = false
        rr.state = 'sleeping'
        const fenced = [...this.turns].filter(([, t]) => t.runner === op.r && t.state !== 'ended').map(([id]) => id).sort()
        this.log.push(`fence runner-${op.r} ${fenced.join(',')}`)
        for (const id of fenced) this.ended(id)
      }
    } else {
      this.now += op.ms
    }
    if (this.retryDue !== null && this.retryDue <= this.now) {
      this.retryDue = null
      this.retry()
    }
  }
}

/** The real pool, a fake Runner per name, and W1's side of the hooks. */
async function runReal(sql: SqlStorage, ops: Op[]) {
  w1Tables(sql)
  const clock = { now: T0 }
  const sched = new FakeScheduler()
  const log: string[] = []
  const violations: string[] = []
  const ambiguous = new Set<string>()
  const runners = Array.from({ length: N }, () => ({ mode: 'ok' as Mode, gen: 1, started: false }))
  let n = 0

  const placeAndApply = async (id: string) => {
    const a = await pool.place(rs(id), 1)
    const result = 'admitted' in a ? `admitted ${a.admitted}` : 'ambiguous' in a ? `ambiguous ${a.ambiguous}` : 'queued' in a ? 'queued' : a.refused
    log.push(`place ${id} ${result}`)
    if ('admitted' in a) sql.exec("UPDATE turns SET state = 'live' WHERE turn_id = ?", id)
    else if ('ambiguous' in a) ambiguous.add(id)
    else if ('refused' in a) sql.exec("UPDATE turns SET state = 'ended' WHERE turn_id = ?", id)
  }
  const hooks: PlacementHooks = {
    retryPlacement: async id => {
      const row = sql.exec<{ state: string }>('SELECT state FROM turns WHERE turn_id = ?', id).one()
      if (row.state === 'starting' && !ambiguous.has(id)) await placeAndApply(id)
    },
    placementExpired: async id => {
      log.push(`expire ${id}`)
      sql.exec("UPDATE turns SET state = 'ended' WHERE turn_id = ?", id)
    },
  }
  const fake = (i: number): RunnerRpc => ({
    admit: async (start): Promise<AdmitResult> => {
      const r = runners[i]
      log.push(`admit ${start.runId} runner-${i}`)
      if (ambiguous.has(start.runId)) violations.push(`${start.runId} placed again after an ambiguous answer`)
      if (r.mode !== 'down') r.started = true
      switch (r.mode) {
        case 'ok': return { accepted: true, gen: r.gen, protocol: 2 }
        case 'ambiguous': return { ambiguous: true, gen: r.gen }
        case 'down': return { placementError: 'no /protocol answer' }
        case 'protocol': return { protocol: 'none', gen: r.gen }
        case 'exhausted': return { refused: 'session_pool_exhausted', gen: r.gen }
        case 'parked': return { refused: 'session_folder_parked', gen: r.gen }
        case 'chat_live': return { refused: 'chat_live', gen: r.gen }
      }
    },
    status: async () => ({ state: 'live', containerGone: false }),
    interrupt: async () => {},
    stop: async () => {},
    warm: async () => ({ ok: true, gen: runners[i].gen, protocol: 2 }),
  })
  const pool = new RunnerPool({ sql, scheduler: sched, now: () => clock.now, size: N, runner: name => fake(Number(name.slice(7))), hooks })

  const ended = (id: string) => {
    const t = sql.exec<{ runner: string | null }>("UPDATE turns SET state = 'ended' WHERE turn_id = ? RETURNING runner", id).one()
    pool.turnEnded(t.runner ?? '', id)
  }
  for (const op of ops) {
    if (op.k === 'start') {
      const id = `t_${n++}`
      sql.exec("INSERT INTO turns (turn_id, run_id, state, gen) VALUES (?, ?, 'starting', 1)", id, `r_${id}`)
      await placeAndApply(id)
    } else if (op.k === 'end') {
      const placed = sql.exec<{ turn_id: string }>("SELECT turn_id FROM turns WHERE runner IS NOT NULL AND state != 'ended'").toArray().map(r => r.turn_id).sort()
      if (placed.length > 0) ended(placed[op.i % placed.length])
    } else if (op.k === 'mode') {
      runners[op.r].mode = op.mode
    } else if (op.k === 'exit') {
      const r = runners[op.r]
      if (r.started) {
        r.started = false
        const fenced = pool.containerExited(`runner-${op.r}`, r.gen)
        r.gen++
        log.push(`fence runner-${op.r} ${(fenced ?? ['DUPLICATE']).slice().sort().join(',')}`)
        for (const id of fenced ?? []) ended(id)
        // The same generation reported again (a second monitor): nothing more.
        if (pool.containerExited(`runner-${op.r}`, r.gen - 1) !== null) violations.push('an exit taken twice')
      }
    } else {
      clock.now += op.ms
    }
    const due = sched.tasks.get('pool-retry')
    if (due !== undefined && due.dueAtMs <= clock.now) {
      sched.tasks.delete('pool-retry')
      await pool.retryQueue()
    }
    for (const { runner, c } of sql.exec<{ runner: string; c: number }>("SELECT runner, COUNT(*) AS c FROM turns WHERE runner IS NOT NULL AND state IN ('starting','live','ending') GROUP BY runner").toArray()) {
      if (c > 25) violations.push(`${runner} has ${c} unfinished turns`)
    }
  }
  return { log, violations }
}

describe('routing', () => {
  it('placements equal the reference model; never over 25 per runner; an ambiguous turn is never placed again', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 100, maxLength: 300, size: 'max' }), async ops => {
        const ref = new Reference()
        for (const op of ops) ref.apply(op)
        const real = await inObject(sql => runReal(sql, ops))
        expect(real.violations).toEqual([])
        expect(real.log).toEqual(ref.log)
      }),
      { numRuns: 60 },
    )
  })

  it('two placements racing for the 25th slot: the second goes to the next runner (barrier on the first admission)', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      for (let i = 0; i < 24; i++) sql.exec("INSERT INTO turns (turn_id, state, gen, runner) VALUES (?, 'live', 1, 'runner-0')", `t_live${i}`)
      sql.exec("INSERT INTO turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1), ('t_b', 'starting', 1)")
      let open!: () => void
      const barrier = new Promise<void>(r => (open = r))
      const admits: string[] = []
      const runner = (name: string): RunnerRpc => ({
        admit: async start => {
          admits.push(`${start.runId}@${name}`)
          if (start.runId === 't_a') await barrier
          return { accepted: true, gen: 1, protocol: 2 }
        },
        status: async () => ({ state: 'live', containerGone: false }),
        interrupt: async () => {}, stop: async () => {}, warm: async () => ({ ok: true, gen: 1, protocol: 2 }),
      })
      const pool = new RunnerPool({ sql, scheduler: new FakeScheduler(), now: () => T0, size: 2, runner, hooks: { retryPlacement: async () => {}, placementExpired: async () => {} } })
      sql.exec("UPDATE pool_runners SET state = 'up' WHERE runner = 'runner-0'")
      const a = pool.place(rs('t_a'), 1)
      const b = await pool.place(rs('t_b'), 1)
      open()
      expect(await a).toEqual({ admitted: 'runner-0' })
      expect(b).toEqual({ admitted: 'runner-1' })
      expect(admits).toEqual(['t_a@runner-0', 't_b@runner-1'])
    })
  })

  it('a container exit while its start is being admitted: the turn in flight is not fenced, and moves on (barrier)', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      sql.exec("INSERT INTO turns (turn_id, state, gen, runner) VALUES ('t_old', 'live', 1, 'runner-0')")
      let open!: () => void
      const barrier = new Promise<void>(r => (open = r))
      const runner = (name: string): RunnerRpc => ({
        admit: async () => {
          if (name === 'runner-1') return { accepted: true, gen: 1, protocol: 2 }
          await barrier
          return { placementError: 'the container stopped before it answered /protocol' }
        },
        status: async () => ({ state: 'live', containerGone: false }),
        interrupt: async () => {}, stop: async () => {}, warm: async () => ({ ok: true, gen: 1, protocol: 2 }),
      })
      const pool = new RunnerPool({ sql, scheduler: new FakeScheduler(), now: () => T0, size: 2, runner, hooks: { retryPlacement: async () => {}, placementExpired: async () => {} } })
      sql.exec("UPDATE pool_runners SET state = 'up' WHERE runner = 'runner-0'")
      const placing = pool.place(rs('t_a'), 1)
      expect(pool.containerExited('runner-0', 1)).toEqual(['t_old'])
      open()
      expect(await placing).toEqual({ admitted: 'runner-1' })
      expect(sql.exec("SELECT runner FROM turns WHERE turn_id = 't_a'").one().runner).toBe('runner-1')
    })
  })

  it('a stale attempt (the turn moved on to another gen) leaves no runner on the row after a refusal', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO turns (turn_id, state, gen) VALUES ('t_a', 'starting', 2)")
      const runner = (): RunnerRpc => ({
        admit: async () => ({ refused: 'session_folder_parked', gen: 1 }),
        status: async () => ({ state: 'live', containerGone: false }),
        interrupt: async () => {}, stop: async () => {}, warm: async () => ({ ok: true, gen: 1, protocol: 2 }),
      })
      const pool = new RunnerPool({ sql, scheduler: new FakeScheduler(), now: () => T0, size: 2, runner, hooks: { retryPlacement: async () => {}, placementExpired: async () => {} } })
      expect(await pool.place(rs('t_a'), 1)).toEqual({ refused: 'files' })
      expect(sql.exec('SELECT runner FROM turns').one().runner).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Drain and warm-up.

interface DrainRig {
  sql: SqlStorage
  pool: RunnerPool
  sched: FakeScheduler
  clock: { now: number }
  admit: (start: RunStart) => Promise<AdmitResult>
  warm: (name: string) => Promise<WarmResult>
  retried: string[]
}
function drainRig(sql: SqlStorage): DrainRig {
  w1Tables(sql)
  const rig: DrainRig = {
    sql,
    sched: new FakeScheduler(),
    clock: { now: T0 },
    admit: async () => ({ accepted: true, gen: 1, protocol: 2 }),
    warm: async () => ({ ok: true, gen: 2, protocol: 2 }),
    retried: [],
  } as unknown as DrainRig
  rig.pool = new RunnerPool({
    sql,
    scheduler: rig.sched,
    now: () => rig.clock.now,
    size: 3,
    runner: name => ({
      admit: start => rig.admit(start),
      status: async () => ({ state: 'live', containerGone: false }),
      interrupt: async () => {}, stop: async () => {},
      warm: () => rig.warm(name),
    }),
    hooks: { retryPlacement: async id => void rig.retried.push(id), placementExpired: async () => {} },
  })
  return rig
}

describe('drain', () => {
  it('a placement racing the drain call: refused at the next step, never sent to another runner', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      sql.exec("INSERT INTO turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      let open!: () => void
      const barrier = new Promise<void>(r => (open = r))
      const admits: string[] = []
      rig.admit = async start => {
        admits.push(start.runId)
        await barrier
        return { refused: 'session_pool_exhausted', gen: 1 }
      }
      const placing = rig.pool.place(rs('t_a'), 1)
      rig.pool.drain(rig.clock.now)
      open()
      expect(await placing).toEqual({ refused: 'draining' })
      expect(admits).toEqual(['t_a'])
      // And a placement after the drain step sends nothing.
      sql.exec("INSERT INTO turns (turn_id, state, gen) VALUES ('t_b', 'starting', 1)")
      expect(await rig.pool.place(rs('t_b'), 1)).toEqual({ refused: 'draining' })
      expect(admits).toEqual(['t_a'])
    })
  })

  it('reports live, starting, ending and queued, which reach 0 as turns end', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      sql.exec(`INSERT INTO turns (turn_id, state, gen, runner) VALUES
        ('t_1', 'live', 1, 'runner-0'), ('t_2', 'live', 1, 'runner-1'), ('t_3', 'starting', 1, 'runner-0'),
        ('t_4', 'ending', 1, 'runner-0'), ('t_5', 'queued', 1, NULL), ('t_6', 'ended', 1, 'runner-0')`)
      expect(rig.pool.drain(rig.clock.now)).toEqual({ live: 2, starting: 1, ending: 1, queued: 1, drainingUntilMs: T0 + 1_800_000 })
      for (const id of ['t_1', 't_2', 't_3', 't_4']) {
        sql.exec("UPDATE turns SET state = 'ended' WHERE turn_id = ?", id)
        rig.pool.turnEnded('runner-0', id)
      }
      expect(rig.pool.drainState()).toEqual({ live: 0, starting: 0, ending: 0, queued: 1, drainingUntilMs: T0 + 1_800_000 })
    })
  })

  it('expires after 30 minutes: cleared, and every live run advances at the expiry', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      sql.exec("INSERT INTO runs (run_id, state) VALUES ('r_1', 'live'), ('r_2', 'live'), ('r_3', 'ended')")
      rig.pool.drain(rig.clock.now)
      expect([...rig.sched.tasks].filter(([id]) => id.startsWith('run-advance:'))).toEqual([
        ['run-advance:r_1', { kind: 'run-advance', dueAtMs: T0 + 1_800_000, payload: { runId: 'r_1' } }],
        ['run-advance:r_2', { kind: 'run-advance', dueAtMs: T0 + 1_800_000, payload: { runId: 'r_2' } }],
      ])
      rig.clock.now = T0 + 1_800_000 - 1
      sql.exec("INSERT INTO turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      expect(await rig.pool.place(rs('t_a'), 1)).toEqual({ refused: 'draining' })
      rig.clock.now = T0 + 1_800_000
      expect(rig.pool.drainState().drainingUntilMs).toBeNull()
      expect(sql.exec("SELECT COUNT(*) AS n FROM flags WHERE key LIKE 'draining%'").one().n).toBe(0)
      expect(await rig.pool.place(rs('t_a'), 1)).toEqual({ admitted: 'runner-0' })
    })
  })

  it('hands the placement queue back to W1 (place answers draining, W1 requeues in the run)', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      sql.exec("INSERT INTO turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      rig.admit = async () => ({ refused: 'chat_live', gen: 1 })
      expect(await rig.pool.place(rs('t_a'), 1)).toEqual({ queued: true })
      rig.pool.drain(rig.clock.now)
      expect(rig.sched.tasks.get('pool-retry')?.dueAtMs).toBe(T0)
      await rig.pool.retryQueue()
      expect(rig.retried).toEqual(['t_a'])
    })
  })
})

describe('warm-up', () => {
  it('refuses to clear the drain when /health fails on a runner', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      rig.pool.drain(rig.clock.now)
      const warmed: string[] = []
      rig.warm = async name => {
        warmed.push(name)
        return name === 'runner-1' ? { ok: false, why: 'health', detail: 'health answered 503' } : { ok: true, gen: 2, protocol: 2 }
      }
      expect(await rig.pool.warmup()).toEqual({ refused: { code: 'unavailable' } })
      expect(warmed.sort()).toEqual(['runner-0', 'runner-1'])
      expect(rig.pool.drainState().drainingUntilMs).toBe(T0 + 1_800_000)
    })
  })

  it("a drain asked again while the warm-up runs isn't cleared by it", async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      rig.pool.drain(rig.clock.now)
      let open!: () => void
      const barrier = new Promise<void>(r => (open = r))
      rig.warm = async () => {
        await barrier
        return { ok: true, gen: 2, protocol: 2 }
      }
      const warming = rig.pool.warmup()
      rig.clock.now = T0 + 1_000
      rig.pool.drain(rig.clock.now)
      open()
      expect(await warming).toEqual({ refused: { code: 'unavailable', reason: 'draining' } })
      expect(rig.pool.drainState().drainingUntilMs).toBe(T0 + 1_000 + 1_800_000)
    })
  })

  it('clears the drain, starts the placement queue and advances every live run, so a queued follow-up starts', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      // r_1's live turn ended during the drain; its follow-up waits in the run (W1's queue), not in pool_queue.
      sql.exec("INSERT INTO runs (run_id, state) VALUES ('r_1', 'live')")
      sql.exec("INSERT INTO turns (turn_id, run_id, state, gen) VALUES ('t_1', 'r_1', 'ended', 1), ('t_2', 'r_1', 'queued', 1)")
      rig.pool.drain(rig.clock.now)
      rig.clock.now = T0 + 60_000
      expect(await rig.pool.warmup()).toEqual({ ok: true })
      expect(rig.pool.drainState().drainingUntilMs).toBeNull()
      expect(rig.sched.tasks.get('run-advance:r_1')).toEqual({ kind: 'run-advance', dueAtMs: T0 + 60_000, payload: { runId: 'r_1' } })
      // Only runners 0 and 1 of 3 are warmed; their state is up with the new generation.
      expect(sql.exec('SELECT runner, state, container_gen FROM pool_runners ORDER BY runner').toArray()).toEqual([
        { runner: 'runner-0', state: 'up', container_gen: 2 },
        { runner: 'runner-1', state: 'up', container_gen: 2 },
        { runner: 'runner-2', state: 'sleeping', container_gen: null },
      ])
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Signals.

describe('signals', () => {
  it('pool_protocol: a runner with no shared version is red and never picked', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      const admits: string[] = []
      rig.admit = async start => {
        admits.push(start.runId)
        return admits.length === 1 ? { protocol: 'none', gen: 1 } : { accepted: true, gen: 1, protocol: 2 }
      }
      sql.exec("INSERT INTO turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1), ('t_b', 'starting', 1)")
      expect(await rig.pool.place(rs('t_a'), 1)).toEqual({ admitted: 'runner-1' })
      expect(await rig.pool.place(rs('t_b'), 1)).toEqual({ admitted: 'runner-1' })
      expect(rig.pool.health().protocol.ok).toBe(false)
      expect(rig.pool.health().restarts.ok).toBe(true)
    })
  })

  it('pool_restarts: more than 3 exits of one runner in an hour; a repeated generation counts once', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      for (const gen of [1, 2, 3]) rig.pool.containerExited('runner-0', gen)
      rig.pool.containerExited('runner-0', 3)
      expect(rig.pool.health().restarts.ok).toBe(true)
      rig.pool.containerExited('runner-0', 4)
      expect(rig.pool.health().restarts.ok).toBe(false)
      rig.clock.now = T0 + 3_600_001
      expect(rig.pool.health().restarts.ok).toBe(true)
    })
  })

  it('pool_shortfall: a turn queued over 30 s, or a pool_full, within 15 minutes', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      rig.admit = async () => ({ refused: 'chat_live', gen: 1 })
      sql.exec("INSERT INTO turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      await rig.pool.place(rs('t_a'), 1)
      rig.clock.now = T0 + 30_000
      expect(rig.pool.health().shortfall.ok).toBe(true)
      rig.clock.now = T0 + 30_001
      expect(rig.pool.health().shortfall.ok).toBe(false)
      rig.clock.now = T0 + 60_000
      await rig.pool.retryQueue()
      expect(rig.pool.queued()).toEqual([])
      rig.clock.now = T0 + 60_000 + 15 * 60_000 - 1
      expect(rig.pool.health().shortfall.ok).toBe(false)
      rig.clock.now = T0 + 60_000 + 15 * 60_000
      expect(rig.pool.health().shortfall.ok).toBe(true)
    })
  })
})
