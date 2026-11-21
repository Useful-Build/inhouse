// 0141_search's backfill (p3-design section 10): triggers don't backfill, so rows written before the migration must be
// found after it. Ways it can fail: the migration's `'rebuild'` missing, or run before the triggers and tables exist.
// The fixture puts this file's database back to before 0141 (its virtual tables and triggers dropped), writes rows,
// then runs 0141's own statements as the test pool read them from the file (`TEST_MIGRATIONS`).
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const db = env.DB
const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS

describe('0141_search', () => {
  it('finds rows inserted before it ran', async () => {
    const m0141 = migrations.find(m => m.name.startsWith('0141_'))
    expect(m0141, 'the migration file').toBeDefined()
    await db.batch(['memories_fts_insert', 'memories_fts_delete', 'memories_fts_update', 'chat_messages_fts_insert', 'chat_messages_fts_delete', 'chat_messages_fts_update']
      .map(t => db.prepare(`DROP TRIGGER ${t}`)))
    await db.batch([db.prepare('DROP TABLE memories_fts'), db.prepare('DROP TABLE chat_messages_fts')])
    await db.batch([
      db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES ('m_old', 'person', 'member', 'active', 'Ola', 1)"),
      db.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES ('mem_old000000000000000000', 'person', 'm_old', 'Prefers invoices grouped by supplier', 'active', 'm_old', 1, 1)"),
      db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES ('c_old', 'm_old', 'Old chat', 1, 1)"),
      db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, text, at_ms) VALUES ('t_old.u', 'c_old', 'r_1', 't_old', 0, 'user', 'Which warehouse handles oversized parcels?', 1)"),
    ])
    await db.batch(m0141!.queries.map(q => db.prepare(q)))
    expect(await db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'grouped'").all()).toMatchObject({ results: [{ rowid: expect.any(Number) }] })
    expect((await db.prepare("SELECT m.id FROM memories_fts f JOIN memories m ON m.n = f.rowid WHERE memories_fts MATCH 'supplier'").all<{ id: string }>()).results).toEqual([{ id: 'mem_old000000000000000000' }])
    expect((await db.prepare("SELECT cm.id FROM chat_messages_fts f JOIN chat_messages cm ON cm.n = f.rowid WHERE chat_messages_fts MATCH 'oversized'").all<{ id: string }>()).results).toEqual([{ id: 't_old.u' }])
    // And the triggers it made keep new rows in step.
    await db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, text, at_ms) VALUES ('t_old.0', 'c_old', 'r_1', 't_old', 1, 'agent', 'The north warehouse does.', 2)").run()
    expect((await db.prepare("SELECT cm.id FROM chat_messages_fts f JOIN chat_messages cm ON cm.n = f.rowid WHERE chat_messages_fts MATCH 'north'").all<{ id: string }>()).results).toEqual([{ id: 't_old.0' }])
  })
})
