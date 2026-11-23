// The routines signal (p4-w2.md section 11; test 12), on literal states. Ways it can fail: a stopped heartbeat stays
// green; a missed system routine stays green; a clean day goes red; a slot waiting on a question turns it red.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SYSTEM_ROUTINE_DESCRIPTIONS, SYSTEM_ROUTINE_PROMPTS } from './prompts.ts'
import { routinesSignal } from './signal.ts'
import { MIN, addPerson, at, db, fresh, harness, insertRoutine, routine, setStage, setZone, slotsOf } from './test-kit.ts'

const CREATOR = 'm_w2_signal_creator'
const SIX = at('2026-06-01T10:00:00Z')

beforeAll(async () => {
  await addPerson(CREATOR)
  ;(SYSTEM_ROUTINE_PROMPTS as Record<string, string>)['test-signal-check'] = 'Run the check.'
  ;(SYSTEM_ROUTINE_DESCRIPTIONS as Record<string, string>)['test-signal-check'] = 'A test system routine.'
})
beforeEach(async () => {
  await fresh()
  await setZone('America/New_York')
  await setStage('Act')
})

describe('routinesSignal (test 12)', () => {
  it('a clean day is green: an ended run, a started one, a routine checked up to now', async () => {
    const h = harness()
    await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - MIN }))
    await h.tick(SIX)
    const [turn] = h.runs.turns.values()
    await h.end(turn, SIX + 5 * MIN)
    await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - MIN, hour: 6, minute: 3 }))
    await h.tick(SIX + 5 * MIN)
    expect(await routinesSignal(db, SIX + 6 * MIN)).toEqual({ ok: true })
  })

  it('a routine whose cursor is 16 minutes behind is red', async () => {
    await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - 16 * MIN }))
    expect(await routinesSignal(db, SIX)).toEqual({ ok: false, detail: '1 behind' })
    expect((await routinesSignal(db, SIX - MIN)).ok).toBe(true)
  })

  it('a missed morning-check (system routine) row is red; a team routine missing its time is not', async () => {
    const h = harness()
    const sys = await insertRoutine(routine({
      id: 'routine-test-signal', origin: 'system', prompt_ref: 'test-signal-check', need: 0, creator_id: 'm_system', checked_until_ms: SIX - 30 * MIN,
    }))
    await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - 30 * MIN }))
    await h.tick(SIX + 20 * MIN)
    expect((await slotsOf(sys.id)).map(s => s.state)).toEqual(['missed'])
    expect(await routinesSignal(db, SIX + 20 * MIN)).toEqual({ ok: false, detail: '1 system missed' })
  })

  it('a claimed row past its deadline is red', async () => {
    const h = harness()
    h.runs.refuse = () => ({ refused: { code: 'unavailable', reason: 'draining' } })
    await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - MIN }))
    await h.tick(SIX)
    await db.prepare('UPDATE routines SET checked_until_ms = ?').bind(SIX + 11 * MIN).run()
    expect(await routinesSignal(db, SIX + 11 * MIN)).toEqual({ ok: false, detail: '1 past deadline' })
  })

  it('an invalid zone stops deciding and is red', async () => {
    const h = harness()
    await setZone('Not/AZone')
    await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - MIN }))
    await h.tick(SIX)
    expect(h.runs.turns.size).toBe(0)
    const s = await routinesSignal(db, SIX)
    expect(s.ok).toBe(false)
    expect(s.detail).toContain('1 alarms')
  })

  it('a backstop lost (timeout) turns it red when it closes, 8 days after the start', async () => {
    const h = harness()
    const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - MIN }))
    await h.tick(SIX)
    await db.prepare('UPDATE routines SET enabled = 0 WHERE id = ?').bind(r.id).run()
    const [turn] = h.runs.turns.values()
    h.status.set(turn.chatId, { waiting: true, liveRunId: null })
    const late = SIX + 8 * 24 * 60 * MIN + MIN
    await h.tick(late)
    expect((await slotsOf(r.id)).map(s => [s.state, s.reason])).toEqual([['lost', 'timeout']])
    expect(await routinesSignal(db, late)).toEqual({ ok: false, detail: '1 failed or lost' })
  })

  it('an end with not_connected (W3\'s quiet case) stays green; another failure is red', async () => {
    const h = harness()
    await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - MIN }))
    await h.tick(SIX)
    const [turn] = h.runs.turns.values()
    await h.end(turn, SIX + 5 * MIN, { outcome: 'done', failure: 'not_connected' })
    expect(await routinesSignal(db, SIX + 6 * MIN)).toEqual({ ok: true })
    await db.prepare("UPDATE routine_slots SET failure = 'run_failed'").run()
    expect(await routinesSignal(db, SIX + 6 * MIN)).toEqual({ ok: false, detail: '1 failed or lost' })
  })
})
