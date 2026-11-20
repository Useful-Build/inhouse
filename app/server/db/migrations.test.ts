// The migrations as applied (server/testing/apply-migrations.ts runs every file in server/migrations/). Ways it can
// fail, written down first:
//  1. the health route's list of shipped migrations misses a file (its migration signal would pass with one unapplied);
//     P3 PR0 retired latest.ts for that list (p3-design section 11);
//  2. the audit log can be edited or shortened: an UPDATE or a DELETE, from a handler or a migration-shaped statement;
//  3. the service rows are missing or have no fixed ids;
//  4. the members table takes a row the design forbids (a person with no role, a service row with no name, two open
//     rows for one email).
import { env } from 'cloudflare:workers'
import type { D1Migration } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { SHIPPED_MIGRATIONS } from '../ops/signals/core.ts'

const db = env.DB
const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS

describe('the shipped migrations (failure 1)', () => {
  it('are every file the test pool applies (read by @cloudflare/vitest-plugin, not by the signal)', async () => {
    const names = migrations.map(m => m.name.replace(/\.sql$/, '')).sort()
    expect(names).toEqual(expect.arrayContaining(['0001_members', '0002_settings', '0003_support_grants', '0004_audit_log', '0005_service_rows']))
    expect(SHIPPED_MIGRATIONS).toEqual(names)
  })
})

describe('the audit log is append-only (failure 2)', () => {
  const line = () => db.prepare("INSERT INTO audit_log (at_ms, actor_id, action, args_json, req_id) VALUES (1, 'm_system', 'grant.expired', '{}', 'r')").run()

  it('refuses UPDATE and DELETE, the row stays as written', async () => {
    const { meta } = await line()
    const id = meta.last_row_id
    await expect(db.prepare("UPDATE audit_log SET action = 'x' WHERE id = ?").bind(id).run()).rejects.toThrow(/append-only/)
    await expect(db.prepare('DELETE FROM audit_log WHERE id = ?').bind(id).run()).rejects.toThrow(/append-only/)
    expect(await db.prepare('SELECT action FROM audit_log WHERE id = ?').bind(id).first('action')).toBe('grant.expired')
  })

  it('refuses a migration-shaped statement: a whole-table DELETE or UPDATE in a batch rolls the batch back', async () => {
    await line()
    const before = await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<number>('n')
    await expect(db.batch([db.prepare("UPDATE members SET name = 'x' WHERE id = 'm_smoke'"), db.prepare('DELETE FROM audit_log')])).rejects.toThrow(/append-only/)
    await expect(db.exec('UPDATE audit_log SET args_json = NULL')).rejects.toThrow(/append-only/)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<number>('n')).toBe(before)
    expect(await db.prepare("SELECT name FROM members WHERE id = 'm_smoke'").first('name')).toBe('Smoke check')
  })

  it('refuses an insert onto an existing id (REPLACE INTO, INSERT OR REPLACE); a new line still goes in', async () => {
    const { meta } = await line()
    const id = meta.last_row_id
    for (const verb of ['REPLACE INTO', 'INSERT OR REPLACE INTO']) {
      await expect(db.prepare(`${verb} audit_log (id, at_ms, actor_id, action, args_json, req_id) VALUES (?, 2, 'm_system', 'x', '{}', 'r2')`).bind(id).run()).rejects.toThrow(/append-only/)
    }
    await expect(db.prepare("INSERT INTO audit_log (id, at_ms, actor_id, action, args_json, req_id) VALUES (?, 2, 'm_system', 'x', '{}', 'r2') ON CONFLICT(id) DO UPDATE SET action = excluded.action").bind(id).run()).rejects.toThrow(/append-only/)
    expect(await db.prepare('SELECT action FROM audit_log WHERE id = ?').bind(id).first('action')).toBe('grant.expired')
    const next = await line()
    expect(next.meta.last_row_id).toBeGreaterThan(id)
    expect((await db.prepare('INSERT INTO audit_log (id, at_ms, actor_id, action, req_id) VALUES (?, 1, ?, ?, ?)').bind(next.meta.last_row_id + 10, 'm_system', 'grant.expired', 'r').run()).meta.changes).toBe(1)
  })

  it('refuses an explicit id of 0 or below (edited in place: 0004 is not deployed anywhere); a normal insert still works', async () => {
    for (const id of [0, -1]) {
      await expect(db.prepare("INSERT INTO audit_log (id, at_ms, actor_id, action, req_id) VALUES (?, 1, 'm_system', 'grant.expired', 'r')").bind(id).run()).rejects.toThrow(/CHECK/)
    }
    expect((await line()).meta.changes).toBe(1)
  })

  it('names its actor by a member row (foreign key)', async () => {
    await expect(db.prepare("INSERT INTO audit_log (at_ms, actor_id, action, req_id) VALUES (1, 'm_nobody', 'grant.expired', 'r')").run()).rejects.toThrow(/FOREIGN KEY/)
  })
})

describe('the service rows (failure 3)', () => {
  it('has system and smoke with fixed ids', async () => {
    const rows = await db.prepare("SELECT id, kind, role, status, service_name FROM members WHERE kind = 'service' ORDER BY id").all()
    expect(rows.results).toEqual([
      { id: 'm_smoke', kind: 'service', role: 'member', status: 'active', service_name: 'smoke' },
      { id: 'm_system', kind: 'service', role: null, status: 'active', service_name: 'system' },
    ])
  })
})

describe('the members table refuses what the design forbids (failure 4)', () => {
  const insert = (cols: string, values: string) => db.prepare(`INSERT INTO members (${cols}, created_at_ms) VALUES (${values}, 1)`).run()

  it('a person needs a role, an inhouse row has none, a service row needs its name', async () => {
    await expect(insert('id, kind, status', "'m_p1', 'person', 'invited'")).rejects.toThrow(/CHECK/)
    await expect(insert('id, kind, role, status', "'m_i1', 'inhouse', 'admin', 'active'")).rejects.toThrow(/CHECK/)
    await expect(insert('id, kind, status', "'m_s1', 'service', 'active'")).rejects.toThrow(/CHECK/)
    await expect(insert('id, kind, role, status, service_name', "'m_s2', 'service', 'member', 'active', 'smoke'")).rejects.toThrow(/UNIQUE/)
  })

  it('two open person rows can not share an email; a removed one can', async () => {
    await insert('id, kind, role, status, email_norm', "'m_e1', 'person', 'member', 'removed', 'pat@example.test'")
    await insert('id, kind, role, status, email_norm', "'m_e2', 'person', 'member', 'invited', 'pat@example.test'")
    await expect(insert('id, kind, role, status, email_norm', "'m_e3', 'person', 'member', 'active', 'pat@example.test'")).rejects.toThrow(/UNIQUE/)
  })
})
