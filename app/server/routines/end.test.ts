// A routine run's end (p4-w2.md section 6; tests 11 and 14). Ways it can fail, written down first: a crash part way
// leaves a half-written end (the slot ended without its result, or the result without the slot); a re-delivery writes
// the result, the Activity line or a notice twice; an older end overwrites the routine's `last`; a failure is lost or
// rings the bell for W3's quiet `not_connected`; an exhausted end can't be revived (its id isn't one route 51 takes) or
// is poked (losing its payload).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { TaskIdSchema } from '../../shared/contract/audit.ts'
import { endTaskId, slotKeyOfEndTask } from './keys.ts'
import { RESULT_HANDLERS } from './results.ts'
import type { ResultHandler } from './results.ts'
import { routinesSignal } from './signal.ts'
import { Crash, MIN, addPerson, at, db, fresh, harness, insertRoutine, linesOf, routine, setStage, setZone, slotsOf, wrapD1 } from './test-kit.ts'
import type { FakeTurn, Harness } from './test-kit.ts'

const CREATOR = 'm_w2_end_creator'
const SIX = at('2026-06-01T10:00:00Z')
const handlers = RESULT_HANDLERS as Record<string, ResultHandler>

/** The test result handler: one read, one idempotent row keyed by the slot. `broken` makes its read throw. */
let broken = false
beforeAll(async () => {
  await addPerson(CREATOR)
  await db.prepare('CREATE TABLE IF NOT EXISTS test_routine_results (slot_key TEXT PRIMARY KEY, found INTEGER NOT NULL)').run()
  handlers.test_result = {
    async run(slot, end, ctx) {
      if (broken) throw new Error('the handler is broken')
      await ctx.db.prepare('SELECT COUNT(*) AS n FROM test_routine_results').first()
      const found = (end.structuredOutput as { found?: number } | null)?.found
      if (typeof found !== 'number') return { statements: [], summary: null, failure: 'invalid_result' }
      return {
        statements: [ctx.db.prepare('INSERT INTO test_routine_results (slot_key, found) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(slot.slot_key, found)],
        summary: `Found ${found} things`,
      }
    },
  }
})
beforeEach(async () => {
  await fresh()
  await setZone('America/New_York')
  await setStage('Act')
  broken = false
})

async function started(h: Harness, kind = 'test_result'): Promise<{ id: string; turn: FakeTurn; slotKey: string }> {
  const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - MIN, kind }))
  await h.tick(SIX)
  const [turn] = h.runs.turns.values()
  return { id: r.id, turn, slotKey: (await slotsOf(r.id))[0].slot_key }
}

const results = async (slotKey: string) => (await db.prepare('SELECT found FROM test_routine_results WHERE slot_key = ?').bind(slotKey).all()).results
const notices = async () => (await db.prepare("SELECT audience, audience_member_id, template FROM notices WHERE source = 'routine-slot' ORDER BY audience").all()).results

describe('the end task id', () => {
  it('is one route 51 can name (TaskIdSchema), and gives the slot key back', () => {
    for (const key of ['rt_AAAAAAAAAAAAAAAAAAAAAA|2026-06-01|06:00', 'now|rt_AAAAAAAAAAAAAAAAAAAAAA|clientkey-1', 'routine-morning-check|2026-06-01|06:30']) {
      expect(TaskIdSchema.safeParse(endTaskId(key)).success, key).toBe(true)
      expect(slotKeyOfEndTask(endTaskId(key))).toBe(key)
    }
  })
})

describe('one batch, idempotent (test 11)', () => {
  it('a crash before each statement group leaves nothing; the re-delivery lands it once', async () => {
    // Calls of one delivery: the slot read (0), the handler's read (1), the batch (2).
    for (let crashAt = 0; crashAt <= 2; crashAt++) {
      await fresh()
      const h = harness()
      const { id, turn, slotKey } = await started(h)
      const w = wrapD1(db, async (_k, n) => {
        if (n === crashAt) throw new Crash()
      })
      await expect(h.end(turn, SIX + 5 * MIN, { structuredOutput: { found: 2 } }, w.db)).rejects.toThrow(Crash)
      expect((await slotsOf(id))[0].state, `crash at ${crashAt}`).toBe('started')
      expect(await results(slotKey)).toEqual([])
      expect(await linesOf(id)).toEqual([])
      await h.end(turn, SIX + 6 * MIN, { structuredOutput: { found: 2 } })
      await h.end(turn, SIX + 7 * MIN, { structuredOutput: { found: 2 } })
      const [s] = await slotsOf(id)
      expect([s.state, s.outcome, s.result_text, s.turn_id, s.ended_at_ms]).toEqual(['ended', 'done', 'Found 2 things', turn.turnId, SIX + 6 * MIN])
      expect(await results(slotKey)).toEqual([{ found: 2 }])
      expect((await linesOf(id)).map(l => [l.template, l.source_key, l.trace])).toEqual([['routine_ran', slotKey, turn.runId]])
      expect(await db.prepare('SELECT last_slot_key FROM routines WHERE id = ?').bind(id).first('last_slot_key')).toBe(slotKey)
    }
  })

  it('an end that arrives while the slot is still claimed (before the started update) still lands', async () => {
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - MIN, kind: 'test_result' }))
    const w = wrapD1(db)
    h.runs.afterSubmit = () => w.kill()
    await h.tick(SIX, undefined, w.db)
    expect((await slotsOf(r.id))[0].state).toBe('claimed')
    const [turn] = h.runs.turns.values()
    await h.end(turn, SIX + MIN, { structuredOutput: { found: 1 } })
    await h.tick(SIX + 2 * MIN)
    const [s] = await slotsOf(r.id)
    expect([s.state, s.turn_id, s.run_id]).toEqual(['ended', turn.turnId, turn.runId])
    expect(h.runs.turns.size).toBe(1)
  })

  it('an older end never takes `last` from a newer one', async () => {
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - MIN, kind: 'test_result' }))
    await h.tick(SIX)
    await h.tick(at('2026-06-02T10:00:00Z'))
    const [older, newer] = [...h.runs.turns.values()]
    const keys = (await slotsOf(r.id)).map(s => s.slot_key)
    await h.end(newer, at('2026-06-02T10:05:00Z'), { structuredOutput: { found: 3 } })
    await h.end(older, at('2026-06-02T10:06:00Z'), { structuredOutput: { found: 1 } })
    expect(await db.prepare('SELECT last_slot_key FROM routines WHERE id = ?').bind(r.id).first('last_slot_key')).toBe(keys[1])
  })

  it('a failure keeps P3’s code over the handler’s, writes a failed line and rings admins and the creator once', async () => {
    const h = harness()
    const { id, turn } = await started(h)
    await db.prepare("DELETE FROM notices WHERE source = 'routine-slot'").run()
    await h.end(turn, SIX + 5 * MIN, { outcome: 'failed', failure: 'structured_output' })
    await h.end(turn, SIX + 6 * MIN, { outcome: 'failed', failure: 'structured_output' })
    expect((await slotsOf(id)).map(s => [s.state, s.outcome, s.failure])).toEqual([['ended', 'failed', 'structured_output']])
    expect((await linesOf(id)).map(l => [l.template, l.fields_json])).toEqual([['routine_failed', '{"code":"structured_output"}']])
    expect((await notices()).map(n => [n.audience, n.audience_member_id, n.template])).toEqual([['admins', null, 'routine_failed'], ['member', CREATOR, 'routine_failed']])
  })

  it('a done end the handler finds invalid keeps the handler’s failure; not_connected rings no bell', async () => {
    const h = harness()
    const { id, turn } = await started(h)
    await db.prepare("DELETE FROM notices WHERE source = 'routine-slot'").run()
    await h.end(turn, SIX + 5 * MIN, { outcome: 'done', structuredOutput: null })
    expect((await slotsOf(id)).map(s => s.failure)).toEqual(['invalid_result'])
    expect((await notices()).length).toBe(2)

    await fresh()
    await db.prepare("DELETE FROM notices WHERE source = 'routine-slot'").run()
    const h2 = harness()
    const b = await started(h2)
    await h2.end(b.turn, SIX + 5 * MIN, { outcome: 'cancelled', failure: 'not_connected' })
    expect((await slotsOf(b.id)).map(s => s.failure)).toEqual(['not_connected'])
    expect(await notices()).toEqual([])
  })
})

describe('an exhausted end (test 14)', () => {
  it('a handler that always throws writes nothing; the slot closes lost and the signal is red; the revived task lands once', async () => {
    const h = harness()
    const { id, turn, slotKey } = await started(h)
    broken = true
    // Every delivery throws: P3's scheduler retries it until it is quarantined (10 attempts).
    for (let i = 0; i < 10; i++) await expect(h.end(turn, SIX + (i + 1) * MIN, { structuredOutput: { found: 4 } })).rejects.toThrow('broken')
    expect(await results(slotKey)).toEqual([])
    await h.tick(SIX + 46 * MIN)
    expect((await slotsOf(id)).map(s => [s.state, s.reason])).toEqual([['lost', 'no_end']])
    expect((await routinesSignal(db, SIX + 46 * MIN)).ok).toBe(false)
    // Deploy the fix, then revive: the same task with its payload kept byte for byte runs the same batch.
    broken = false
    await h.end(turn, SIX + 60 * MIN, { structuredOutput: { found: 4 } })
    await h.end(turn, SIX + 61 * MIN, { structuredOutput: { found: 4 } })
    expect((await slotsOf(id)).map(s => [s.state, s.result_text])).toEqual([['ended', 'Found 4 things']])
    expect(await results(slotKey)).toEqual([{ found: 4 }])
    expect((await linesOf(id)).map(l => l.template)).toEqual(['routine_lost', 'routine_ran'])
  })

  it('no W2 code pokes a routine-end id (poke drops the payload)', () => {
    const sources = import.meta.glob<string>(['../routines/**/*.ts', '../mcp/tools/routines/**/*.ts', '!../**/*.test.ts'], { query: '?raw', import: 'default', eager: true })
    expect(Object.keys(sources).length).toBeGreaterThan(5)
    for (const [file, text] of Object.entries(sources)) {
      for (const m of text.matchAll(/poke\s*\(([^)]*)\)/g)) expect(m[1], file).not.toMatch(/routine-end|END_KIND|endTaskId/)
    }
  })
})
