// The backup alone: one consistent point, the registry guard, the listing. Ways it can fail, written down first:
//  1. a write that lands after the point batch (an audit line, a changed setting) gets into the backup, or an
//     append-only table is read past the max the batch recorded;
//  2. a canonical table is left out silently: a registry `d1` entry with no rule, a rule with no entry, a table in no
//     entry, a virtual table that isn't a registered derived table; or a derived table (FTS5) or its shadow tables
//     get copied, or go unlisted;
//  3. a backup without its manifest (one that stopped part way), or with a broken one, is listed; the order isn't
//     newest first;
//  4. a snapshot table too big for one batch is read anyway.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { backupManifestKey, backupPartKey } from '../../server/db/r2-keys.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import { tables as realRegistry } from '../tables/index.ts'
import { backup, listBackups, timeId } from './backup.ts'
import { BackupError } from './errors.ts'
import { TABLE_RULES, canonicalTables, shadowTables } from './tables.ts'
import { partLines } from './format.ts'
import type { BackupManifest } from './manifest.ts'
import { derivedEntry, insertRows } from './test-support.ts'

// The real registry's own derived indexes (P3 W6's search), listed beside a test's fixture index, sorted by name.
const withRealDerived = (d: { name: string; from: string[] }) => [...realRegistry.filter(r => r.derived).map(r => ({ name: r.name, from: [...(r.derived?.from ?? [])] })), d].sort((a, b) => (a.name < b.name ? -1 : 1))

const T = 1_800_000_000_000
const stores = openStores(env)
const seeded = await seedBrand(env.DB, stores, T)

async function partRows(m: BackupManifest, table: string): Promise<unknown[][]> {
  const t = m.tables.find(x => x.name === table)
  const out: unknown[][] = []
  for (const p of t?.parts ?? []) out.push(...partLines(await (await env.FILES.get(p.key))!.text()).map(l => JSON.parse(l) as unknown[]))
  return out
}

describe('one consistent point (failure 1)', () => {
  it('holds none of the writes made after the point batch', async () => {
    const before = await env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS max, COUNT(*) AS n FROM audit_log').first<{ max: number; n: number }>()
    const settingsBefore = (await env.DB.prepare('SELECT * FROM settings ORDER BY owner, key').raw()) as unknown[][]
    const m = await backup({
      db: env.DB, bucket: env.FILES, nowMs: T,
      testing: {
        afterPointBatch: async () => {
          // A setting changes (with its audit line) and more lines land, after the point.
          const r = await stores.settings.write({ owner: 'brand', scope: 'brand', key: 'g:tz', value: 'Europe/London', ifRev: 1 }, { actorId: seeded.members.admin, requestId: 'req-late', nowMs: T + 5 })
          expect('ok' in r).toBe(true)
          await insertRows(env.DB, 'audit_log', Array.from({ length: 1_500 }, (_, i) => ({ at_ms: T + i, actor_id: seeded.members.admin, action: 'member.invited', target_kind: 'member', target_id: seeded.members.dana, args_json: '{}', req_id: `late-${i}` })))
        },
      },
    })
    const audit = m.tables.find(t => t.name === 'audit_log')
    expect(audit?.maxId).toBe(before?.max)
    expect(audit?.rows).toBe(before?.n)
    const ids = (await partRows(m, 'audit_log')).map(r => r[0] as number)
    expect(Math.max(...ids)).toBe(before?.max)
    expect(await partRows(m, 'settings')).toEqual(settingsBefore)
    expect(m).toMatchObject({ format: 1, takenAtMs: T, migration: await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<string>('name') })
    expect(await env.DB.prepare('SELECT MAX(id) AS max FROM audit_log').first<number>('max')).toBeGreaterThan(before?.max as number)
  })
})

describe('the registry guard (failure 2)', () => {
  const extra = (name: string) => ({ kind: 'd1' as const, name, retention: 'config' as const, personKeys: [], export: true })
  /** Runs `body` with `create` applied to the source, then drops what it made (later backups here need a clean schema). */
  async function withTable(create: string, name: string, body: () => Promise<void>) {
    await env.DB.prepare(create).run()
    try { await body() } finally { await env.DB.prepare(`DROP TABLE ${name}`).run() }
  }
  const code = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (x: unknown) => x)
    expect(err).toBeInstanceOf(BackupError)
    return [(err as BackupError).code, (err as Error).message]
  }
  it('throws by name on a d1 entry with no rule', () => withTable('CREATE TABLE extra_table (id TEXT PRIMARY KEY)', 'extra_table', async () => {
    expect(await code(backup({ db: env.DB, bucket: env.FILES, nowMs: T, registry: [...realRegistry, extra('extra_table')] }))).toEqual(['no_rule', 'backup: no_rule (extra_table)'])
  }))
  it('throws by name on a table in no entry', () => withTable('CREATE TABLE stray_table (id TEXT PRIMARY KEY)', 'stray_table', async () => {
    expect(await code(backup({ db: env.DB, bucket: env.FILES, nowMs: T }))).toEqual(['unregistered_table', 'backup: unregistered_table (stray_table: in no registry entry)'])
  }))
  it('throws by name on a canonical table whose entry is gone', async () => {
    const registry = realRegistry.filter(r => r.name !== 'support_grants')
    expect(await code(backup({ db: env.DB, bucket: env.FILES, nowMs: T, registry }))).toEqual(['unregistered_table', 'backup: unregistered_table (support_grants: in no registry entry)'])
  })
  it('throws by name on a rule for a derived table', () => withTable('CREATE VIRTUAL TABLE search_r USING fts5(body)', 'search_r', async () => {
    const rule = { name: 'search_r', orderBy: ['rowid'], mode: 'snapshot' as const }
    expect(await code(canonicalTables(env.DB, [...realRegistry, derivedEntry('search_r')], [...TABLE_RULES, rule]))).toEqual(['rule_for_derived', 'backup: rule_for_derived (search_r)'])
  }))
  it('throws by name on a virtual table in no entry', () => withTable('CREATE VIRTUAL TABLE search_x USING fts5(body)', 'search_x', async () => {
    expect(await code(backup({ db: env.DB, bucket: env.FILES, nowMs: T }))).toEqual(['virtual_table', 'backup: virtual_table (search_x: in no registry entry)'])
  }))
  it('throws by name on a virtual table whose entry is not derived', () => withTable('CREATE VIRTUAL TABLE search_y USING fts5(body)', 'search_y', async () => {
    expect(await code(backup({ db: env.DB, bucket: env.FILES, nowMs: T, registry: [...realRegistry, extra('search_y')] }))).toEqual(['virtual_table', "backup: virtual_table (search_y: its entry isn't derived)"])
  }))
  it('throws by name on a derived table built from a table that is not canonical', () => withTable('CREATE VIRTUAL TABLE search_w USING fts5(body)', 'search_w', async () => {
    const registry = [...realRegistry, { ...derivedEntry('search_w'), derived: { from: ['nowhere'] } }]
    expect((await code(backup({ db: env.DB, bucket: env.FILES, nowMs: T, registry })))[0]).toBe('derived_from_unknown')
  }))
  it('throws by name on a derived entry that is not an FTS5 virtual table', () => withTable('CREATE TABLE plain_index (body TEXT)', 'plain_index', async () => {
    // A plain table named like a shadow of it must not be skipped either: it's in no entry.
    await env.DB.prepare('CREATE TABLE plain_index_data (x TEXT)').run()
    try {
      expect((await code(backup({ db: env.DB, bucket: env.FILES, nowMs: T, registry: [...realRegistry, derivedEntry('plain_index')] })))).toEqual(['unregistered_table', 'backup: unregistered_table (plain_index_data: in no registry entry)'])
    } finally { await env.DB.prepare('DROP TABLE plain_index_data').run() }
    expect(await code(backup({ db: env.DB, bucket: env.FILES, nowMs: T, registry: [...realRegistry, derivedEntry('plain_index')] }))).toEqual(['derived_not_virtual', 'backup: derived_not_virtual (plain_index: not an FTS5 virtual table)'])
  }))
  it('throws by name on a rule with no registry entry', async () => {
    const extraRule = { name: 'ghost_table', orderBy: ['id'], mode: 'snapshot' as const }
    const err = await canonicalTables(env.DB, realRegistry, [...TABLE_RULES, extraRule]).then(() => null, (x: unknown) => x)
    expect(err).toBeInstanceOf(BackupError)
    expect([(err as BackupError).code, (err as Error).message]).toEqual(['rule_without_entry', 'backup: rule_without_entry (ghost_table)'])
  })
  it('skips only the shadow tables SQLite reports for a registered virtual table', () => withTable("CREATE VIRTUAL TABLE search_c USING fts5(body, content='')", 'search_c', async () => {
    // A contentless FTS5 table has no `_content` shadow: the skip set comes from SQLite, not from a suffix list.
    expect([...await shadowTables(env.DB, ['search_c'])].sort()).toEqual(['search_c_config', 'search_c_data', 'search_c_docsize', 'search_c_idx'])
    expect(await shadowTables(env.DB, [])).toEqual(new Set())
    // A plain `search_c_content` can't sit beside it to be skipped: SQLite reserves the name.
    await expect(env.DB.prepare('CREATE TABLE search_c_content (x TEXT)').run()).rejects.toThrow(/reserved for internal use/)
    const m = await backup({ db: env.DB, bucket: env.FILES, nowMs: T, registry: [...realRegistry, derivedEntry('search_c')] })
    expect(m.derived).toEqual(withRealDerived({ name: 'search_c', from: ['settings'] }))
  }))
  it('skips a derived table and its FTS5 shadow tables, and lists it in the manifest', () => withTable('CREATE VIRTUAL TABLE search_z USING fts5(body)', 'search_z', async () => {
    await env.DB.prepare("INSERT INTO search_z (body) VALUES ('some text')").run()
    const shadows = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'search_z_%'").all<{ name: string }>()).results.map(r => r.name)
    expect(shadows.length).toBeGreaterThan(0)
    const m = await backup({ db: env.DB, bucket: env.FILES, nowMs: T, registry: [...realRegistry, derivedEntry('search_z')] })
    expect(m.derived).toEqual(withRealDerived({ name: 'search_z', from: ['settings'] }))
    expect(m.tables.map(t => t.name).sort()).toEqual(TABLE_RULES.map(r => r.name).sort())
    const keys = (await env.FILES.list({ prefix: `backups/d1/${m.backupId}/` })).objects.map(o => o.key)
    expect(keys.filter(k => k.includes('search_z'))).toEqual([])
  }))
})

describe('listing (failure 3)', () => {
  it('lists complete backups only, newest first', async () => {
    const older = await backup({ db: env.DB, bucket: env.FILES, nowMs: T - 86_400_000 })
    const newer = await backup({ db: env.DB, bucket: env.FILES, nowMs: T + 86_400_000 })
    // One that stopped before its manifest, and one whose manifest is broken.
    const partial = timeId(T + 2 * 86_400_000)
    await env.FILES.put(backupPartKey(partial, 'members', 0), '["m_x"]\n')
    const broken = timeId(T + 3 * 86_400_000)
    await env.FILES.put(backupManifestKey(broken), '{"format":1')
    const listed = (await listBackups(env.FILES)).map(b => b.backupId)
    expect(listed[0]).toBe(newer.backupId)
    expect(listed.at(-1)).toBe(older.backupId)
    expect(listed).not.toContain(partial)
    expect(listed).not.toContain(broken)
  })
})

describe('size (failure 4)', () => {
  it('throws by name on a snapshot table over 10,000 rows', async () => {
    await insertRows(env.DB, 'settings', Array.from({ length: 10_001 }, (_, i) => ({ owner: 'brand', key: `bulk:${i}`, value_json: 'null', rev: 1, updated_at_ms: T, updated_by: seeded.members.admin, req_id: 'bulk' })))
    await expect(backup({ db: env.DB, bucket: env.FILES, nowMs: T })).rejects.toThrow(/snapshot_too_large \(settings/)
  })
})
