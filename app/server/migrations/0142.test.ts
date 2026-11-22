// 0142_search_stemming on a live database (eval R02). Ways it can fail: the base tables lose rows; the rebuild is
// missing, so rows written before it aren't found; the triggers stop keeping the new indexes in step; the new tables
// don't stem. The fixture puts the indexes back to 0141's (its tables and triggers dropped, then 0141's own statements
// run as the test pool read them from the file), writes rows, checks the bug is there, then runs 0142's statements.
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const db = env.DB
const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS
const factIds = async (q: string) =>
  (await db.prepare('SELECT m.id FROM memories_fts f JOIN memories m ON m.n = f.rowid WHERE memories_fts MATCH ? ORDER BY m.id').bind(q).all<{ id: string }>()).results.map(r => r.id)
const messageIds = async (q: string) =>
  (await db.prepare('SELECT cm.id FROM chat_messages_fts f JOIN chat_messages cm ON cm.n = f.rowid WHERE chat_messages_fts MATCH ? ORDER BY cm.id').bind(q).all<{ id: string }>()).results.map(r => r.id)
const count = async (table: string) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n

describe('0142_search_stemming', () => {
  it('stems both indexes, keeps every base row and finds rows written before it', async () => {
    const m0141 = migrations.find(m => m.name.startsWith('0141_'))
    const m0142 = migrations.find(m => m.name.startsWith('0142_'))
    expect(m0141, 'the 0141 file').toBeDefined()
    expect(m0142, 'the 0142 file').toBeDefined()
    await db.batch(['memories_fts_insert', 'memories_fts_delete', 'memories_fts_update', 'chat_messages_fts_insert', 'chat_messages_fts_delete', 'chat_messages_fts_update']
      .map(t => db.prepare(`DROP TRIGGER ${t}`)))
    await db.batch([db.prepare('DROP TABLE memories_fts'), db.prepare('DROP TABLE chat_messages_fts')])
    await db.batch(m0141!.queries.map(q => db.prepare(q)))
    await db.batch([
      db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES ('m_live', 'person', 'member', 'active', 'Lee', 1)"),
      db.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES ('mem_live00000000000000000', 'brand', NULL, 'Returns are accepted within 45 days', 'active', 'm_live', 1, 1)"),
      db.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES ('mem_live00000000000000001', 'person', 'm_live', 'Lee prefers shipping on Tuesdays', 'active', 'm_live', 1, 1)"),
      db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES ('c_live', 'm_live', 'Live chat', 1, 1)"),
      db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, text, at_ms) VALUES ('t_live.u', 'c_live', 'r_1', 't_live', 0, 'user', 'Were the parcels returned yet?', 1)"),
    ])
    // The bug, under 0141's tokenizer: another form of the word finds nothing.
    expect(await factIds('"return"')).toEqual([])
    expect(await messageIds('"return"')).toEqual([])
    const before = { memories: await count('memories'), chat_messages: await count('chat_messages') }

    await db.batch(m0142!.queries.map(q => db.prepare(q)))

    expect({ memories: await count('memories'), chat_messages: await count('chat_messages') }).toEqual(before)
    // The rebuilt index holds one entry per row (its docsize shadow table; counting the FTS table reads its source).
    expect(await count('memories_fts_docsize')).toBe(before.memories)
    expect(await count('chat_messages_fts_docsize')).toBe(before.chat_messages)
    for (const t of ['memories_fts', 'chat_messages_fts']) {
      const sql = (await db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").bind(t).first<{ sql: string }>())!.sql
      expect(sql, t).toContain("tokenize='porter unicode61'")
    }
    expect(await factIds('"return"')).toEqual(['mem_live00000000000000000'])
    expect(await factIds('"shipped"')).toEqual(['mem_live00000000000000001'])
    expect(await messageIds('"returns"')).toEqual(['t_live.u'])
    // 0141's triggers still keep the new indexes in step: an insert, an update and a delete.
    await db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, text, at_ms) VALUES ('t_live.0', 'c_live', 'r_1', 't_live', 1, 'agent', 'Two refunds went out today.', 2)").run()
    expect(await messageIds('"refunded"')).toEqual(['t_live.0'])
    await db.prepare("UPDATE memories SET text = 'Exchanges are free' WHERE id = 'mem_live00000000000000000'").run()
    expect(await factIds('"return"')).toEqual([])
    expect(await factIds('"exchanged"')).toEqual(['mem_live00000000000000000'])
    await db.prepare("DELETE FROM memories WHERE id = 'mem_live00000000000000001'").run()
    expect(await factIds('"ship"')).toEqual([])
  })
})
