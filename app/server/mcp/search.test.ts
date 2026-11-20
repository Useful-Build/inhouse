// Search over memory and chat history (FTS5, p3-design section 10). Ways it can fail, written down first:
//  1. a word matches inside another word ("stock" finding "restock"), or case decides a match;
//  2. a phrase matches its words in another order;
//  3. input with FTS5 syntax (quotes, NEAR, a column filter, `*`, AND/OR/NOT) throws or reaches the expression;
//  4. the index drifts from its table: an updated fact still found by its old words, a deleted one still found;
//  5. `rebuildSearchIndexes` doesn't bring an emptied index back; `DERIVED_SEARCH_TABLES` misses a table D1 holds.
// Expected matches are literals; the index's own tables are read from sqlite_master, never from the module.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { historyStore } from './tools/history/store.ts'
import { memoryStore } from './tools/memory/store.ts'
import { DERIVED_SEARCH_TABLES, rebuildSearchIndexes } from './search-index.ts'

const db = env.DB
const memory = memoryStore({ db })
const history = historyStore({ db })
const ME = 'm_search'

const FACTS = {
  fridays: 'We restock on Fridays',
  sort: 'Sort order tables by date',
  fee: 'Restocking fee is 15 percent',
  kestrel: 'Kestrel ships in 14 days',
  cafe: 'Café orders close at noon',
}
let k = 0
const fact = (text: string) =>
  db.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, 'brand', NULL, ?, 'active', ?, 1, 1)")
    .bind(`mem_search${String(++k).padStart(12, '0')}`, text, ME).run()
const texts = async (q: string) => (await memory.search(ME, q, 20, 5)).map(f => f.text).sort()

beforeAll(async () => {
  await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Sol', 1)").bind(ME).run()
  for (const t of Object.values(FACTS)) await fact(t)
  await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES ('c_search', ?, 'Returns', 1, 1)").bind(ME).run()
  await db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, text, at_ms) VALUES ('t_s.u', 'c_search', 'r_1', 't_s', 0, 'user', 'What did we decide about returns?', 1000)").run()
  await db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, text, at_ms) VALUES ('t_s.0', 'c_search', 'r_1', 't_s', 1, 'agent', 'Returns are accepted within thirty days.', 2000)").run()
  await db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, text, at_ms) VALUES ('t_s.e', 'c_search', 'r_1', 't_s', 2, 'event', 'returns event row', 3000)").run()
})

describe('memory search (failures 1 to 3)', () => {
  it('matches whole words, any case, best first', async () => {
    expect(await texts('restock')).toEqual([FACTS.fridays])
    expect(await texts('stock')).toEqual([])
    expect(await texts('FRIDAYS')).toEqual([FACTS.fridays])
    expect(await texts('restocking')).toEqual([FACTS.fee])
    expect(await texts('kestrel noon')).toEqual([FACTS.cafe, FACTS.kestrel].sort())
    expect(await texts('cafe')).toEqual([FACTS.cafe])
  })
  it('a quoted phrase matches its words in order only', async () => {
    expect(await texts('"order tables"')).toEqual([FACTS.sort])
    expect(await texts('"tables order"')).toEqual([])
    expect(await texts('"ORDER TABLES" fridays')).toEqual([FACTS.fridays, FACTS.sort].sort())
  })
  it('FTS5 syntax in the input is only ever words', async () => {
    for (const q of ['"', 'NEAR(restock fee)', 'text:fridays', 'rest*', 'restock AND NOT fee', '()', '^fridays', '-', '"" OR ""', 'x'.repeat(200)]) {
      await expect(memory.search(ME, q, 20, 5), q).resolves.toBeDefined()
    }
    expect(await texts('text:fridays')).toEqual([FACTS.fridays])
    expect(await texts('rest*')).toEqual([])
    expect(await texts('!!!')).toEqual([])
  })
})

describe('history search (failures 1 to 3)', () => {
  it('finds user and agent messages, never event rows, with the chat and a snippet', async () => {
    const hits = await history.search(ME, 'returns', { afterMs: null, beforeMs: null, limit: 10 })
    expect(hits.map(h => h.messageId).sort()).toEqual(['t_s.0', 't_s.u'])
    expect(hits.every(h => h.chatId === 'c_search' && h.chatTitle === 'Returns' && h.snippet.includes('**'))).toBe(true)
    expect((await history.search(ME, '"thirty days"', { afterMs: null, beforeMs: null, limit: 10 })).map(h => h.messageId)).toEqual(['t_s.0'])
    expect((await history.search(ME, 'returns', { afterMs: 1500, beforeMs: null, limit: 10 })).map(h => h.messageId)).toEqual(['t_s.0'])
    expect((await history.search(ME, 'returns', { afterMs: null, beforeMs: 1500, limit: 10 })).map(h => h.messageId)).toEqual(['t_s.u'])
  })
})

describe('the index follows its table (failure 4)', () => {
  it('an update replaces the old words; a delete removes the row', async () => {
    await fact('Pallets arrive on Mondays')
    expect(await texts('pallets')).toEqual(['Pallets arrive on Mondays'])
    await db.prepare("UPDATE memories SET text = 'Crates arrive on Tuesdays' WHERE text = 'Pallets arrive on Mondays'").run()
    expect(await texts('pallets')).toEqual([])
    expect(await texts('crates')).toEqual(['Crates arrive on Tuesdays'])
    await db.prepare("DELETE FROM memories WHERE text = 'Crates arrive on Tuesdays'").run()
    expect(await texts('crates')).toEqual([])
    // A message's text changed and a message deleted (P8's retention) leave the history index in step too.
    await db.prepare("UPDATE chat_messages SET text = 'Refunds within thirty days.' WHERE id = 't_s.0'").run()
    expect((await history.search(ME, 'refunds', { afterMs: null, beforeMs: null, limit: 10 })).map(h => h.messageId)).toEqual(['t_s.0'])
    expect((await history.search(ME, 'accepted', { afterMs: null, beforeMs: null, limit: 10 }))).toEqual([])
  })
})

describe('derived tables and the rebuild (failure 5)', () => {
  it('names every table the two indexes keep in D1, shadow tables included', async () => {
    const inDb = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'memories_fts%' OR name LIKE 'chat_messages_fts%') ORDER BY name").all<{ name: string }>()).results.map(r => r.name)
    expect(inDb).toEqual([
      'chat_messages_fts', 'chat_messages_fts_config', 'chat_messages_fts_data', 'chat_messages_fts_docsize', 'chat_messages_fts_idx',
      'memories_fts', 'memories_fts_config', 'memories_fts_data', 'memories_fts_docsize', 'memories_fts_idx',
    ])
    expect(DERIVED_SEARCH_TABLES.flatMap(t => [t.name, ...t.shadow]).sort()).toEqual(inDb)
    expect(DERIVED_SEARCH_TABLES.map(t => [t.name, t.from])).toEqual([['memories_fts', 'memories'], ['chat_messages_fts', 'chat_messages']])
  })
  it('brings an emptied index back from its table', async () => {
    await db.batch([
      db.prepare("INSERT INTO memories_fts(memories_fts) VALUES ('delete-all')"),
      db.prepare("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('delete-all')"),
    ])
    expect(await texts('fridays')).toEqual([])
    expect(await history.search(ME, 'returns', { afterMs: null, beforeMs: null, limit: 10 })).toEqual([])
    await rebuildSearchIndexes(db)
    expect(await texts('fridays')).toEqual([FACTS.fridays])
    expect((await history.search(ME, 'returns', { afterMs: null, beforeMs: null, limit: 10 })).map(h => h.messageId)).toEqual(['t_s.u'])
  })
})
