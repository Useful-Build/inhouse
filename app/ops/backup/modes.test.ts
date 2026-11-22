// The `paged` and `insert_only` backup modes (P8 C1). Ways it can fail, written down first:
//  1. one table past 10,000 rows stops the whole brand's backup (the gate: a `paged` table must back up whole);
//  2. a paged or insert_only table doesn't round-trip row for row (a page boundary drops or repeats a row, a composite
//     key pages wrong);
//  3. an insert_only table holds a row created after the point, or claims it is exact when a row landed at or before
//     its point during the read;
//  4. a paged table is called exact: the manifest or the restore record doesn't mark it, so F1's reconcile can't know;
//  5. a rule that misuses a mode (insert_only with no creation column, a creation column on another mode) backs up
//     anyway instead of throwing by name.
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import type { Seeded } from '../../server/seed/seed.ts'
import { backup } from './backup.ts'
import { BackupError } from './errors.ts'
import type { BackupManifest } from './manifest.ts'
import { restore } from './restore.ts'
import { TABLE_RULES, canonicalTables } from './tables.ts'
import type { TableRule } from './tables.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
const BIG = 10_050
let seeded: Seeded

/** The oracle: every table but D1's own and the search indexes (and their shadows), each row as JSON, sorted. */
async function dumpAll(db: D1Database): Promise<Record<string, string[]>> {
  const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map(r => r.name)
  const out: Record<string, string[]> = {}
  for (const name of names.filter(n => !/^(?:d1_|sqlite_|_cf_)/.test(n) && !n.includes('_fts')).sort()) {
    out[name] = (await db.prepare(`SELECT * FROM "${name}"`).all()).results.map(r => JSON.stringify(r)).sort()
  }
  return out
}
const count = async (db: D1Database, table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>())!.n
const toolCall = (db: D1Database, turn: string, n: number, atMs: number) =>
  db.prepare("INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES (?, ?, 'c_big_00001', ?, 'pre', 'shop.read', 'allow', 2, 'ab', ?)").bind(turn, n, seeded.members.dana, atMs).run()
const tableOf = (m: BackupManifest, name: string) => {
  const t = m.tables.find(x => x.name === name)
  if (!t) throw new Error(`no table ${name} in the manifest`)
  return t
}

beforeAll(async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  seeded = await seedBrand(e.DB, openStores(e), T)
  await e.DB.prepare(`WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${BIG})
    INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) SELECT printf('c_big_%05d', i), ?, 'Chat ' || i, ?, ? + i FROM s`).bind(seeded.members.dana, T, T).run()
  // Composite keys that page across a boundary: many tool calls on one turn, and reads by two members.
  for (let i = 0; i < 30; i++) await toolCall(e.DB, `turn_${i % 3}`, i, T - 1000 + i)
  await e.DB.prepare("INSERT INTO notices (id, audience, template, fields_json, icon, at_ms, link_json, source) VALUES ('n_1', 'team', 't', '{}', 'bell', ?, '{}', 'test'), ('n_2', 'team', 't', '{}', 'bell', ?, '{}', 'test')").bind(T, T).run()
  for (const m of [seeded.members.dana, seeded.members.leo]) for (const n of ['n_1', 'n_2']) {
    await e.DB.prepare('INSERT INTO notice_reads (member_id, notice_id, at_ms) VALUES (?, ?, ?)').bind(m, n, T).run()
  }
})

describe('the modes (failures 1 to 4)', () => {
  it('an insert_only table that gains a row at or before its point during the read is marked paged, not exact', async () => {
    const m = await backup({ db: e.DB, bucket: e.FILES, nowMs: T + 1, testing: { afterPointBatch: async () => { await toolCall(e.DB, 'turn_late', 0, T - 5000) } } })
    expect(tableOf(m, 'tool_calls')).toMatchObject({ mode: 'insert_only', consistency: 'paged', rows: 31 })
    await e.DB.prepare("DELETE FROM tool_calls WHERE turn_id = 'turn_late'").run()
  })

  it('an insert_only table round-trips row for row and holds no row created after the point; a paged table past 10,000 rows backs up whole, round-trips row for row, and the manifest and restore record mark it paged', async () => {
    const m = await backup({ db: e.DB, bucket: e.FILES, nowMs: T + 2, testing: { afterPointBatch: async () => { await toolCall(e.DB, 'turn_after', 0, T + 60_000) } } })
    // The insert_only tables: exact, and without the row written after the point.
    const calls = tableOf(m, 'tool_calls')
    expect(calls).toMatchObject({ mode: 'insert_only', consistency: 'exact', rows: 30, point: T - 1000 + 29 })
    expect(tableOf(m, 'notice_reads')).toMatchObject({ mode: 'insert_only', consistency: 'exact', rows: 4 })
    await e.DB.prepare("DELETE FROM tool_calls WHERE turn_id = 'turn_after'").run()
    // The gate: chats is past 10,000 rows and backs up whole, in parts.
    const chats = tableOf(m, 'chats')
    expect(chats).toMatchObject({ mode: 'paged', consistency: 'paged', rows: await count(e.DB, 'chats') })
    expect(chats.rows).toBeGreaterThan(10_000)
    expect(chats.parts.length).toBeGreaterThan(10)
    const pagedRules = TABLE_RULES.filter(r => r.mode === 'paged').map(r => r.name).sort()
    expect(m.tables.filter(t => t.consistency === 'paged').map(t => t.name).sort()).toEqual(pagedRules)
    for (const t of m.tables.filter(x => x.mode === 'snapshot' || x.mode === 'append_only')) expect(t.consistency, t.name).toBe('exact')

    const record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: m.backupId, at: { actorId: SYSTEM_MEMBER_ID, requestId: 'req-modes', nowMs: T + 3 } })
    expect(record).toMatchObject({ status: 'restored_unreconciled' })
    expect(record.d1.tables.every(t => t.verified)).toBe(true)
    expect([...(record.d1.paged ?? [])].sort()).toEqual(pagedRules)
    expect(await dumpAll(e.RESTORE_DB)).toEqual(await dumpAll(e.DB))
  })
})

describe('misuse (failure 5)', () => {
  const swap = (name: string, change: (r: TableRule) => TableRule) => TABLE_RULES.map(r => (r.name === name ? change(r) : r))
  const codeOf = (p: Promise<unknown>) => p.then(() => null, (x: unknown) => (x instanceof BackupError ? [x.code, x.message] : x))

  it('throws by name on an insert_only rule with no creation column, a creation column on another mode, or one the table lacks', async () => {
    expect(await codeOf(canonicalTables(e.DB, undefined, swap('tool_calls', r => ({ ...r, createdColumn: undefined }))))).toEqual(['mode_rule', 'backup: mode_rule (tool_calls: insert_only needs a createdColumn)'])
    expect(await codeOf(canonicalTables(e.DB, undefined, swap('chats', r => ({ ...r, createdColumn: 'created_at_ms' }))))).toEqual(['mode_rule', 'backup: mode_rule (chats: createdColumn is for insert_only only)'])
    expect(await codeOf(canonicalTables(e.DB, undefined, swap('tool_calls', r => ({ ...r, createdColumn: 'nope' }))))).toEqual(['mode_rule', 'backup: mode_rule (tool_calls: createdColumn nope is not a column)'])
  })
})
