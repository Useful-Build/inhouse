// Activity's store (0230 and `recordActivity`), in the Workers runtime on the real migrations. Ways it can fail:
//  1. an UPDATE of a line goes through (the trigger), or a repeat of one (source, key) writes a second line;
//  2. a producer's batch that fails leaves its Activity line behind (the line must commit with the change or not at all);
//  3. a refused line is written, or a line holds a member's name (a raw dump scan, with the seeded names as the oracle).
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { recordActivity } from './store.ts'

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
})
