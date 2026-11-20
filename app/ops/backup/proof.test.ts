// The restore's proof (step 5) on a full write, with the live database unreadable. A write needs a fresh target, so
// this file has its own. Ways it can fail, written down first:
//  1. a target row that differs from the backup after the write still ends in `restored_unreconciled`;
//  2. the record doesn't say which table failed, or marks every table the same;
//  3. an unreadable live database stops the restore instead of recording the gap (F1 re-appends from the daily copy).
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { restoreKey } from '../../server/db/r2-keys.ts'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import { backup } from './backup.ts'
import { RestoreRecordSchema, SnapshotManifestSchema } from './manifest.ts'
import { restore } from './restore.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000

it('catches a row changed after the write, and records an unreadable live database as a gap', async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  await seedBrand(e.DB, openStores(e), T)
  const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: T })
  const record = await restore({
    bucket: e.FILES, target: e.RESTORE_DB, live: 'unreadable', backupId: manifest.backupId,
    at: { actorId: SYSTEM_MEMBER_ID, requestId: 'req-proof', nowMs: T + 1 },
    // Resets run only on a proven target.
    resetAfterRestore: [{ name: 'must-not-run', run: async () => { throw new Error('a reset ran on an unproven target') } }],
    testing: { afterTargetWrite: async () => { await e.RESTORE_DB.prepare("UPDATE settings SET value_json = '\"Changed\"' WHERE key = 'g:tz'").run() } },
  })
  expect(record).toMatchObject({ status: 'failed_verification', reason: 'verification: settings', snapshot: { gap: 'unreadable' }, watermarkMs: T, reconciled: false, resets: [] })
  expect(record.d1.tables.map(t => [t.name, t.verified])).toEqual(manifest.tables.map(t => [t.name, t.name !== 'settings']))
  expect(RestoreRecordSchema.parse(JSON.parse(await (await e.FILES.get(restoreKey(record.restoreId, 'record.json')))!.text()))).toEqual(record)
  const snap = SnapshotManifestSchema.parse(JSON.parse(await (await e.FILES.get(restoreKey(record.restoreId, 'snapshot/manifest.json')))!.text()))
  expect(snap).toMatchObject({ restoreId: record.restoreId, audit: 'unreadable', deletionLog: { objects: 0 } })
})
