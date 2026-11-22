// A routine write and its Activity line commit together (#250 review, W4's rule: the line commits with the change it
// describes, or not at all). Ways it can fail, written down first: a line for a write that matched no row (a stale
// `ifRev`, someone else's routine); a write without its line; a failed batch that leaves the line, the audit line or the
// change behind; an error answered for a write that committed (a read after the commit).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRoutine, deleteRoutine, readRoutine, restoreRoutine, runNow, updateRoutine } from './store.ts'
import { addPerson, at, db, fresh, insertRoutine, routine, setStage, setZone } from './test-kit.ts'
import { MAX_TEAM_ROUTINES } from '../../shared/contract/keys.ts'

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
