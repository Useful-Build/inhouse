// The search index rebuild after a restore (P8 C1, acceptance 4's "rebuilds the search index"). Ways it can fail,
// written down first:
//  1. after a restore an index answers a search differently from its source table (a row missing or stale);
//  2. it rebuilds after a restore that didn't succeed (refused, failed, failed_verification), or writes a record then;
//  3. the record's derived list, the registry's derived entries and P3's DERIVED_SEARCH_TABLES name different tables or
//     sources, and it rebuilds anyway (an index nobody rebuilds, or one rebuilt from the wrong table);
//  4. FTS5's integrity check isn't run against the source, or fts.json misses a table, its source row count or its state;
//  5. a rebuild that throws, or an index the rebuild didn't fill, leaves no record, or a record that says rebuilt
//     (R reads the top-level `status`).
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { restoreKey } from '../../../server/db/r2-keys.ts'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { openStores } from '../../../server/db/stores.ts'
import { DERIVED_SEARCH_TABLES } from '../../../server/mcp/search-index.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import { tables } from '../../tables/index.ts'
import { backup } from '../backup.ts'
import { RestoreRecordSchema } from '../manifest.ts'
import type { RestoreRecord } from '../manifest.ts'
import { restore } from '../restore.ts'
import { FtsRecordSchema, rebuildAfterRestore } from './rebuild.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
const MARKERS = ['qzvalt', 'mbrekk', 'tolvix', 'yandru', 'ospeth']
let good: RestoreRecord

const putRecord = (r: RestoreRecord) => e.FILES.put(restoreKey(r.restoreId, 'record.json'), JSON.stringify(r))
const ftsJson = async (restoreId: string) => {
  const obj = await e.FILES.get(restoreKey(restoreId, 'fts.json'))
  return obj ? FtsRecordSchema.parse(JSON.parse(await obj.text())) : null
}
/** The oracle: the source rows whose text holds the word, by a plain LIKE; the index's answer for the same word. */
const like = async (db: D1Database, from: string, word: string) => (await db.prepare(`SELECT n FROM ${from} WHERE text LIKE ? ORDER BY n`).bind(`%${word}%`).all<{ n: number }>()).results.map(r => r.n)
const match = async (db: D1Database, index: string, word: string) => (await db.prepare(`SELECT rowid AS n FROM ${index} WHERE ${index} MATCH ? ORDER BY rowid`).bind(word).all<{ n: number }>()).results.map(r => r.n)

beforeAll(async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const seeded = await seedBrand(e.DB, openStores(e), T)
  await e.DB.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES ('c_fts', ?, 'Search', ?, ?)").bind(seeded.members.dana, T, T).run()
  for (let i = 0; i < 25; i++) {
    const text = `note ${MARKERS[i % MARKERS.length]} ${i % 2 === 0 ? MARKERS[(i + 2) % MARKERS.length] : 'plain'}`
    await e.DB.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, author_id, text, at_ms) VALUES (?, 'c_fts', 'r', 't', ?, 'user', ?, ?, ?)").bind(`t_fts.${i}`, i, seeded.members.dana, text, T + i).run()
    await e.DB.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, 'person', ?, ?, 'active', ?, ?, ?)").bind(`mem_${i}`, seeded.members.dana, text, seeded.members.dana, T, T).run()
  }
  const m = await backup({ db: e.DB, bucket: e.FILES, nowMs: T + 100 })
  good = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: m.backupId, at: { actorId: SYSTEM_MEMBER_ID, requestId: 'req-fts', nowMs: T + 200 } })
  if (good.status !== 'restored_unreconciled') throw new Error(`restore: ${good.status} ${good.reason ?? ''}`)
})

describe('what it refuses (failures 2 and 3)', () => {
  it('refuses a refused, failed or failed_verification restore and writes no fts record', async () => {
    for (const status of ['refused', 'failed', 'failed_verification'] as const) {
      const r = RestoreRecordSchema.parse({ ...good, restoreId: `${good.restoreId}-${status}`, status })
      await putRecord(r)
      expect(await rebuildAfterRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: r.restoreId }), status).toEqual({ refused: `restore_status: ${status}` })
      expect(await ftsJson(r.restoreId), status).toBeNull()
    }
    expect(await rebuildAfterRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: 'no-such-restore' })).toEqual({ refused: 'no_record' })
  })

  it('refuses when the record\'s derived list differs from the registry\'s or DERIVED_SEARCH_TABLES after normalising', async () => {
    const derived = good.d1.derived
    const cases: [string, RestoreRecord['d1']['derived'], Parameters<typeof rebuildAfterRestore>[0]['registry'], Parameters<typeof rebuildAfterRestore>[0]['searchTables']][] = [
      ['record names an extra index', [...derived, { name: 'other_fts', from: ['memories'], state: 'rebuild_needed' }], undefined, undefined],
      ['record names another source', derived.map(d => (d.name === 'memories_fts' ? { ...d, from: ['chat_messages'] } : d)), undefined, undefined],
      ['registry lacks an index', derived, tables.filter(t => t.name !== 'chat_messages_fts'), undefined],
      ['P3 lists another source', derived, undefined, DERIVED_SEARCH_TABLES.map(t => (t.name === 'memories_fts' ? { ...t, from: 'chats' } : t))],
    ]
    for (const [label, d, registry, searchTables] of cases) {
      const r = RestoreRecordSchema.parse({ ...good, restoreId: `${good.restoreId}-${label.replace(/\W+/g, '-')}`, d1: { ...good.d1, derived: d } })
      await putRecord(r)
      const out = await rebuildAfterRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: r.restoreId, registry, searchTables })
      expect(out, label).toMatchObject({ refused: expect.stringMatching(/^derived_mismatch: /) })
      expect(await ftsJson(r.restoreId), label).toBeNull()
    }
  })
})

describe('the rebuild (failures 1 and 4)', () => {
  it('after a round-trip restore each index answers every search the same as a LIKE over its source table; integrity-check passes on every derived table and fts.json lists each one as rebuilt with its source row count', async () => {
    // Empty the target's indexes, so only the rebuild can make them answer (a restore's triggers would fill them).
    for (const t of DERIVED_SEARCH_TABLES) await e.RESTORE_DB.prepare(`INSERT INTO ${t.name}(${t.name}) VALUES ('delete-all')`).run()
    await expect(e.RESTORE_DB.prepare("INSERT INTO chat_messages_fts(chat_messages_fts, rank) VALUES ('integrity-check', 1)").run()).rejects.toThrow()

    const out = await rebuildAfterRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: good.restoreId, nowMs: T + 300 })
    if (!('ok' in out)) throw new Error(`not rebuilt: ${JSON.stringify(out)}`)
    for (const t of DERIVED_SEARCH_TABLES) {
      for (const word of MARKERS) {
        const expected = await like(e.RESTORE_DB, t.from, word)
        expect(expected.length, `${t.from} ${word}`).toBeGreaterThan(0)
        expect(await match(e.RESTORE_DB, t.name, word), `${t.name} ${word}`).toEqual(expected)
      }
    }
    const rows = async (from: string) => (await e.RESTORE_DB.prepare(`SELECT COUNT(*) AS n FROM ${from}`).first<{ n: number }>())!.n
    const expected = await Promise.all([...DERIVED_SEARCH_TABLES].sort((a, b) => (a.name < b.name ? -1 : 1)).map(async t => ({ name: t.name, from: [t.from], sourceRows: await rows(t.from), state: 'rebuilt' })))
    const stored = await ftsJson(good.restoreId)
    expect(stored).toEqual(out.ok)
    expect(stored).toEqual({ format: 1, restoreId: good.restoreId, atMs: T + 300, status: 'rebuilt', tables: expected })
    // Its own check passed, and passes again from here.
    for (const t of DERIVED_SEARCH_TABLES) await e.RESTORE_DB.prepare(`INSERT INTO ${t.name}(${t.name}, rank) VALUES ('integrity-check', 1)`).run()
    // G1's record is untouched: the state moves in fts.json only.
    const record = RestoreRecordSchema.parse(JSON.parse(await (await e.FILES.get(restoreKey(good.restoreId, 'record.json')))!.text()))
    expect(record).toEqual(good)
  })
})

describe('a rebuild that fails (failure 5)', () => {
  it('writes fts.json with each table failed and the error, and says so', async () => {
    const r = RestoreRecordSchema.parse({ ...good, restoreId: `${good.restoreId}-broken` })
    await putRecord(r)
    const broken = { prepare: (q: string) => e.RESTORE_DB.prepare(q), batch: () => Promise.reject(new Error('D1 is down (test)')) } as unknown as D1Database
    const out = await rebuildAfterRestore({ bucket: e.FILES, target: broken, restoreId: r.restoreId, nowMs: T + 400 })
    // P3's runBatch names the database in its error.
    expect(out).toEqual({ failed: 'D1 failed' })
    const stored = await ftsJson(r.restoreId)
    expect(stored?.status).toBe('failed')
    expect(stored?.tables.map(t => [t.name, t.state, t.error])).toEqual([['chat_messages_fts', 'failed', 'D1 failed'], ['memories_fts', 'failed', 'D1 failed']])
  })

  it('fails an index the rebuild left empty: integrity-check against the source catches it, per table', async () => {
    const r = RestoreRecordSchema.parse({ ...good, restoreId: `${good.restoreId}-silent` })
    await putRecord(r)
    // A batch that resolves without running, after one index was emptied: only the integrity check can tell.
    await e.RESTORE_DB.prepare("INSERT INTO memories_fts(memories_fts) VALUES ('delete-all')").run()
    const silent = { prepare: (q: string) => e.RESTORE_DB.prepare(q), batch: () => Promise.resolve([]) } as unknown as D1Database
    const out = await rebuildAfterRestore({ bucket: e.FILES, target: silent, restoreId: r.restoreId, nowMs: T + 500 })
    expect(out).toMatchObject({ failed: expect.stringMatching(/^memories_fts: /) })
    const stored = await ftsJson(r.restoreId)
    expect(stored?.status).toBe('failed')
    expect(stored?.tables.map(t => [t.name, t.state])).toEqual([['chat_messages_fts', 'rebuilt'], ['memories_fts', 'failed']])
    expect(stored?.tables[1].error).toBeTruthy()
    // Put the index back for anything after.
    await e.RESTORE_DB.prepare("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')").run()
  })
})
