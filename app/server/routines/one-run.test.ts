// One run per slot, model-based (p4-w2.md test 4, Opus F11). A real D1 (the migrated test D1 in workerd, P3's test D1)
// and the reference fake of `runs.submit` (test-kit.ts). Random sequences of ticks, pokes, duplicate alarms, clock jumps,
// Run now, route writes (on and off, delete, restore, a schedule edit, a stage change) placed between a handler's read
// and its batch, turn ends delivered early, late and twice, and crashes at every await of the tick and of the end
// handler. Ways it can fail, written down first: a slot runs twice; an end task id gets a second turn; a disabled,
// or deleted routine's slot runs; a slot's state moves backwards; a turn that ended leaves its slot open or
// its result written twice; the number of runs differs from the slots that should run (the brute-force oracle of test 1
// plus the rules in words).
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SlotRow, SlotState } from './rows.ts'
import { deleteRoutine, readRoutine, runNow, updateRoutine } from './store.ts'
import { ON_TIME_MS, POKE_ID, TICK_ID } from './tick.ts'
import { Crash, MIN, addPerson, at, db, fresh, harness, insertRoutine, routine, setStage, setZone, wrapD1 } from './test-kit.ts'
import type { FakeTurn, Harness } from './test-kit.ts'
import { oracle } from './test-oracle.ts'

const ADMIN = 'm_w2_model_admin'
const T0 = at('2026-06-01T09:00:00Z')

/** The transition table (section 6): where each state may go. */
const NEXT: Record<SlotState, readonly SlotState[]> = {
  claimed: ['started', 'refused', 'missed', 'skipped', 'ended'],
  started: ['lost', 'ended'],
  lost: ['ended'], missed: ['ended'], skipped: ['ended'], refused: ['ended'],
  ended: [],
}

const allSlots = async () => (await db.prepare('SELECT * FROM routine_slots').all<SlotRow>()).results

let silence: ReturnType<typeof vi.spyOn>[] = []
beforeAll(async () => {
  await addPerson(ADMIN, 'admin')
  // Crashes log loudly by design; the assertions below are what this file checks.
  silence = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]
})
afterAll(() => {
  for (const s of silence) s.mockRestore()
})

type Write = 'disable' | 'enable' | 'delete' | 'restore' | 'edit' | 'watch' | 'act'
const WRITES: readonly Write[] = ['disable', 'enable', 'delete', 'restore', 'edit', 'watch', 'act']

let req = 0
async function applyWrite(w: Write, id: string, now: number): Promise<void> {
  const r = await readRoutine(db, id)
  if (!r) throw new Error('no routine')
  const by = { actorId: ADMIN, requestId: `req-model-${++req}`, nowMs: now }
  if (w === 'disable' || w === 'enable') await updateRoutine(db, id, r.rev, { enabled: w === 'enable' }, by)
  else if (w === 'edit') await updateRoutine(db, id, r.rev, { minute: (r.minute + 7) % 60 }, by)
  else if (w === 'delete') await deleteRoutine(db, id, r.rev, by)
  else if (w === 'restore') {
    // Route 56 (PR 2): back from the trash, no backfill.
    await db.prepare('UPDATE routines SET deleted_at_ms = NULL, checked_until_ms = ?, rev = rev + 1 WHERE id = ? AND deleted_at_ms IS NOT NULL').bind(now, id).run()
  } else await setStage(w === 'watch' ? 'Watch' : 'Act')
}

// ---------- property A: the invariants under everything at once ----------

type Op =
  | { t: 'advance'; min: number }
  | { t: 'tick' | 'poke'; crashAt: number | null; writeAt: number | null; write: Write; crashAfterSubmit: boolean }
  | { t: 'dup' }
  | { t: 'runNow'; key: number }
  | { t: 'write'; write: Write }
  | { t: 'end'; pick: number; twice: boolean; crashAt: number | null }

const maybe = (max: number) => fc.option(fc.nat({ max }), { nil: null, freq: 2 })
const opA: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('advance' as const), min: fc.oneof(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 40, max: 600 }), fc.integer({ min: 1000, max: 12_000 })) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constantFrom('tick' as const, 'poke' as const), crashAt: maybe(14), writeAt: maybe(14), write: fc.constantFrom(...WRITES), crashAfterSubmit: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('dup' as const) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('runNow' as const), key: fc.nat({ max: 3 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('write' as const), write: fc.constantFrom(...WRITES) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('end' as const), pick: fc.nat(), twice: fc.boolean(), crashAt: maybe(6) }) },
)

describe('one run per slot (test 4)', () => {
  it('holds the invariants under random ticks, writes, ends and crashes', async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        zone: fc.constantFrom('America/New_York', 'Europe/London', 'Australia/Lord_Howe'),
        mask: fc.integer({ min: 1, max: 127 }), hour: fc.integer({ min: 0, max: 23 }), minute: fc.integer({ min: 0, max: 59 }),
        missed: fc.constantFrom('skip' as const, 'catch_up' as const), within: fc.integer({ min: 10, max: 1440 }),
        ops: fc.array(opA, { minLength: 5, maxLength: 40 }),
      }),
      async p => {
        await fresh()
        await setZone(p.zone)
        await setStage('Act')
        const h = harness()
        const r = await insertRoutine(routine({ creator_id: ADMIN, checked_until_ms: T0, days_mask: p.mask, hour: p.hour, minute: p.minute, missed: p.missed, catch_up_within_min: p.within }))
        let now = T0
        const violations: string[] = []
        const seen = new Map<string, SlotState>()
        const finished = new Set<FakeTurn>()
        const delivered = new Set<FakeTurn>()

        // At a new turn: the slot is claimed and its routine may run now (enabled for a scheduled slot, not deleted).
        h.runs.beforeNew = async t => {
          const s = await db.prepare(
            'SELECT s.kind, s.state, r.enabled, r.deleted_at_ms FROM routine_slots s JOIN routines r ON r.id = s.routine_id WHERE s.chat_id = ?',
          ).bind(t.chatId).first<{ kind: string; state: string; enabled: number; deleted_at_ms: number | null }>()
          if (!s) violations.push('a turn for no slot')
          else if (s.state !== 'claimed' || s.deleted_at_ms !== null || (s.kind === 'scheduled' && s.enabled !== 1)) {
            violations.push(`a turn for a slot that may not run: ${JSON.stringify(s)}`)
          }
        }

        const check = async () => {
          for (const s of await allSlots()) {
            const was = seen.get(s.slot_key)
            if (was !== undefined && was !== s.state && !NEXT[was].includes(s.state)) violations.push(`${was} → ${s.state}`)
            seen.set(s.slot_key, s.state)
          }
          for (const [id, n] of h.runs.onEndIds) if (n > 1) violations.push(`${n} turns for ${id}`)
        }

        const tick = async (op: Extract<Op, { t: 'tick' | 'poke' }> | null, id: string) => {
          const w = wrapD1(db, async (_kind, n) => {
            // A route write lands before any read or batch of the pass (#250 review: reads too, so the last read before a submit is tested).
            if (op?.writeAt !== null && op?.writeAt !== undefined && n === op.writeAt) await applyWrite(op.write, r.id, now)
            if (op?.crashAt !== null && op?.crashAt !== undefined && n === op.crashAt) throw new Crash()
          })
          h.runs.refuse = () => {
            if (w.dead()) throw new Crash()
            return undefined
          }
          h.runs.afterSubmit = op?.crashAfterSubmit ? () => w.kill() : undefined
          await h.tick(now, id, w.db)
          h.runs.refuse = undefined
          h.runs.afterSubmit = undefined
        }

        const deliver = async (turn: FakeTurn, crashAt: number | null) => {
          const w = wrapD1(db, async (_kind, n) => {
            if (crashAt !== null && n === crashAt) throw new Crash()
          })
          try {
            await h.end(turn, now, {}, w.db)
            delivered.add(turn)
          } catch (err) {
            if (!(err instanceof Crash)) throw err
          }
        }

        for (const op of p.ops) {
          if (op.t === 'advance') now += op.min * MIN
          else if (op.t === 'tick' || op.t === 'poke') await tick(op, op.t === 'tick' ? TICK_ID : POKE_ID)
          else if (op.t === 'dup') {
            await tick(null, TICK_ID)
            await tick(null, TICK_ID)
          } else if (op.t === 'runNow') {
            await runNow(db, r.id, `model-key-${op.key}`, { actorId: ADMIN, requestId: `req-model-${++req}`, nowMs: now })
          } else if (op.t === 'write') await applyWrite(op.write, r.id, now)
          else if (op.t === 'end') {
            const turns = [...h.runs.turns.values()]
            if (turns.length === 0) continue
            const turn = turns[op.pick % turns.length]
            finished.add(turn)
            await deliver(turn, op.crashAt)
            if (op.twice) await deliver(turn, null)
          }
          await check()
        }

        // Settle: P3 delivers every final turn's end until it lands; every other turn finishes too.
        for (let round = 0; round < 3; round++) {
          now += MIN
          await tick(null, TICK_ID)
          for (const turn of h.runs.turns.values()) {
            if (!delivered.has(turn)) await deliver(turn, null)
          }
          await check()
        }

        expect(violations).toEqual([])
        const slots = await allSlots()
        for (const turn of h.runs.turns.values()) {
          const s = slots.find(x => x.chat_id === turn.chatId)
          expect(s?.state, turn.chatId).toBe('ended')
          expect(s?.turn_id).toBe(turn.turnId)
          const lines = await db.prepare("SELECT COUNT(*) AS n FROM activity_lines WHERE source = 'routine-slot' AND source_key = ?").bind(s!.slot_key).first<number>('n')
          expect(lines, s!.slot_key).toBe(1)
        }
        // Every slot with a turn has exactly one, and no turn is outside a slot.
        expect(slots.filter(s => s.turn_id !== null).length).toBe(h.runs.turns.size)
      },
    ), { numRuns: 40 })
  })

  // ---------- property B: the count against the oracle ----------

  type OpB = { t: 'advance'; min: number } | { t: 'tick' } | { t: 'dup' } | { t: 'crash' } | { t: 'early' } | { t: 'endAll' }
  const opB: fc.Arbitrary<OpB> = fc.oneof(
    { weight: 5, arbitrary: fc.record({ t: fc.constant('advance' as const), min: fc.oneof(fc.integer({ min: 1, max: 15 }), fc.integer({ min: 20, max: 300 }), fc.integer({ min: 400, max: 600 })) }) },
    { weight: 4, arbitrary: fc.record({ t: fc.constant('tick' as const) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('dup' as const) }) },
    { weight: 2, arbitrary: fc.record({ t: fc.constant('crash' as const) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('early' as const) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('endAll' as const) }) },
  )

  it('runs exactly the slots the oracle says should run (crashes after submit, early and double ends)', async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        zone: fc.constantFrom('America/New_York', 'Europe/London', 'Australia/Lord_Howe'),
        mask: fc.integer({ min: 1, max: 127 }), hour: fc.integer({ min: 0, max: 23 }), minute: fc.integer({ min: 0, max: 59 }),
        missed: fc.constantFrom('skip' as const, 'catch_up' as const), within: fc.integer({ min: 10, max: 1440 }),
        ops: fc.array(opB, { minLength: 5, maxLength: 20 }),
      }),
      async p => {
        await fresh()
        await setZone(p.zone)
        await setStage('Act')
        const h: Harness = harness()
        const r = await insertRoutine(routine({ creator_id: ADMIN, checked_until_ms: T0, days_mask: p.mask, hour: p.hour, minute: p.minute, missed: p.missed, catch_up_within_min: p.within }))
        let now = T0
        const passes: number[] = []
        const ended = new Set<FakeTurn>()
        const tick = async (crashAfterSubmit: boolean) => {
          const w = wrapD1(db)
          h.runs.refuse = () => {
            if (w.dead()) throw new Crash()
            return undefined
          }
          h.runs.afterSubmit = crashAfterSubmit ? () => w.kill() : undefined
          passes.push(now)
          await h.tick(now, TICK_ID, w.db)
          h.runs.refuse = undefined
          h.runs.afterSubmit = undefined
        }
        const endTurn = async (t: FakeTurn) => {
          await h.end(t, now)
          ended.add(t)
        }
        for (const op of p.ops) {
          if (op.t === 'advance') now += op.min * MIN
          else if (op.t === 'tick') await tick(false)
          else if (op.t === 'dup') {
            await tick(false)
            await tick(false)
          } else if (op.t === 'crash') {
            await tick(true)
            await tick(false) // the next alarm, at the same time
          } else {
            const open = [...h.runs.turns.values()].filter(t => !ended.has(t))
            if (op.t === 'early' && open.length > 0) {
              const t = open[open.length - 1]
              await endTurn(t)
              await endTurn(t)
            }
            if (op.t === 'endAll') for (const t of open) await endTurn(t)
          }
        }
        if (passes.length === 0) return

        // The oracle: every slot due in (T0, last pass], each decided by the first pass at or after it, by the rules in words.
        const hhmm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
        const due = oracle(p.zone, p.mask, hhmm, T0, passes[passes.length - 1], r.id)
        let expected = 0
        let from = T0
        for (const T of passes) {
          const bucket = due.filter(s => s.dueAtMs > from && s.dueAtMs <= T)
          from = Math.max(from, T)
          const late = bucket.filter(s => T - s.dueAtMs > ON_TIME_MS)
          const newestLate = late[late.length - 1]
          for (const s of bucket) {
            if (T - s.dueAtMs <= ON_TIME_MS) expected++
            else if (p.missed === 'catch_up' && s === newestLate && T - s.dueAtMs <= p.within * MIN) expected++
          }
        }
        expect(h.runs.turns.size).toBe(expected)
        for (const [id, n] of h.runs.onEndIds) expect(n, id).toBe(1)
      },
    ), { numRuns: 40 })
  })
})
