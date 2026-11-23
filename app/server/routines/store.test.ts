// A routine write and its Activity line commit together (#250 review, W4's rule: the line commits with the change it
// describes, or not at all). Ways it can fail, written down first: a line for a write that matched no row (a stale
// `ifRev`, someone else's routine); a write without its line; a failed batch that leaves the line, the audit line or the
// change behind; an error answered for a write that committed (a read after the commit).
import fc from 'fast-check'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRoutine, deleteRoutine, readRoutine, restoreRoutine, resultWords, routineRuns, runNow, runOutcome, updateRoutine } from './store.ts'
import type { SlotState } from './rows.ts'
import { MIN, addPerson, at, db, fresh, insertRoutine, insertSlot, routine, setStage, setZone } from './test-kit.ts'
import { MAX_TEAM_ROUTINES, ROUTINE_RUN_OUTCOMES } from '../../shared/contract/keys.ts'

const ALEX = 'm_w2_store_alex'
const SAM = 'm_w2_store_sam'
const NOW = at('2026-06-01T12:00:00Z')
let n = 0
const by = (actorId: string) => ({ actorId, requestId: `req-store-${++n}`, nowMs: NOW })
const NEW = { name: 'Stock', instruction: 'Check stock.', days_mask: 31, hour: 6, minute: 0, missed: 'skip' as const }

const lines = async (id: string) =>
  (await db.prepare("SELECT template, actor_id, source_key FROM activity_lines WHERE source = 'routine' AND source_key LIKE ? ORDER BY at_ms, source_key").bind(`${id}|%`).all()).results
const audits = async (id: string) => (await db.prepare('SELECT action FROM audit_log WHERE target_id = ? ORDER BY id').bind(id).all<{ action: string }>()).results.map(a => a.action)

/** The D1 whose every batch fails at its end (a statement that breaks a CHECK), after the producer's own statements ran. */
const failingBatches: D1Database = {
  prepare: (q: string) => db.prepare(q),
  batch: (stmts: D1PreparedStatement[]) => db.batch([...stmts, db.prepare("INSERT INTO members (id, kind, status, created_at_ms) VALUES ('m_w2_bad', 'nope', 'active', 1)")]),
} as unknown as D1Database

beforeAll(async () => {
  await addPerson(ALEX)
  await addPerson(SAM)
})
beforeEach(async () => {
  await fresh()
  await setZone('America/New_York')
  await setStage('Act')
})

describe('a write and its Activity line, in one batch', () => {
  it('create: the line commits with the routine; a failed batch leaves neither the routine nor the line', async () => {
    const made = await createRoutine(db, NEW, by(ALEX), null)
    if (!('ok' in made)) throw new Error('not made')
    expect(await lines(made.ok.id)).toEqual([{ template: 'routine_made', actor_id: ALEX, source_key: `${made.ok.id}|created` }])
    await expect(createRoutine(failingBatches, NEW, by(ALEX), null)).rejects.toThrow()
    expect(await db.prepare('SELECT COUNT(*) AS n FROM routines').first('n')).toBe(1)
    expect(await db.prepare("SELECT COUNT(*) AS n FROM activity_lines WHERE source = 'routine' AND actor_id = ? AND source_key NOT LIKE ?").bind(ALEX, `${made.ok.id}|%`).first('n')).toBe(0)
  })

  it('update and delete: a line exactly when the write matched; none for a stale ifRev or someone else’s routine', async () => {
    const made = await createRoutine(db, NEW, by(ALEX), null)
    if (!('ok' in made)) throw new Error('not made')
    const id = made.ok.id
    expect(await updateRoutine(db, id, 7, { hour: 8 }, by(ALEX))).toMatchObject({ conflict: { rev: 1 } })
    expect(await updateRoutine(db, id, 1, { hour: 8 }, by(SAM))).toEqual({ refused: 'not_allowed' })
    expect(await deleteRoutine(db, id, 1, by(SAM))).toEqual({ refused: 'not_allowed' })
    expect((await lines(id)).map(l => l.template)).toEqual(['routine_made'])
    expect(await audits(id)).toEqual(['routine.created'])

    const u = await updateRoutine(db, id, 1, { hour: 8, enabled: false }, by(ALEX))
    expect(u).toMatchObject({ ok: { rev: 2, hour: 8, enabled: 0 } })
    const d = await deleteRoutine(db, id, 2, by(ALEX))
    expect(d).toMatchObject({ ok: { rev: 3 } })
    expect((await lines(id)).map(l => [l.template, l.source_key])).toEqual([['routine_made', `${id}|created`], ['routine_changed', `${id}|rev2`], ['routine_deleted', `${id}|rev3`]])
    expect(await audits(id)).toEqual(['routine.created', 'routine.updated', 'routine.enabled', 'routine.deleted'])
  })

  it('a failed update or delete batch leaves neither the change, the audit line nor the Activity line', async () => {
    const made = await createRoutine(db, NEW, by(ALEX), null)
    if (!('ok' in made)) throw new Error('not made')
    const id = made.ok.id
    await expect(updateRoutine(failingBatches, id, 1, { hour: 9 }, by(ALEX))).rejects.toThrow()
    await expect(deleteRoutine(failingBatches, id, 1, by(ALEX))).rejects.toThrow()
    expect(await readRoutine(db, id)).toMatchObject({ rev: 1, hour: 6, deleted_at_ms: null })
    expect((await lines(id)).map(l => l.template)).toEqual(['routine_made'])
    expect(await audits(id)).toEqual(['routine.created'])
  })

  it('runNow refuses a client key that could break the end id (a ".")', async () => {
    const made = await createRoutine(db, NEW, by(ALEX), null)
    if (!('ok' in made)) throw new Error('not made')
    await expect(runNow(db, made.ok.id, 'key.with.dots', by(ALEX))).rejects.toThrow('client key')
  })
})

// #312 review M2: a brand's live team routines are capped. Ways it can fail: the 51st is made; a system routine or a deleted
// one counts against the cap; a refused create leaves an audit or Activity line behind.
describe('the cap on live team routines', () => {
  it('50 are made, the 51st is refused and writes nothing; system routines do not count; a delete frees a slot', async () => {
    expect(MAX_TEAM_ROUTINES).toBe(50)
    await insertRoutine(routine({ origin: 'system', kind: 'morning_check', prompt_ref: 'morning-check', need: 0, creator_id: 'm_system', checked_until_ms: NOW }))
    const ids: string[] = []
    for (let i = 0; i < 50; i++) {
      const made = await createRoutine(db, NEW, by(ALEX), null)
      if (!('ok' in made)) throw new Error(`routine ${i + 1} not made`)
      ids.push(made.ok.id)
    }
    const auditsBefore = await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first('n')
    const linesBefore = await db.prepare('SELECT COUNT(*) AS n FROM activity_lines').first('n')
    expect(await createRoutine(db, NEW, by(ALEX), null)).toEqual({ refused: 'routine_limit' })
    expect(await db.prepare("SELECT COUNT(*) AS n FROM routines WHERE origin = 'team'").first('n')).toBe(50)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first('n')).toBe(auditsBefore)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM activity_lines').first('n')).toBe(linesBefore)

    expect(await deleteRoutine(db, ids[0], 1, by(ALEX))).toMatchObject({ ok: { rev: 2 } })
    expect(await createRoutine(db, NEW, by(ALEX), null)).toMatchObject({ ok: { origin: 'team' } })
    expect(await createRoutine(db, NEW, by(ALEX), null)).toEqual({ refused: 'routine_limit' })
  })
})

describe('the cap on restore (route 56)', () => {
  it('at 50 live a restore is refused and writes nothing; at 49 it succeeds; a system routine restores whatever the count', async () => {
    const ids: string[] = []
    for (let i = 0; i < 50; i++) {
      const made = await createRoutine(db, NEW, by(ALEX), null)
      if (!('ok' in made)) throw new Error(`routine ${i + 1} not made`)
      ids.push(made.ok.id)
    }
    expect(await deleteRoutine(db, ids[0], 1, by(ALEX))).toMatchObject({ ok: { rev: 2 } })
    const refill = await createRoutine(db, NEW, by(ALEX), null)
    if (!('ok' in refill)) throw new Error('refill not made')
    const auditsBefore = await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first('n')
    const linesBefore = await db.prepare('SELECT COUNT(*) AS n FROM activity_lines').first('n')
    expect(await restoreRoutine(db, ids[0], 2, by(ALEX))).toEqual({ refused: 'routine_limit' })
    expect(await readRoutine(db, ids[0])).toMatchObject({ rev: 2, deleted_at_ms: NOW })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first('n')).toBe(auditsBefore)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM activity_lines').first('n')).toBe(linesBefore)
    const sys = await insertRoutine(routine({ origin: 'system', kind: 'morning_check', prompt_ref: 'morning-check', need: 0, creator_id: ALEX, checked_until_ms: NOW, deleted_at_ms: NOW }))
    expect(await restoreRoutine(db, sys.id, 1, by(ALEX))).toMatchObject({ ok: { rev: 2, deleted_at_ms: null } })

    expect(await deleteRoutine(db, ids[1], 1, by(ALEX))).toMatchObject({ ok: { rev: 2 } })
    expect(await restoreRoutine(db, ids[0], 2, by(ALEX))).toMatchObject({ ok: { rev: 3, deleted_at_ms: null } })
  })
})

// #312 review L3: a system routine runs its `prompt_ref`, never its instruction. Ways it can fail: an instruction edit is
// answered as a success and audited though it changes nothing that runs; the refusal also blocks its schedule or switch.
describe('a system routine', () => {
  it('refuses an instruction edit and writes nothing; its schedule and switch stay editable', async () => {
    const admin = await addPerson('m_w2_store_admin', 'admin')
    const sys = await insertRoutine(routine({ origin: 'system', kind: 'morning_check', prompt_ref: 'morning-check', need: 0, creator_id: 'm_system', checked_until_ms: NOW }))
    expect(await updateRoutine(db, sys.id, 1, { instruction: 'Do something else.' }, by(admin))).toEqual({ refused: 'system_instruction' })
    expect(await updateRoutine(db, sys.id, 1, { instruction: 'Do something else.', hour: 7 }, by(admin))).toEqual({ refused: 'system_instruction' })
    expect(await readRoutine(db, sys.id)).toMatchObject({ rev: 1, hour: 6, instruction: sys.instruction })
    expect(await audits(sys.id)).toEqual([])
    expect(await updateRoutine(db, sys.id, 1, { hour: 7, enabled: false }, by(admin))).toMatchObject({ ok: { rev: 2, hour: 7, enabled: 0 } })
    expect(await audits(sys.id)).toEqual(['routine.updated', 'routine.enabled'])
  })
})

// Route 68's read (master plan decision 8). Ways it can fail, written down first: another routine's slots get in; the
// order isn't newest first by (local_date, claimed_at_ms) (a catch-up claimed late for an earlier day sorts above a
// later day); more than the cap comes back; an unknown (another brand's) or deleted routine answers runs instead of
// null; a routine with no runs answers null; a person reads a failure or refusal code instead of plain words.
describe('a routine\'s runs (route 68)', () => {
  it('answers only its own slots, newest first by (local_date, claimed_at_ms), at most the limit', async () => {
    const a = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW }))
    const b = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW }))
    const days = Array.from({ length: 24 }, (_, i) => `2026-05-${String(i + 1).padStart(2, '0')}`)
    for (const [i, d] of days.entries()) await insertSlot({ routine_id: a.id, local_date: d, claimed_at_ms: NOW - (30 - i) * 1440 * MIN })
    // A catch-up for May 24 claimed after May 25's run, and a Run now on May 25 after its scheduled run.
    await insertSlot({ routine_id: a.id, local_date: '2026-05-25', claimed_at_ms: NOW - 2 * MIN, kind: 'scheduled' })
    const late = await insertSlot({ routine_id: a.id, local_date: '2026-05-24', claimed_at_ms: NOW - MIN })
    const manual = await insertSlot({ routine_id: a.id, local_date: '2026-05-25', claimed_at_ms: NOW, kind: 'manual', slot_key: `now|${a.id}|key-12345678` })
    await insertSlot({ routine_id: b.id, local_date: '2026-05-30', claimed_at_ms: NOW })

    const runs = (await routineRuns(db, a.id, 20))!
    expect(runs).toHaveLength(20)
    expect(runs[0].kind).toBe('manual')
    expect(runs[0].due_at_ms).toBe(manual.due_at_ms)
    expect(runs[1].due_at_ms).toBe(NOW - 2 * MIN)
    // May 24's late catch-up sorts by its day: below May 25's runs though it was claimed after one of them.
    expect(runs[2].due_at_ms).toBe(late.due_at_ms)
    expect(runs[3].due_at_ms).toBe(NOW - 7 * 1440 * MIN)
    expect((await routineRuns(db, a.id, 3))!.map(r => r.due_at_ms)).toEqual(runs.slice(0, 3).map(r => r.due_at_ms))
    expect((await routineRuns(db, b.id, 20))!).toHaveLength(1)
  })

  it('a routine with no runs answers none; an unknown routine (another brand\'s: each brand has its own D1) or a deleted one answers null', async () => {
    const quiet = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW }))
    expect(await routineRuns(db, quiet.id, 20)).toEqual([])
    expect(await routineRuns(db, 'rt_OtherBrandAAAAAAAAAAAA', 20)).toBeNull()
    const gone = await insertRoutine(routine({ creator_id: ALEX, checked_until_ms: NOW, deleted_at_ms: NOW - 1 }))
    await insertSlot({ routine_id: gone.id, local_date: '2026-05-31', claimed_at_ms: NOW - MIN })
    expect(await routineRuns(db, gone.id, 20)).toBeNull()
  })

  it('says each state in plain words and the closed outcome list', () => {
    const row = (state: SlotState, o: Partial<{ outcome: string | null; failure: string | null; reason: string | null; result_text: string | null }> = {}) =>
      ({ state, outcome: null, failure: null, reason: null, result_text: null, ...o })
    const cases: [ReturnType<typeof row>, string, string][] = [
      [row('claimed'), 'running', "It's running"],
      [row('started'), 'running', "It's running"],
      [row('ended', { outcome: 'done' }), 'done', 'It finished'],
      [row('ended', { outcome: 'done', result_text: 'Found 3 things (fixed: 1 cut)' }), 'done', 'Found 3 things'],
      [row('ended', { outcome: 'failed', failure: 'run_failed' }), 'failed', 'It stopped before it finished'],
      [row('ended', { outcome: 'done', failure: 'not_connected', result_text: 'Shopify isn\'t connected' }), 'failed', 'Shopify isn\'t connected'],
      [row('ended', { outcome: 'stopped' }), 'failed', 'It was stopped before it finished'],
      [row('lost', { reason: 'no_end' }), 'failed', 'It stopped before it finished'],
      [row('missed', { reason: 'late' }), 'skipped', 'It missed its time'],
      [row('skipped', { reason: 'disabled' }), 'skipped', 'It was off at its time'],
      [row('skipped', { reason: 'stage' }), 'skipped', 'It starts at a later stage'],
      [row('skipped', { reason: 'chat_deleted' }), 'skipped', 'It was skipped'],
      [row('refused', { reason: 'paused' }), 'skipped', 'Your agent was paused'],
      [row('refused', { reason: 'cap_reached' }), 'failed', 'The spending cap was reached'],
      [row('refused', { reason: 'model_off' }), 'failed', "It couldn't start"],
    ]
    for (const [s, outcome, words] of cases) {
      expect(runOutcome(s), JSON.stringify(s)).toBe(outcome)
      expect(resultWords(s), JSON.stringify(s)).toBe(words)
    }
  })

  it('never shows a failure or refusal code: with no result text the words are fixed, whatever the code', () => {
    const states: SlotState[] = ['claimed', 'started', 'ended', 'lost', 'missed', 'skipped', 'refused']
    const code = fc.stringMatching(/^[a-z][a-z0-9_]{5,30}$/)
    const fixed = new Set(["It's running", 'It finished', 'It stopped before it finished', 'It was stopped before it finished', 'It missed its time',
      'It was off at its time', 'It starts at a later stage', 'It was skipped', 'Your agent was paused', 'The spending cap was reached', "It couldn't start"])
    fc.assert(fc.property(fc.constantFrom(...states), fc.option(code), fc.option(code), fc.option(code), (state, outcome, failure, reason) => {
      const s = { state, outcome, failure, reason, result_text: null }
      expect(fixed.has(resultWords(s))).toBe(true)
      expect(ROUTINE_RUN_OUTCOMES).toContain(runOutcome(s))
    }))
  })
})
