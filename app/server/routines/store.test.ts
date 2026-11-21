// A routine write and its Activity line commit together (#250 review, W4's rule: the line commits with the change it
// describes, or not at all). Ways it can fail, written down first: a line for a write that matched no row (a stale
// `ifRev`, someone else's routine); a write without its line; a failed batch that leaves the line, the audit line or the
// change behind; an error answered for a write that committed (a read after the commit).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRoutine, deleteRoutine, readRoutine, runNow, updateRoutine } from './store.ts'
import { addPerson, at, db, fresh, setStage, setZone } from './test-kit.ts'

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
