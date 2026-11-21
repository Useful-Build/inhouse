// The runner pool (pool.ts) on the BrandAgent's real SQLite, with W1's `turns`, `runs` and `flags` tables created here
// in the shape of p3-design 4.1 (W1 creates them in the object) and the Runner objects behind a fake. Routing is checked
// against a ledger the test keeps from the answers it scripted and the design's table of what each answer does (written
// out below with literal constants: 25 per runner, 60 s queue, 5 s cool-down, 60 s suspect cool-down, 3 per pass); it
// never reads pool.ts's state. Ways it can fail, written down first:
//  1. a placement goes to the wrong runner (not fill-first by index, a sleeping one woken before an up one has room,
//     a cooling, suspect or protocol runner picked);
//  2. more than 25 unfinished turns on one runner, including placements racing for the last slots;
//  3. an ambiguous admission (or an untyped answer, or `run_live`) is followed by a placement of that turn anywhere, or
//     doesn't make the runner suspect;
//  4. one turn the runner rejects (a typed 4xx) cools the pool or holds the queue;
//  5. the queue isn't FIFO, a newcomer overtakes it, a 409 holds the turns behind it, a turn waits past 60 s, a pass
//     places more than 3, or a free slot / the 5 s retry doesn't hand queued turns back;
//  6. a container exit fences the turns twice, the wrong turns, or (a late, older generation) the new container's;
//  7. drain: an admission after the drain step, counts that don't reach 0, an expiry that doesn't clear or advance runs;
//     warm-up clearing the drain with a failed /health or on the container from before the drain, or not starting a
//     run's queued follow-up;
//  8. the signals miss a protocol runner, a restart storm or a shortfall;
//  9. a slow cold start (the boot deadline passed, the container still running): the runner is sent to sleep instead of
//     kept `starting` (so the retry doesn't join that start), or the same placement wakes a second sleeping runner (two
//     boots outlast the turn's 3 min starting deadline) (Q2's sandbox, 2026-11-21).
import { fc } from '@fast-check/vitest'
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { RunStart } from '../../../shared/protocol/index.ts'
import type { Scheduler } from '../brand-agent/scheduler.ts'
import { createAgentTables } from '../brand-agent/schema.ts'
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

/**
 * W1's tables, as p3-design 4.1 names the columns the pool reads. The BrandAgent class creates its real tables on start
 * (W1 PR 2, schema.ts); these tests replace them with the columns the pool reads, so their rows stay minimal.
 */
function w1Tables(sql: SqlStorage) {
  // W1's real tables (the BrandAgent's own schema), fresh for each test: the object's constructor already made them.
  for (const t of ['turns', 'runs', 'flags', 'events', 'chat_state', 'turn_effects', 'turn_trace', 'authority']) sql.exec(`DROP TABLE IF EXISTS ${t}`)
  createAgentTables(sql)
  // The pool reads only `turns(turn_id, run_id, state, gen, runner)` and `runs(run_id, state)`. These views take the
  // tests' short inserts and fill the real tables' other required columns with placeholders.
  sql.exec('DROP VIEW IF EXISTS seed_turns')
  sql.exec('CREATE VIEW seed_turns AS SELECT turn_id, run_id, state, gen, runner FROM turns')
  sql.exec(`CREATE TRIGGER seed_turns_insert INSTEAD OF INSERT ON seed_turns BEGIN
    INSERT INTO turns (turn_id, run_id, chat_id, owner_id, ord, client_key, payload_hash, gen, state, priority, text,
      attachments_json, model, picker_id, side_model, effort, max_turns, answer_position, runner, created_at_ms)
    VALUES (NEW.turn_id, COALESCE(NEW.run_id, 'r_' || NEW.turn_id), 'c_' || NEW.turn_id, 'm_test', 0, NEW.turn_id, 'h',
      COALESCE(NEW.gen, 1), NEW.state, 'next', '', '[]', 'claude-sonnet-5-5', 'sonnet', 'claude-haiku-5-5', 'medium', 25,
      'starting', NEW.runner, 0);
  END`)
  sql.exec('DROP VIEW IF EXISTS seed_runs')
  sql.exec('CREATE VIEW seed_runs AS SELECT run_id, state FROM runs')
  sql.exec(`CREATE TRIGGER seed_runs_insert INSTEAD OF INSERT ON seed_runs BEGIN
    INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms) VALUES (NEW.run_id, 'c_' || NEW.run_id, 'm_test', NEW.state, 0);
  END`)
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

/** A 2-runner pool whose Runners answer `admit` through `admit(name)`; every other call is inert. */
function poolWith(sql: SqlStorage, admit: (name: string) => (start: RunStart) => Promise<AdmitResult>, clock = { now: T0 }, hooks: PlacementHooks = { retryPlacement: async () => {}, placementExpired: async () => {} }, sched: Scheduler = new FakeScheduler()) {
  return new RunnerPool({
    sql, scheduler: sched, now: () => clock.now, size: 2, hooks,
    runner: name => ({
      admit: admit(name),
      status: async () => ({ state: 'live', containerGone: false }),
      interrupt: async () => {}, stop: async () => {}, warm: async () => ({ ok: true, gen: 1, protocol: 2 }),
    }),
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Routing: random histories, admissions interleaved by fast-check's scheduler, checked against a ledger the test keeps
// from the answers it scripted and the design's table of what each answer does. The ledger never asks pool.ts; every
// pick, result, queue move, expiry and fence is checked against it at the moment the pool makes it.

type Mode = 'ok' | 'ambiguous' | 'run_live' | 'chat_live' | 'exhausted' | 'parked' | 'unavailable' | 'down' | 'protocol'
type Answer = Mode | 'rejected'
type Op =
  /** Start these turns at once (their admissions interleave); `true`: the runner rejects that turn's start (typed 400). */
  | { k: 'burst'; bad: boolean[] }
  | { k: 'end'; i: number }
  | { k: 'mode'; r: number; mode: Mode }
  | { k: 'exit'; r: number }
  | { k: 'tick'; ms: number }
  /** Route 46, then (`warm`) route 48. */
  | { k: 'drain' }
  | { k: 'warm' }

const N = 3
const CAP = 25
const QUEUE_MS = 60_000
const PASS_MAX = 3

/**
 * The design table (p3-design 7, fix round 1): what one answer does to the turn and to the runner. `cool`: the runner
 * isn't picked for this long (0 clears it; absent leaves it); `awake`: up-class (`false`: sleeping); `protocolBad`:
 * never picked; `keeps`: the turn stays counted on the runner.
 */
const TABLE: Record<Answer, { turn: 'admitted' | 'ambiguous' | 'next' | 'queued' | 'files' | 'rejected'; keeps: boolean; cool?: number; awake?: boolean; protocolBad?: boolean; gen?: true }> = {
  ok: { turn: 'admitted', keeps: true, cool: 0, awake: true, protocolBad: false, gen: true },
  ambiguous: { turn: 'ambiguous', keeps: true, cool: 60_000 },
  run_live: { turn: 'ambiguous', keeps: true },
  chat_live: { turn: 'queued', keeps: false, awake: true, gen: true },
  exhausted: { turn: 'next', keeps: false, cool: 5_000, awake: true, gen: true },
  parked: { turn: 'files', keeps: false, awake: true, gen: true },
  /** Any typed 5xx: the runner said it didn't admit; the next candidate, queued only when none is left. */
  unavailable: { turn: 'next', keeps: false, cool: 5_000 },
  down: { turn: 'next', keeps: false, cool: 5_000, awake: false, protocolBad: false },
  protocol: { turn: 'next', keeps: false, protocolBad: true, gen: true },
  rejected: { turn: 'rejected', keeps: false },
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 10, arbitrary: fc.array(fc.constantFrom(false, false, false, false, false, false, false, true), { minLength: 1, maxLength: 8 }).map<Op>(bad => ({ k: 'burst', bad })) },
  { weight: 5, arbitrary: fc.nat(10_000).map<Op>(i => ({ k: 'end', i })) },
  { weight: 3, arbitrary: fc.record({ r: fc.nat(N - 1), mode: fc.constantFrom<Mode>('ok', 'ok', 'ok', 'ok', 'ambiguous', 'run_live', 'chat_live', 'exhausted', 'parked', 'unavailable', 'down', 'protocol') }).map<Op>(x => ({ k: 'mode', ...x })) },
  { weight: 1, arbitrary: fc.nat(N - 1).map<Op>(r => ({ k: 'exit', r })) },
  { weight: 3, arbitrary: fc.constantFrom(1_000, 5_000, 30_000, 61_000).map<Op>(ms => ({ k: 'tick', ms })) },
  { weight: 1, arbitrary: fc.constant<Op>({ k: 'drain' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ k: 'warm' }) },
)

interface PlaceCtx { newcomer: boolean; tried: number[]; expect: string | 'pending' }

class Ledger {
  now = T0
  violations: string[] = []
  runners = Array.from({ length: N }, () => ({ unfinished: new Set<string>(), coolUntil: 0, awake: false, protocolBad: false, mode: 'ok' as Mode, gen: 1, seenGen: null as number | null, drainGen: null as number | null }))
  drainUntil: number | null = null
  draining() { return this.drainUntil !== null && this.drainUntil > this.now }
  /** FIFO: insertion order; turn → queued at. */
  queue = new Map<string, number>()
  ambiguous = new Set<string>()
  bad = new Set<string>()
  places = new Map<string, PlaceCtx>()

  eligible(i: number, tried: readonly number[]) {
    const r = this.runners[i]
    return !tried.includes(i) && r.unfinished.size < CAP && r.coolUntil <= this.now && !r.protocolBad
  }
  /** Fill-first: the lowest-index up-class runner with room, else the lowest-index sleeping one. */
  pick(tried: readonly number[]): number | null {
    for (let i = 0; i < N; i++) if (this.runners[i].awake && this.eligible(i, tried)) return i
    for (let i = 0; i < N; i++) if (!this.runners[i].awake && this.eligible(i, tried)) return i
    return null
  }
  enqueue(t: string) { if (!this.queue.has(t)) this.queue.set(t, this.now) }
  violate(v: string) { this.violations.push(v) }

  /** At `place(t)`'s call (the pool's synchronous part runs before its first admission). */
  placeStarts(t: string) {
    const ctx: PlaceCtx = { newcomer: !this.queue.has(t), tried: [], expect: 'pending' }
    this.places.set(t, ctx)
    if (this.draining()) {
      ctx.expect = 'draining'
      this.queue.delete(t)
      return
    }
    if ((ctx.newcomer && this.queue.size > 0) || this.pick([]) === null) {
      ctx.expect = 'queued'
      this.enqueue(t)
    }
  }
  /** At an admission call: the pick must be the table's, under the cap, never for an ambiguous turn. */
  admitCalled(t: string, i: number) {
    const ctx = this.places.get(t)
    if (ctx === undefined || ctx.expect !== 'pending') return this.violate(`${t}: an admission the ledger didn't expect (runner-${i})`)
    if (this.ambiguous.has(t)) this.violate(`${t}: admitted again after an ambiguous answer (runner-${i})`)
    const want = this.pick(ctx.tried)
    if (want !== i) this.violate(`${t}: picked runner-${i}, the table says ${want === null ? 'none' : `runner-${want}`}`)
    ctx.tried.push(i)
    this.runners[i].unfinished.add(t)
    this.runners[i].awake = true
  }
  answered(t: string, i: number, a: Answer) {
    const ctx = this.places.get(t)!
    const e = TABLE[a]
    const r = this.runners[i]
    if (!e.keeps) r.unfinished.delete(t)
    if (e.cool !== undefined) r.coolUntil = e.cool === 0 ? 0 : this.now + e.cool
    if (e.awake !== undefined) r.awake = e.awake
    if (e.protocolBad !== undefined) r.protocolBad = e.protocolBad
    if (e.gen) r.seenGen = r.gen
    if (e.turn === 'ambiguous') this.ambiguous.add(t)
    if (e.turn === 'next') {
      if (this.draining()) {
        ctx.expect = 'draining'
        this.queue.delete(t)
      } else if (this.pick(ctx.tried) === null) {
        ctx.expect = 'queued'
        this.enqueue(t)
      }
      return
    }
    ctx.expect = e.turn === 'admitted' || e.turn === 'ambiguous' ? `${e.turn} runner-${i}` : e.turn
    if (e.turn === 'queued') this.enqueue(t)
    else this.queue.delete(t)
  }
  placeEnded(t: string, result: string) {
    const ctx = this.places.get(t)!
    if (ctx.expect !== result) this.violate(`${t}: place answered ${result}, the table says ${ctx.expect}`)
    this.places.delete(t)
  }
}

const answerOf = (a: Answer, gen: number): AdmitResult => {
  switch (a) {
    case 'ok': return { accepted: true, gen, protocol: 2 }
    case 'ambiguous': return { ambiguous: true, gen }
    case 'run_live': return { refused: 'run_live', gen }
    case 'chat_live': return { refused: 'chat_live', gen }
    case 'exhausted': return { refused: 'session_pool_exhausted', gen }
    case 'parked': return { refused: 'session_folder_parked', gen }
    case 'unavailable': return { unavailable: 'the runner is stopping', gen }
    case 'down': return { placementError: 'no /protocol answer', booting: false }
    case 'protocol': return { protocol: 'none', gen }
    case 'rejected': return { rejected: 400, gen }
  }
}

/** The real pool, a fake Runner per name answering through fast-check's scheduler, and W1's side of the hooks. */
async function runReal(sql: SqlStorage, ops: Op[], s: fc.Scheduler) {
  w1Tables(sql)
  const L = new Ledger()
  const sched = new FakeScheduler()
  let n = 0

  const placeAndApply = async (id: string) => {
    L.placeStarts(id)
    const a = await pool.place(rs(id), 1)
    const result = 'admitted' in a ? `admitted ${a.admitted}` : 'ambiguous' in a ? `ambiguous ${a.ambiguous}` : 'queued' in a ? 'queued' : a.refused
    L.placeEnded(id, result)
    if ('admitted' in a) sql.exec("UPDATE turns SET state = 'live' WHERE turn_id = ?", id)
    else if ('refused' in a) sql.exec("UPDATE turns SET state = 'ended' WHERE turn_id = ?", id)
  }
  let pass: { calls: string[]; order: string[]; left: number } | null = null
  const hooks: PlacementHooks = {
    retryPlacement: async id => {
      if (pass === null || !L.queue.has(id)) return L.violate(`${id}: retried while not queued`)
      pass.calls.push(id)
      if (!L.ambiguous.has(id)) await placeAndApply(id)
      if (!L.queue.has(id)) pass.left++
    },
    placementExpired: async id => {
      const at = L.queue.get(id)
      if (at === undefined || L.now - at < QUEUE_MS) L.violate(`${id}: expired after ${at === undefined ? '?' : L.now - at} ms`)
      L.queue.delete(id)
      sql.exec("UPDATE turns SET state = 'ended' WHERE turn_id = ?", id)
    },
  }
  const fake = (i: number): RunnerRpc => ({
    admit: start => {
      const t = start.runId
      L.admitCalled(t, i)
      const a: Answer = L.bad.has(t) ? 'rejected' : L.runners[i].mode
      const gen = L.runners[i].gen
      return s.schedule(Promise.resolve(a), `admit ${t} runner-${i} ${a}`).then(x => {
        L.answered(t, i, x)
        return answerOf(x, gen)
      })
    },
    status: async () => ({ state: 'live', containerGone: false }),
    interrupt: async () => {},
    stop: async () => {},
    warm: async newerThan => {
      const r = L.runners[i]
      // Offered a replacement only when idle (no unfinished turn; no admission is in flight between ops).
      const want = L.draining() && r.unfinished.size === 0 ? r.drainGen : null
      if (newerThan !== want) L.violate(`warm runner-${i}: asked for newer than ${newerThan}, the ledger has ${want}`)
      if (newerThan !== null && r.gen <= newerThan) {
        if (r.unfinished.size > 0) return { ok: false, why: 'busy', detail: 'runs on the old container' }
        // Idle: the Runner replaces it, and reports the old generation's exit (it fences nothing).
        const fenced = pool.containerExited(`runner-${i}`, r.gen)
        if (JSON.stringify(fenced) !== '[]') L.violate(`warm runner-${i}: the replaced container fenced ${JSON.stringify(fenced)}`)
        r.gen++
      }
      return { ok: true, gen: r.gen, protocol: 2 }
    },
  })
  const pool = new RunnerPool({ sql, scheduler: sched, now: () => L.now, size: N, runner: name => fake(Number(name.slice(7))), hooks })

  const ended = (id: string) => {
    for (const r of L.runners) r.unfinished.delete(id)
    const t = sql.exec<{ runner: string | null }>("UPDATE turns SET state = 'ended' WHERE turn_id = ? RETURNING runner", id).one()
    pool.turnEnded(t.runner ?? '', id)
  }
  for (const op of ops) {
    if (op.k === 'burst') {
      const ids = op.bad.map(b => {
        const id = `t_${n++}`
        if (b) L.bad.add(id)
        sql.exec("INSERT INTO seed_turns (turn_id, run_id, state, gen) VALUES (?, ?, 'starting', 1)", id, `r_${id}`)
        return id
      })
      await s.waitFor(Promise.all(ids.map(placeAndApply)))
    } else if (op.k === 'end') {
      const placed = L.runners.flatMap(r => [...r.unfinished]).sort()
      if (placed.length > 0) ended(placed[op.i % placed.length])
    } else if (op.k === 'mode') {
      L.runners[op.r].mode = op.mode
    } else if (op.k === 'exit') {
      const r = L.runners[op.r]
      if (r.awake || r.protocolBad) {
        const want = [...r.unfinished].sort()
        const fenced = pool.containerExited(`runner-${op.r}`, r.gen)
        if (JSON.stringify(fenced) !== JSON.stringify(want)) L.violate(`exit runner-${op.r}: fenced ${JSON.stringify(fenced)}, the ledger has ${JSON.stringify(want)}`)
        if (pool.containerExited(`runner-${op.r}`, r.gen) !== null) L.violate(`exit runner-${op.r}: generation ${r.gen} taken twice`)
        for (const id of want) ended(id)
        r.awake = false
        r.protocolBad = false
        r.gen++
      }
    } else if (op.k === 'drain') {
      if (!L.draining()) for (const r of L.runners) r.drainGen = r.seenGen
      L.drainUntil = L.now + 1_800_000
      pool.drain(L.now)
    } else if (op.k === 'warm') {
      const warmed = L.runners.slice(0, 2)
      const busy = L.draining() && warmed.some(r => r.drainGen !== null && r.gen <= r.drainGen && r.unfinished.size > 0)
      const res = await s.waitFor(pool.warmup())
      const want = busy ? { refused: { code: 'unavailable', reason: 'draining' } } : { ok: true }
      if (JSON.stringify(res) !== JSON.stringify(want)) L.violate(`warm-up answered ${JSON.stringify(res)}, the ledger says ${JSON.stringify(want)}`)
      // Every warmed runner answered ok (a busy one on its old container, asked for nothing): all up. warm() above
      // already moved a replaced container's gen on.
      for (const r of warmed) {
        r.awake = true
        r.coolUntil = 0
        r.protocolBad = false
        r.seenGen = r.gen
      }
      if (!busy) {
        L.drainUntil = null
        for (const r of L.runners) r.drainGen = null
      }
    } else {
      L.now += op.ms
    }
    const due = sched.tasks.get('pool-retry')
    if (due !== undefined && due.dueAtMs <= L.now) {
      sched.tasks.delete('pool-retry')
      const order = [...L.queue.keys()].filter(id => L.now - L.queue.get(id)! < QUEUE_MS)
      const expiring = L.queue.size - order.length
      const slot = L.pick([]) !== null || L.draining()
      pass = { calls: [], order, left: 0 }
      await s.waitFor(pool.retryQueue())
      const { calls, left } = pass
      pass = null
      if (left > PASS_MAX) L.violate(`${left} turns left the queue in one pass`)
      const inOrder = calls.every((id, k) => k === 0 || order.indexOf(id) > order.indexOf(calls[k - 1]))
      if (!inOrder) L.violate(`a pass retried out of FIFO order: ${calls.join(',')} of ${order.join(',')}`)
      if (order.length > 0 && slot && calls.length === 0 && expiring < PASS_MAX) L.violate('a pass with a free slot handed nothing back')
      // A pass reschedules itself at once only when the cap stopped it (no hot loop on turns that stay queued).
      const again = sched.tasks.get('pool-retry')
      if (again !== undefined && again.dueAtMs <= L.now && left + expiring < PASS_MAX) L.violate(`a pass with ${left + expiring} turns gone rescheduled at once`)
      for (const [id, at] of L.queue) if (L.now - at >= QUEUE_MS) L.violate(`${id}: still queued after ${L.now - at} ms`)
    }
    for (const { runner, c } of sql.exec<{ runner: string; c: number }>("SELECT runner, COUNT(*) AS c FROM turns WHERE runner IS NOT NULL AND state IN ('starting','live','ending') GROUP BY runner").toArray()) {
      if (c > CAP) L.violate(`${runner} has ${c} unfinished turns`)
    }
    if (L.violations.length > 0) break
  }
  return L.violations
}

describe('routing', () => {
  it('every pick, answer, queue move, expiry and fence follows the design table; never over 25; an ambiguous turn is never placed again', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 60, maxLength: 160, size: 'max' }), fc.scheduler(), async (ops, s) => {
        expect(await inObject(sql => runReal(sql, ops, s))).toEqual([])
      }),
      { numRuns: 60 },
    )
  })

  it('two placements racing for the 25th slot: the second goes to the next runner (barrier on the first admission)', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      for (let i = 0; i < 24; i++) sql.exec("INSERT INTO seed_turns (turn_id, state, gen, runner) VALUES (?, 'live', 1, 'runner-0')", `t_live${i}`)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1), ('t_b', 'starting', 1)")
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
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen, runner) VALUES ('t_old', 'live', 1, 'runner-0')")
      let open!: () => void
      const barrier = new Promise<void>(r => (open = r))
      const runner = (name: string): RunnerRpc => ({
        admit: async () => {
          if (name === 'runner-1') return { accepted: true, gen: 1, protocol: 2 }
          await barrier
          return { placementError: 'the container stopped before it answered /protocol', booting: false }
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

  it('a boot deadline passed on a container still running: the runner stays starting, cooled 5 s, no second runner is woken, the turn queues (failure 9)', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen, runner) VALUES ('t_a', 'starting', 1, NULL)")
      const admits: string[] = []
      const pool = poolWith(sql, name => async start => {
        admits.push(`${start.runId}@${name}`)
        return { placementError: 'no /protocol answer within 150000 ms', booting: true }
      })
      expect(await pool.place(rs('t_a'), 1)).toEqual({ queued: true })
      expect(admits).toEqual(['t_a@runner-0'])
      const rows = sql.exec('SELECT runner, state, refused_until_ms, protocol FROM pool_runners ORDER BY runner').toArray()
      expect(rows).toEqual([
        { runner: 'runner-0', state: 'starting', refused_until_ms: T0 + 5_000, protocol: null },
        { runner: 'runner-1', state: 'sleeping', refused_until_ms: null, protocol: null },
      ])
    })
  })

  it('after a slow start the turn still moves to a runner that is up (failure 9)', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen, runner) VALUES ('t_a', 'starting', 1, NULL)")
      const pool = poolWith(sql, name => async () => name === 'runner-0'
        ? { placementError: 'no /protocol answer within 150000 ms', booting: true }
        : { accepted: true, gen: 1, protocol: 2 })
      // runner-0 is picked first (starting, by index), so its slow start runs before runner-1 is tried.
      sql.exec("UPDATE pool_runners SET state = 'starting' WHERE runner = 'runner-0'")
      sql.exec("UPDATE pool_runners SET state = 'up' WHERE runner = 'runner-1'")
      expect(await pool.place(rs('t_a'), 1)).toEqual({ admitted: 'runner-1' })
    })
  })

  it('a stopped container (not booting) still moves the turn on to the next sleeping runner', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen, runner) VALUES ('t_a', 'starting', 1, NULL)")
      const pool = poolWith(sql, name => async () => name === 'runner-0'
        ? { placementError: 'the container stopped before it answered /protocol', booting: false }
        : { accepted: true, gen: 1, protocol: 2 })
      expect(await pool.place(rs('t_a'), 1)).toEqual({ admitted: 'runner-1' })
      expect(sql.exec("SELECT state FROM pool_runners WHERE runner = 'runner-0'").one().state).toBe('sleeping')
    })
  })

  it('one turn the runner rejects (typed 400) cools nothing: a good turn still places on runner-0 (H2)', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen, runner) VALUES ('t_live', 'live', 1, 'runner-0'), ('t_bad', 'starting', 1, NULL), ('t_good', 'starting', 1, NULL)")
      const admits: string[] = []
      const pool = poolWith(sql, name => async start => {
        admits.push(`${start.runId}@${name}`)
        return start.runId === 't_bad' ? { rejected: 400, gen: 1 } : { accepted: true, gen: 1, protocol: 2 }
      })
      sql.exec("UPDATE pool_runners SET state = 'up'")
      expect(await pool.place(rs('t_bad'), 1)).toEqual({ refused: 'rejected', status: 400 })
      expect(await pool.place(rs('t_good'), 1)).toEqual({ admitted: 'runner-0' })
      expect(admits).toEqual(['t_bad@runner-0', 't_good@runner-0'])
      expect(pool.queued()).toEqual([])
      expect(sql.exec("SELECT runner FROM turns WHERE turn_id = 't_bad'").one().runner).toBeNull()
      expect(sql.exec('SELECT runner, state, refused_until_ms, protocol FROM pool_runners ORDER BY runner').toArray()).toEqual([
        { runner: 'runner-0', state: 'up', refused_until_ms: null, protocol: 2 },
        { runner: 'runner-1', state: 'up', refused_until_ms: null, protocol: null },
      ])
    })
  })

  it.each([
    ['503 stopping', 'the runner is stopping'],
    ['500 no session user', 'could not set up the session user'],
    ['500 uid busy', 'the session user still has a live run'],
  ])('a typed 5xx (%s) moves the turn to the next runner; runner-0 cools 5 s, stays up with its protocol', async (_label, error) => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      const admits: string[] = []
      const pool = poolWith(sql, name => async start => {
        admits.push(`${start.runId}@${name}`)
        return name === 'runner-0' ? { unavailable: error, gen: 1 } : { accepted: true, gen: 1, protocol: 2 }
      })
      sql.exec("UPDATE pool_runners SET state = 'up', protocol = 2 WHERE runner = 'runner-0'")
      expect(await pool.place(rs('t_a'), 1)).toEqual({ admitted: 'runner-1' })
      expect(admits).toEqual(['t_a@runner-0', 't_a@runner-1'])
      expect(sql.exec("SELECT state, refused_until_ms, protocol FROM pool_runners WHERE runner = 'runner-0'").one()).toEqual({ state: 'up', refused_until_ms: T0 + 5_000, protocol: 2 })
    })
  })

  it('a typed 5xx from every runner: queued only when none is left', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      const admits: string[] = []
      const pool = poolWith(sql, name => async start => {
        admits.push(`${start.runId}@${name}`)
        return { unavailable: 'the runner is stopping', gen: 1 }
      })
      expect(await pool.place(rs('t_a'), 1)).toEqual({ queued: true })
      expect(admits).toEqual(['t_a@runner-0', 't_a@runner-1'])
    })
  })

  it('a cold start is not a slow admission: turns during a wake join it instead of waking the next runner', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1), ('t_b', 'starting', 1), ('t_c', 'starting', 1)")
      const clock = { now: T0 }
      let open!: () => void
      const booting = new Promise<void>(r => (open = r))
      const admits: string[] = []
      const pool = poolWith(sql, name => async start => {
        admits.push(`${start.runId}@${name}`)
        // runner-0's container is starting (a cold boot) until `open`.
        if (name === 'runner-0') await booting
        return { accepted: true, gen: 1, protocol: 2 }
      }, clock)
      // t_a wakes runner-0; t_b joins the boot 3 s in; t_c 3 s after that (t_b's wait is boot time too).
      const a = pool.place(rs('t_a'), 1)
      clock.now = T0 + 3_001
      const b = pool.place(rs('t_b'), 1)
      clock.now = T0 + 6_002
      const c = pool.place(rs('t_c'), 1)
      open()
      expect(await a).toEqual({ admitted: 'runner-0' })
      expect(await b).toEqual({ admitted: 'runner-0' })
      expect(await c).toEqual({ admitted: 'runner-0' })
      expect(admits).toEqual(['t_a@runner-0', 't_b@runner-0', 't_c@runner-0'])
    })
  })

  it('a runner with an admission in flight over 3 s gets no new turns until it answers', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_hung', 'starting', 1), ('t_b', 'starting', 1), ('t_c', 'starting', 1)")
      const clock = { now: T0 }
      let open!: () => void
      const barrier = new Promise<void>(r => (open = r))
      const pool = poolWith(sql, () => async start => {
        if (start.runId === 't_hung') await barrier
        return { accepted: true, gen: 1, protocol: 2 }
      }, clock)
      sql.exec("UPDATE pool_runners SET state = 'up'")
      const hung = pool.place(rs('t_hung'), 1)
      clock.now = T0 + 3_000
      expect(await pool.place(rs('t_b'), 1)).toEqual({ admitted: 'runner-0' })
      clock.now = T0 + 3_001
      expect(await pool.place(rs('t_c'), 1)).toEqual({ admitted: 'runner-1' })
      open()
      expect(await hung).toEqual({ admitted: 'runner-0' })
    })
  })

  it('three turns still answered chat_live at the head: the 4th is placed in the same pass, and no pass reschedules at once', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      const ids = ['t_1', 't_2', 't_3', 't_4']
      for (const id of ids) sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES (?, 'starting', 1)", id)
      const clock = { now: T0 }
      const sched = new FakeScheduler()
      let live = true
      const hooks: PlacementHooks = { retryPlacement: async id => void (await pool.place(rs(id), 1)), placementExpired: async () => {} }
      const pool = poolWith(sql, () => async start => (live || start.runId !== 't_4' ? { refused: 'chat_live', gen: 1 } : { accepted: true, gen: 1, protocol: 2 }), clock, hooks, sched)
      for (const id of ids) {
        expect(await pool.place(rs(id), 1)).toEqual({ queued: true })
        clock.now += 1
      }
      live = false
      clock.now = T0 + 5_000
      await pool.retryQueue()
      expect(pool.queued()).toEqual(['t_1', 't_2', 't_3'])
      expect(sched.tasks.get('pool-retry')?.dueAtMs).toBe(T0 + 10_000)
    })
  })

  it('an ambiguous admission keeps the turn on the runner and makes it suspect for 60 s: new turns go elsewhere (H1)', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1), ('t_b', 'starting', 1), ('t_c', 'starting', 1)")
      const clock = { now: T0 }
      const pool = poolWith(sql, name => async () => (name === 'runner-0' ? { ambiguous: true, gen: 1 } : { accepted: true, gen: 1, protocol: 2 }), clock)
      expect(await pool.place(rs('t_a'), 1)).toEqual({ ambiguous: 'runner-0' })
      expect(sql.exec("SELECT runner FROM turns WHERE turn_id = 't_a'").one().runner).toBe('runner-0')
      expect(await pool.place(rs('t_b'), 1)).toEqual({ admitted: 'runner-1' })
      clock.now = T0 + 60_000
      expect(await pool.place(rs('t_c'), 1)).toEqual({ ambiguous: 'runner-0' })
    })
  })

  it('409 run_live: the turn is live there, so it keeps the runner and is ambiguous, never cleared or moved', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      const admits: string[] = []
      const pool = poolWith(sql, name => async start => {
        admits.push(`${start.runId}@${name}`)
        return { refused: 'run_live', gen: 1 }
      })
      expect(await pool.place(rs('t_a'), 1)).toEqual({ ambiguous: 'runner-0' })
      expect(admits).toEqual(['t_a@runner-0'])
      expect(sql.exec("SELECT runner FROM turns WHERE turn_id = 't_a'").one().runner).toBe('runner-0')
      expect(pool.queued()).toEqual([])
    })
  })

  it('a second place() of a turn whose admission is in flight answers ambiguous and sends nothing', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      let open!: () => void
      const barrier = new Promise<void>(r => (open = r))
      let calls = 0
      const pool = poolWith(sql, () => async () => {
        calls++
        await barrier
        return { accepted: true, gen: 1, protocol: 2 }
      })
      const first = pool.place(rs('t_a'), 1)
      expect(await pool.place(rs('t_a'), 1)).toEqual({ ambiguous: 'runner-0' })
      open()
      expect(await first).toEqual({ admitted: 'runner-0' })
      expect(calls).toBe(1)
    })
  })

  it('a stale attempt refused by the runner leaves the newer attempt on the same runner alone (the gen fence)', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      // The newer attempt (gen 2) already sits on runner-0.
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen, runner) VALUES ('t_a', 'starting', 2, 'runner-0')")
      const pool = poolWith(sql, () => async () => ({ rejected: 400, gen: 1 }))
      sql.exec("UPDATE pool_runners SET state = 'up' WHERE runner = 'runner-0'")
      await pool.place(rs('t_a'), 1)
      expect(sql.exec("SELECT runner FROM turns WHERE turn_id = 't_a'").one().runner).toBe('runner-0')
    })
  })

  it('a late exit of an older generation fences nothing on the newer container', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      const pool = poolWith(sql, () => async () => ({ accepted: true, gen: 3, protocol: 2 }))
      expect(await pool.place(rs('t_a'), 1)).toEqual({ admitted: 'runner-0' })
      sql.exec("UPDATE turns SET state = 'live' WHERE turn_id = 't_a'")
      expect(pool.containerExited('runner-0', 2)).toEqual([])
      expect(sql.exec("SELECT state FROM pool_runners WHERE runner = 'runner-0'").one().state).toBe('up')
      expect(pool.containerExited('runner-0', 3)).toEqual(['t_a'])
    })
  })

  it('a stale attempt (the turn moved on to another gen) leaves no runner on the row after a refusal', async () => {
    await inObject(async sql => {
      w1Tables(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 2)")
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
  warm: (name: string, newerThan: number | null) => Promise<WarmResult>
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
      warm: newerThan => rig.warm(name, newerThan),
    }),
    hooks: { retryPlacement: async id => void rig.retried.push(id), placementExpired: async () => {} },
  })
  return rig
}

describe('placement queue', () => {
  /** Turns queued in this order (a chat_live answer each), then the runners answer per `answer`. */
  async function queuedRig(sql: SqlStorage, ids: string[], answer: (turnId: string) => AdmitResult) {
    w1Tables(sql)
    for (const id of ids) sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES (?, 'starting', 1)", id)
    const clock = { now: T0 }
    const sched = new FakeScheduler()
    let script: (turnId: string) => AdmitResult = () => ({ refused: 'chat_live', gen: 1 })
    const retried: string[] = []
    const expired: string[] = []
    const hooks: PlacementHooks = {
      retryPlacement: async id => {
        retried.push(id)
        await pool.place(rs(id), 1)
      },
      placementExpired: async id => void expired.push(id),
    }
    const pool = poolWith(sql, () => async start => script(start.runId), clock, hooks, sched)
    for (const id of ids) {
      expect(await pool.place(rs(id), 1)).toEqual({ queued: true })
      clock.now += 1
    }
    script = answer
    return { pool, clock, sched, retried, expired, set hooks(h: PlacementHooks) { Object.assign(hooks, h) } }
  }

  it('a head still answered chat_live does not hold the turns behind it', async () => {
    await inObject(async sql => {
      const rig = await queuedRig(sql, ['t_a', 't_b', 't_c'], id => (id === 't_a' ? { refused: 'chat_live', gen: 1 } : { accepted: true, gen: 1, protocol: 2 }))
      await rig.pool.retryQueue()
      expect(rig.retried).toEqual(['t_a', 't_b', 't_c'])
      expect(rig.pool.queued()).toEqual(['t_a'])
    })
  })

  it('a newcomer queued behind the queue while a slot is free brings the next pass forward to now', async () => {
    await inObject(async sql => {
      const rig = await queuedRig(sql, ['t_a'], () => ({ refused: 'chat_live', gen: 1 }))
      rig.clock.now = T0 + 2_000
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_new', 'starting', 1)")
      expect(await rig.pool.place(rs('t_new'), 1)).toEqual({ queued: true })
      expect(rig.pool.queued()).toEqual(['t_a', 't_new'])
      expect(rig.sched.tasks.get('pool-retry')?.dueAtMs).toBe(T0 + 2_000)
    })
  })

  it('a pass places at most 3, and the rest go in the next pass at once', async () => {
    await inObject(async sql => {
      const ids = ['t_1', 't_2', 't_3', 't_4', 't_5']
      const rig = await queuedRig(sql, ids, () => ({ accepted: true, gen: 1, protocol: 2 }))
      await rig.pool.retryQueue()
      expect(rig.retried).toEqual(['t_1', 't_2', 't_3'])
      expect(rig.pool.queued()).toEqual(['t_4', 't_5'])
      expect(rig.sched.tasks.get('pool-retry')?.dueAtMs).toBe(rig.clock.now)
      await rig.pool.retryQueue()
      expect(rig.retried).toEqual(ids)
      expect(rig.pool.queued()).toEqual([])
    })
  })

  it('every row is checked for expiry in a pass, and a row stays queued until placementExpired succeeded', async () => {
    await inObject(async sql => {
      const rig = await queuedRig(sql, ['t_a', 't_b', 't_c'], () => ({ refused: 'chat_live', gen: 1 }))
      // t_a and t_b were queued at T0 and T0+1, t_c at T0+2: at T0+60_001 the first two are due, t_c isn't.
      rig.clock.now = T0 + 60_001
      let fail = true
      rig.hooks = {
        retryPlacement: async () => {},
        placementExpired: async id => {
          if (id === 't_b' && fail) throw new Error('W1 could not fail it')
          rig.expired.push(id)
        },
      }
      await expect(rig.pool.retryQueue()).rejects.toThrow('W1 could not fail it')
      expect(rig.expired).toEqual(['t_a'])
      expect(rig.pool.queued()).toEqual(['t_b', 't_c'])
      fail = false
      await rig.pool.retryQueue()
      expect(rig.expired).toEqual(['t_a', 't_b'])
      expect(rig.pool.queued()).toEqual(['t_c'])
    })
  })
})

describe('drain', () => {
  it('a placement racing the drain call: refused at the next step, never sent to another runner', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
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
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_b', 'starting', 1)")
      expect(await rig.pool.place(rs('t_b'), 1)).toEqual({ refused: 'draining' })
      expect(admits).toEqual(['t_a'])
    })
  })

  it('reports live, starting, ending and queued, which reach 0 as turns end', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      sql.exec(`INSERT INTO seed_turns (turn_id, state, gen, runner) VALUES
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
      sql.exec("INSERT INTO seed_runs (run_id, state) VALUES ('r_1', 'live'), ('r_2', 'live'), ('r_3', 'ended')")
      rig.pool.drain(rig.clock.now)
      expect([...rig.sched.tasks].filter(([id]) => id.startsWith('run-advance:'))).toEqual([
        ['run-advance:r_1', { kind: 'run-advance', dueAtMs: T0 + 1_800_000, payload: { runId: 'r_1' } }],
        ['run-advance:r_2', { kind: 'run-advance', dueAtMs: T0 + 1_800_000, payload: { runId: 'r_2' } }],
      ])
      rig.clock.now = T0 + 1_800_000 - 1
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
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
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      rig.admit = async () => ({ refused: 'chat_live', gen: 1 })
      expect(await rig.pool.place(rs('t_a'), 1)).toEqual({ queued: true })
      rig.pool.drain(rig.clock.now)
      expect(rig.sched.tasks.get('pool-retry')?.dueAtMs).toBe(T0)
      await rig.pool.retryQueue()
      expect(rig.retried).toEqual(['t_a'])
    })
  })
})

describe('undrain (test build only, behind the route\'s gate)', () => {
  it('clears a drain at once: admissions open, the drain generations go, every live run and the queue advance now', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      sql.exec("INSERT INTO seed_runs (run_id, state) VALUES ('r_1', 'live'), ('r_2', 'ended')")
      sql.exec("UPDATE pool_runners SET state = 'up', container_gen = 3 WHERE runner = 'runner-0'")
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_q', 'starting', 1)")
      rig.admit = async () => ({ refused: 'chat_live', gen: 3 })
      expect(await rig.pool.place(rs('t_q'), 1)).toEqual({ queued: true })
      rig.pool.drain(rig.clock.now)
      rig.clock.now = T0 + 10_000
      expect(rig.pool.undrain()).toEqual({ live: 0, starting: 1, ending: 0, queued: 0, drainingUntilMs: null })
      expect(sql.exec("SELECT COUNT(*) AS n FROM flags WHERE key LIKE 'draining%'").one().n).toBe(0)
      expect(sql.exec('SELECT drain_gen FROM pool_runners WHERE drain_gen IS NOT NULL').toArray()).toEqual([])
      expect(rig.sched.tasks.get('run-advance:r_1')).toEqual({ kind: 'run-advance', dueAtMs: T0 + 10_000, payload: { runId: 'r_1' } })
      expect(rig.sched.tasks.has('run-advance:r_2')).toBe(false)
      expect(rig.sched.tasks.get('pool-retry')?.dueAtMs).toBe(T0 + 10_000)
      rig.admit = async () => ({ accepted: true, gen: 3, protocol: 2 })
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_new', 'starting', 1)")
      sql.exec("DELETE FROM pool_queue")
      expect(await rig.pool.place(rs('t_new'), 1)).toEqual({ admitted: 'runner-0' })
    })
  })

  it('with no drain on, changes nothing and schedules nothing', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      sql.exec("INSERT INTO seed_runs (run_id, state) VALUES ('r_1', 'live')")
      expect(rig.pool.undrain()).toEqual({ live: 0, starting: 0, ending: 0, queued: 0, drainingUntilMs: null })
      expect([...rig.sched.tasks.keys()]).toEqual([])
    })
  })
})

describe('warm-up', () => {
  it('a runner with an unfinished turn or an admission in flight is never offered a replacement (no newerThan)', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      sql.exec("UPDATE pool_runners SET state = 'up', container_gen = 4 WHERE runner IN ('runner-0', 'runner-1')")
      // runner-0: a placement from before the drain whose admission is still in flight; runner-1: idle.
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      let open!: () => void
      const barrier = new Promise<void>(r => (open = r))
      rig.admit = async () => {
        await barrier
        return { accepted: true, gen: 4, protocol: 2 }
      }
      const placing = rig.pool.place(rs('t_a'), 1)
      rig.pool.drain(rig.clock.now)
      const asked = new Map<string, number | null>()
      rig.warm = async (name, newerThan) => {
        asked.set(name, newerThan)
        return { ok: true, gen: newerThan === null ? 4 : 5, protocol: 2 }
      }
      expect(await rig.pool.warmup()).toEqual({ refused: { code: 'unavailable', reason: 'draining' } })
      expect(Object.fromEntries(asked)).toEqual({ 'runner-0': null, 'runner-1': 4 })
      open()
      expect(await placing).toEqual({ admitted: 'runner-0' })
      // Admitted and live there: still no replacement while it runs.
      sql.exec("UPDATE turns SET state = 'live' WHERE turn_id = 't_a'")
      asked.clear()
      expect(await rig.pool.warmup()).toEqual({ refused: { code: 'unavailable', reason: 'draining' } })
      expect(asked.get('runner-0')).toBeNull()
    })
  })

  it('refuses while a runner still has the container it had when the drain began; a newer one passes', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      sql.exec("UPDATE pool_runners SET state = 'up', container_gen = 4 WHERE runner IN ('runner-0', 'runner-1')")
      rig.pool.drain(rig.clock.now)
      const asked: (number | null)[] = []
      // runner-1's pre-drain container still runs a turn (the Runner answers busy); runner-0's was replaced.
      rig.warm = async (name, newerThan) => {
        asked.push(newerThan)
        return name === 'runner-0' ? { ok: true, gen: 5, protocol: 2 } : { ok: false, why: 'busy', detail: '1 run' }
      }
      expect(await rig.pool.warmup()).toEqual({ refused: { code: 'unavailable', reason: 'draining' } })
      expect(asked).toEqual([4, 4])
      expect(rig.pool.drainState().drainingUntilMs).toBe(T0 + 1_800_000)
      // A Runner that (wrongly) kept the old generation is still refused.
      rig.warm = async () => ({ ok: true, gen: 4, protocol: 2 })
      expect(await rig.pool.warmup()).toEqual({ refused: { code: 'unavailable', reason: 'draining' } })
      // runner-1 went idle and was replaced too.
      rig.warm = async () => ({ ok: true, gen: 5, protocol: 2 })
      expect(await rig.pool.warmup()).toEqual({ ok: true })
      // No drain now: warm-up asks for no particular generation.
      asked.length = 0
      rig.warm = async (_n, newerThan) => {
        asked.push(newerThan)
        return { ok: true, gen: 5, protocol: 2 }
      }
      expect(await rig.pool.warmup()).toEqual({ ok: true })
      expect(asked).toEqual([null, null])
    })
  })

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
      sql.exec("INSERT INTO seed_runs (run_id, state) VALUES ('r_1', 'live')")
      sql.exec("INSERT INTO seed_turns (turn_id, run_id, state, gen) VALUES ('t_1', 'r_1', 'ended', 1), ('t_2', 'r_1', 'queued', 1)")
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
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1), ('t_b', 'starting', 1)")
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

  it('pool_shortfall: a turn that waited over 30 s and was then placed keeps it red for 15 minutes', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      let answer: AdmitResult = { refused: 'chat_live', gen: 1 }
      rig.admit = async () => answer
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
      expect(await rig.pool.place(rs('t_a'), 1)).toEqual({ queued: true })
      rig.clock.now = T0 + 30_001
      answer = { accepted: true, gen: 1, protocol: 2 }
      expect(await rig.pool.place(rs('t_a'), 1)).toEqual({ admitted: 'runner-0' })
      expect(rig.pool.queued()).toEqual([])
      rig.clock.now = T0 + 30_001 + 15 * 60_000 - 1
      expect(rig.pool.health().shortfall.ok).toBe(false)
      rig.clock.now = T0 + 30_001 + 15 * 60_000
      expect(rig.pool.health().shortfall.ok).toBe(true)
    })
  })

  it('pool_shortfall: a turn queued over 30 s, or a pool_full, within 15 minutes', async () => {
    await inObject(async sql => {
      const rig = drainRig(sql)
      rig.admit = async () => ({ refused: 'chat_live', gen: 1 })
      sql.exec("INSERT INTO seed_turns (turn_id, state, gen) VALUES ('t_a', 'starting', 1)")
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
