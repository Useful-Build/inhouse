// 0100_chats on top of P2's 0001-0005 (the server project applies every migration, server/testing/apply-migrations.ts).
// Ways it can fail, written down first:
//  1. the tables aren't there, or a column the design names is missing;
//  2. a chat names no member, a pin flag is neither 0 nor 1, or two messages share a position or an id;
//  3. `n` isn't a stable integer rowid (W6's FTS5 index keys on it).
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

const db = env.DB
const fails = async (sql: string, ...args: unknown[]) => {
  let error: unknown = null
  try { await db.prepare(sql).bind(...args).run() } catch (err) { error = err }
  return error !== null
}
const chat = (id: string, owner = 'm_chat_owner', pinned = 0) =>
  db.prepare('INSERT INTO chats (id, owner_id, title, pinned, created_at_ms, last_at_ms) VALUES (?, ?, ?, ?, 1, 1)').bind(id, owner, 'A chat', pinned).run()
const message = (id: string, chatId: string, pos: number, role = 'user') =>
  db.prepare('INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, at_ms) VALUES (?, ?, ?, ?, ?, ?, 1)').bind(id, chatId, 'r_1', 't_1', pos, role).run()

beforeAll(async () => {
  await db.prepare("INSERT INTO members (id, kind, role, status, name, email_norm, created_at_ms) VALUES ('m_chat_owner', 'person', 'member', 'active', 'Ada', 'ada@example.com', 1)").run()
})

describe('0100_chats', () => {
  it('creates both tables with the design columns (failure 1)', async () => {
    const cols = async (t: string) => (await db.prepare(`SELECT name FROM pragma_table_info('${t}') ORDER BY cid`).all<{ name: string }>()).results.map(r => r.name)
    expect(await cols('chats')).toEqual(['id', 'owner_id', 'title', 'custom_title', 'pinned', 'deleted_at_ms', 'created_at_ms', 'last_at_ms', 'rev', 'req_id'])
    expect(await cols('chat_messages')).toEqual(['n', 'id', 'chat_id', 'run_id', 'turn_id', 'pos', 'role', 'author_id', 'text', 'part_json', 'extra_json', 'model', 'at_ms'])
  })
  it('refuses a chat of nobody, a bad pin, a repeated position or id, and a bad role (failure 2)', async () => {
    await chat('c1')
    expect(await fails('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, 1, 1)', 'c2', 'm_nobody', 't')).toBe(true)
    expect(await fails('INSERT INTO chats (id, owner_id, title, pinned, created_at_ms, last_at_ms) VALUES (?, ?, ?, 2, 1, 1)', 'c3', 'm_chat_owner', 't')).toBe(true)
    await message('t_1.u', 'c1', 0)
    expect(await fails('INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, at_ms) VALUES (?, ?, ?, ?, ?, ?, 1)', 't_1.1', 'c1', 'r_1', 't_1', 0, 'agent')).toBe(true)
    expect(await fails('INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, at_ms) VALUES (?, ?, ?, ?, ?, ?, 1)', 't_1.u', 'c1', 'r_1', 't_1', 5, 'user')).toBe(true)
    expect(await fails('INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, at_ms) VALUES (?, ?, ?, ?, ?, ?, 1)', 't_1.2', 'c1', 'r_1', 't_1', 6, 'robot')).toBe(true)
    expect(await fails('INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, at_ms) VALUES (?, ?, ?, ?, ?, ?, 1)', 't_1.3', 'c_none', 'r_1', 't_1', 0, 'user')).toBe(true)
    const row = await db.prepare("SELECT pinned, rev, text FROM chats JOIN chat_messages ON chat_id = chats.id WHERE chats.id = 'c1'").first()
    expect(row).toEqual({ pinned: 0, rev: 1, text: '' })
  })
  it('gives each message an integer n that stays with it (failure 3)', async () => {
    await chat('c4')
    await message('t_4.u', 'c4', 0)
    await message('t_4.1', 'c4', 1, 'agent')
    const before = (await db.prepare("SELECT n, id FROM chat_messages WHERE chat_id = 'c4' ORDER BY pos").all<{ n: number; id: string }>()).results
    expect(before.every(r => Number.isInteger(r.n))).toBe(true)
    await db.prepare("DELETE FROM chat_messages WHERE id = 't_4.u'").run()
    await db.prepare("UPDATE chat_messages SET text = 'x' WHERE id = 't_4.1'").run()
    expect(await db.prepare("SELECT n FROM chat_messages WHERE id = 't_4.1'").first('n')).toBe(before[1].n)
  })
})
