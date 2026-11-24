// The round trip (the differential test): the seeded brand plus generated rows, backed up, restored into a fresh
// database, compared with the source. One per file: the audit log can't be emptied, so it needs a fresh source and
// target. Ways it can fail, written down first:
//  1. a row, a column or a value differs between source and target, or the order of an append-only table changes;
//  2. the stores read the target differently (the member list, the audit page);
//  3. the audit log's AUTOINCREMENT counter falls behind the restored ids, so a new line collides or goes backwards;
//  4. something is written to the target before the pre-restore snapshot's manifest is in R2;
//  5. the record misses a field, calls the result done, or names a photo as missing when it's there (or not when not);
//  6. any statement the backup or restore sends edits or deletes audit lines (`UPDATE`, `DELETE`, `OR REPLACE`).
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import fc from 'fast-check'
import { expect, it } from 'vitest'
import { backupManifestKey, restoreKey } from '../../server/db/r2-keys.ts'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import { backup, listBackups } from './backup.ts'
import { RestoreRecordSchema, SnapshotManifestSchema } from './manifest.ts'
import { restore } from './restore.ts'
import { tables as realRegistry } from '../tables/index.ts'
import { FORBIDDEN_SQL, derivedEntry, dumpCanonical, generatedArb, insertRows, recordingDb, seedNotificationBackupRows, testSeed } from './test-support.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
/** Set to a seed from a failing run's title to replay it. */
const ROUND_TRIP_SEED: number | null = null
const seed = ROUND_TRIP_SEED ?? testSeed()
// A derived FTS5 index (P3's chat and memory search will be like it): skipped by the backup, rebuilt after a restore.
const registry = [...realRegistry, derivedEntry('search_rt')]

it(`restores the seeded brand plus generated rows exactly, and the target works as the source did (seed ${seed})`, async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  for (const db of [e.DB, e.RESTORE_DB]) await db.prepare('CREATE VIRTUAL TABLE search_rt USING fts5(body)').run()
  await e.DB.prepare("INSERT INTO search_rt (body) VALUES ('indexed text')").run()
  const stores = openStores(e)
  const seeded = await seedBrand(e.DB, stores, T)
  await seedNotificationBackupRows(e.DB, seeded.members.dana, T, T - 1)
  const gen = fc.sample(generatedArb(Object.values(seeded.members)), { seed, numRuns: 1 })[0]
  await insertRows(e.DB, 'members', gen.members)
  await insertRows(e.DB, 'settings', gen.settings)
  await insertRows(e.DB, 'support_grants', gen.grants)
  await insertRows(e.DB, 'audit_log', gen.audit)
  // Half the photo keys have their object; the other half are reported missing.
  const photoKeys = gen.members.map(m => m.photo_key).filter((k): k is string => typeof k === 'string').sort()
  const present = photoKeys.filter((_, i) => i % 2 === 0)
  for (const k of present) await e.FILES.put(k, 'photo')

  const sql: string[] = []
  const manifest = await backup({ db: recordingDb(e.DB, sql), bucket: e.FILES, nowMs: T + 1, registry })
  // P3 W6's own search indexes sit beside the fixture; every canonical table is backed up (P3 and P4's empty here).
  expect(manifest.derived.map(d => d.name)).toEqual(['chat_messages_fts', 'memories_fts', 'search_rt'])
  expect(manifest.derived.find(d => d.name === 'search_rt')).toEqual({ name: 'search_rt', from: ['settings'] })
  expect(manifest.tables.map(t => t.name).sort()).toEqual(realRegistry.filter(r => r.kind === 'd1' && !r.derived).map(r => r.name).sort())
  expect((await listBackups(e.FILES)).map(b => b.backupId)).toEqual([manifest.backupId])
  const audit = manifest.tables.find(t => t.name === 'audit_log')
  expect(audit?.parts.length).toBeGreaterThan(5)

  const targetBefore = await dumpCanonical(e.RESTORE_DB)
  const order: string[] = []
  const targetDb = recordingDb(e.RESTORE_DB, sql)
  const record = await restore({
    bucket: e.FILES, target: targetDb, live: recordingDb(e.DB, sql), backupId: manifest.backupId,
    at: { actorId: SYSTEM_MEMBER_ID, requestId: 'req-restore', nowMs: T + 2 }, registry,
    resetAfterRestore: [{ name: 'test-cursor', run: async t => { order.push(t === targetDb ? 'reset' : 'reset on another database') } }],
    testing: {
      beforeTargetWrite: async () => {
        // Failure 4: the snapshot's manifest is in R2, and the target is still as migrated.
        const listed = await e.FILES.list({ prefix: 'restore/' })
        order.push(...listed.objects.map(o => o.key).filter(k => k.endsWith('/snapshot/manifest.json')).map(() => 'snapshot manifest'))
        expect(await dumpCanonical(e.RESTORE_DB)).toEqual(targetBefore)
        order.push('first target write')
      },
      afterTargetWrite: async () => { order.push('last target write') },
    },
  })
  expect(order).toEqual(['snapshot manifest', 'first target write', 'last target write', 'reset'])
  expect(record.status).toBe('restored_unreconciled')
  expect(record.reason).toBeUndefined()

  // Failure 1: every fixture table, row for row, in primary-key order.
  expect(await dumpCanonical(e.RESTORE_DB)).toEqual(await dumpCanonical(e.DB))

  // Failure 2: the stores over the target read what they read over the source.
  const target = openStores({ ...e, DB: e.RESTORE_DB })
  expect(await target.members.list({ limit: 1_000, afterId: null })).toEqual(await stores.members.list({ limit: 1_000, afterId: null }))
  expect(await target.audit.page({ limit: 200, beforeId: null })).toEqual(await stores.audit.page({ limit: 200, beforeId: null }))

  // Failure 3: the next line on the target gets an id above the restored max.
  const maxId = audit?.maxId as number
  const invited = await target.members.invite({ name: 'After Restore', email: 'after@example.test', role: 'member' }, { actorId: seeded.members.admin, requestId: 'req-after', nowMs: T + 3 })
  expect('ok' in invited).toBe(true)
  const next = await e.RESTORE_DB.prepare('SELECT MAX(id) AS id FROM audit_log').first<{ id: number }>()
  expect(next?.id).toBe(maxId + 1)

  // Failure 5: the record, every field, as stored.
  const stored = RestoreRecordSchema.parse(JSON.parse(await (await e.FILES.get(restoreKey(record.restoreId, 'record.json')))!.text()))
  expect(stored).toEqual(record)
  expect(record).toMatchObject({
    format: 1, status: 'restored_unreconciled', startedAtMs: T + 2, actorId: SYSTEM_MEMBER_ID, source: 'r2-backup',
    backup: { backupId: manifest.backupId, takenAtMs: T + 1, migration: manifest.migration },
    d1: {
      restorePointMs: T + 1, tables: manifest.tables.map(t => ({ name: t.name, rows: t.rows, sha256: t.sha256, verified: true })),
      derived: manifest.derived.map(d => ({ ...d, state: 'rebuild_needed' })),
    },
    resets: ['test-cursor'],
    r2: { missingPhotoKeys: photoKeys.filter(k => !present.includes(k)) },
    durableObjects: [], watermarkMs: T + 1, reconciled: false,
  })
  expect(record.finishedAtMs).toBeGreaterThanOrEqual(record.startedAtMs)
  // Every registered prefix outside the backup set, in registry order (P3 and P4's are empty here).
  const prefixes = realRegistry.filter(r => r.kind === 'r2' && r.retention !== 'backup').map(r => ({ prefix: r.name, objects: r.name === 'photos/' ? present.length : 0 }))
  expect(prefixes.map(p => p.prefix)).toEqual(expect.arrayContaining(['photos/', 'files/', 'sessions/', 'library/', 'audit-copy/', 'deletion-log/']))
  expect(record.r2.prefixes).toEqual(prefixes)
  const sourceAuditRows = (await e.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>())?.n
  expect(record.snapshot).toEqual({ key: restoreKey(record.restoreId, 'snapshot/manifest.json'), auditRows: sourceAuditRows, auditMaxId: maxId })
  const snap = SnapshotManifestSchema.parse(JSON.parse(await (await e.FILES.get(restoreKey(record.restoreId, 'snapshot/manifest.json')))!.text()))
  expect(snap.audit).not.toBe('unreadable')
  if (snap.audit !== 'unreadable') expect(snap.audit.sha256).toBe(audit?.sha256)
  expect(await e.FILES.head(backupManifestKey(manifest.backupId))).not.toBeNull()

  // Failure 6: nothing sent edits or deletes audit lines.
  expect(sql.length).toBeGreaterThan(0)
  expect(sql.filter(s => FORBIDDEN_SQL.test(s))).toEqual([])
  expect(FORBIDDEN_SQL.test('DELETE FROM "audit_log" WHERE id = 1')).toBe(true)
  expect(FORBIDDEN_SQL.test('INSERT OR REPLACE INTO members VALUES (1)')).toBe(true)
  expect(FORBIDDEN_SQL.test('REPLACE INTO "audit_log" (id) VALUES (1)')).toBe(true)
  expect(FORBIDDEN_SQL.test('INSERT INTO "audit_log" ("id") SELECT 1')).toBe(false)
})
