// Activity's store (0230 and `recordActivity`), in the Workers runtime on the real migrations. Ways it can fail:
//  1. an UPDATE of a line goes through (the trigger), or a repeat of one (source, key) writes a second line;
//  2. a producer's batch that fails leaves its Activity line behind (the line must commit with the change or not at all);
//  3. a refused line is written, or a line holds a member's name (a raw dump scan, with the seeded names as the oracle);
//  4. a CHECK or NOT NULL failure is swallowed (the batch must abort), as INSERT OR IGNORE would.
//  5. (P4 W2, #250) a guarded line is written when its guard is false, missing when it is true, or left behind by a
//     failed batch; or the guard's params shift the line's own values.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { ACTIVITY_INSERT_SQL, guardedInsertSql, recordActivity } from './store.ts'

const db = env.DB
const NAME = 'Dana Fixture-Kim'
const count = async (source: string) => (await db.prepare('SELECT COUNT(*) AS c FROM activity_lines WHERE source = ?').bind(source).first<number>('c')) ?? -1

const seed = () => db.batch([
  db.prepare("INSERT OR IGNORE INTO members (id, kind, role, status, name, created_at_ms) VALUES ('m_dana', 'person', 'admin', 'active', ?, 1)").bind(NAME),
])

describe('activity_lines', () => {
  it('refuses an UPDATE, and a repeated (source, key) leaves one line (failure 1)', async () => {
    await seed()
    const line = { template: 'routine_made', fields: {}, kind: 'change', actorId: 'm_dana', atMs: 10 } as const
    await db.batch([recordActivity(db, line, { source: 'routine', key: 'k-once' })])
    await db.batch([recordActivity(db, line, { source: 'routine', key: 'k-once' }), recordActivity(db, line, { source: 'routine', key: 'k-once' })])
    expect(await count('routine')).toBe(1)
    await expect(db.prepare("UPDATE activity_lines SET kind = 'problem'").run()).rejects.toThrow(/append-only/)
    await expect(db.prepare("UPDATE activity_lines SET actor_id = NULL WHERE source = 'routine'").run()).rejects.toThrow(/append-only/)
  })

  it("a producer's batch that fails leaves no line (failure 2)", async () => {
    await seed()
    const before = await count('library')
    const line = { template: 'library_deleted', fields: {}, kind: 'change', actorId: 'm_dana', atMs: 11 } as const
    await expect(db.batch([
      recordActivity(db, line, { source: 'library', key: 'k-rollback' }),
      db.prepare("INSERT INTO members (id, kind, status, created_at_ms) VALUES ('m_bad', 'nope', 'active', 1)"),
    ])).rejects.toThrow()
    expect(await count('library')).toBe(before)
  })

  it('a CHECK failure aborts the batch instead of vanishing (failure 4)', async () => {
    await seed()
    const sqlText = ACTIVITY_INSERT_SQL
    expect(sqlText).toContain('ON CONFLICT (source, source_key) DO NOTHING')
    // kind and min_stage outside their CHECKs, bound straight to the writer's statement, must throw, not skip the row.
    await expect(db.prepare(sqlText).bind('a_x1', 1, 'bogus', null, 't', '{}', null, null, null, 's', 'k1').run()).rejects.toThrow(/CHECK/)
    await expect(db.prepare(sqlText).bind('a_x2', 1, 'read', 9, 't', '{}', null, null, null, 's', 'k2').run()).rejects.toThrow(/CHECK/)
    await expect(db.prepare(sqlText).bind('a_x3', 1, 'read', null, null, '{}', null, null, null, 's', 'k3').run()).rejects.toThrow(/NOT NULL/)
    expect(await count('s')).toBe(0)
  })

  it('refuses a bad line before anything is built, and an unknown member fails the batch (failure 3)', async () => {
    await seed()
    expect(() => recordActivity(db, { template: 'routine_failed', fields: { code: NAME }, kind: 'problem', atMs: 1 }, { source: 'routine-slot', key: 'k' })).toThrow()
    await expect(db.batch([recordActivity(db, { template: 'routine_made', fields: {}, kind: 'change', actorId: 'm_nobody', atMs: 1 }, { source: 'routine', key: 'k-fk' })])).rejects.toThrow()
    await db.batch([recordActivity(db, { template: 'routine_failed', fields: { code: 'run_failed' }, kind: 'problem', minStage: 1, trace: 'r_1', atMs: 12 }, { source: 'routine-slot', key: 'k-ok' })])
    const dump = JSON.stringify((await db.prepare('SELECT * FROM activity_lines').all()).results)
    expect(dump).not.toContain(NAME)
    expect(dump).not.toContain('Dana')
    const row = await db.prepare("SELECT min_stage, trace, fields_json, actor_id FROM activity_lines WHERE source_key = 'k-ok'").first()
    expect(row).toEqual({ min_stage: 1, trace: 'r_1', fields_json: '{"code":"run_failed"}', actor_id: null })
  })

  it('a guarded line follows its guard, in the same batch (failure 5)', async () => {
    await seed()
    await db.prepare('CREATE TABLE IF NOT EXISTS guard_probe (id TEXT PRIMARY KEY, n INTEGER NOT NULL)').run()
    const line = { template: 'routine_changed', fields: {}, kind: 'change', actorId: 'm_dana', atMs: 20 } as const
    const keyed = async (key: string) => (await db.prepare("SELECT template, actor_id, at_ms, source_key FROM activity_lines WHERE source = 'routine' AND source_key = ?").bind(key).all()).results
    const guard = { sql: 'EXISTS (SELECT 1 FROM guard_probe WHERE id = ? AND n = ?)', params: ['p1', 2] }
    // The write matches a row: the line is there, with its own values (the guard's params come after them).
    await db.prepare("INSERT INTO guard_probe (id, n) VALUES ('p1', 1)").run()
    await db.batch([db.prepare("UPDATE guard_probe SET n = 2 WHERE id = 'p1' AND n = 1"), recordActivity(db, line, { source: 'routine', key: 'g-hit' }, guard)])
    expect(await keyed('g-hit')).toEqual([{ template: 'routine_changed', actor_id: 'm_dana', at_ms: 20, source_key: 'g-hit' }])
    // A 0-row write: no line.
    await db.batch([db.prepare("UPDATE guard_probe SET n = 2 WHERE id = 'p1' AND n = 99"), recordActivity(db, line, { source: 'routine', key: 'g-miss' }, { ...guard, params: ['p1', 3] })])
    expect(await keyed('g-miss')).toEqual([])
    // A failed batch leaves neither the change nor the line.
    await expect(db.batch([
      db.prepare("UPDATE guard_probe SET n = 3 WHERE id = 'p1'"),
      recordActivity(db, line, { source: 'routine', key: 'g-fail' }, { ...guard, params: ['p1', 3] }),
      db.prepare("INSERT INTO members (id, kind, status, created_at_ms) VALUES ('m_bad2', 'nope', 'active', 1)"),
    ])).rejects.toThrow()
    expect(await keyed('g-fail')).toEqual([])
    expect(await db.prepare("SELECT n FROM guard_probe WHERE id = 'p1'").first('n')).toBe(2)
    expect(guardedInsertSql('1 = 1')).toMatch(/ SELECT \?(, \?){10} WHERE 1 = 1 ON CONFLICT \(source, source_key\) DO NOTHING$/)
  })
})
