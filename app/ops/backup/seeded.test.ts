// Migration-seeded rows on the restore target (P8 C1). A freshly migrated target already holds the rows migrations
// insert, and once a brand has used them they differ from the backup's (0221's morning-check routine carries the
// migration's own times), so G1's match would refuse every real restore. Ways it can fail, written down first:
//  1. a named seeded row that differs refuses the restore, or is left with the target's values instead of the backup's;
//  2. any other differing row, or a row the backup lacks, no longer refuses (the overwrite is a hole in the check);
//  3. a refused restore writes anything to the target.
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import { backup } from './backup.ts'
import type { BackupManifest } from './manifest.ts'
import { SEEDED_ROWS, restore } from './restore.ts'
import { dumpCanonical } from './test-support.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
const at = { actorId: SYSTEM_MEMBER_ID, requestId: 'req-seeded', nowMs: T + 10 }
const routine = (db: D1Database) => db.prepare("SELECT * FROM routines WHERE id = 'routine-morning-check'").first()
let good: BackupManifest

beforeAll(async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  await seedBrand(e.DB, openStores(e), T)
  // The brand has used its morning check: the source's row is no longer the one a fresh migration inserts.
  await e.DB.prepare("UPDATE routines SET hour = 7, updated_at_ms = ?, rev = 3 WHERE id = 'routine-morning-check'").bind(T).run()
  good = await backup({ db: e.DB, bucket: e.FILES, nowMs: T + 1 })
})

it('names the morning-check routine 0221 inserts', () => {
  expect(SEEDED_ROWS).toEqual([{ table: 'routines', key: ['routine-morning-check'], migration: '0221_morning_check.sql' }])
})

it('still refuses any other differing row, or a row the backup lacks, and writes nothing', async () => {
  const fresh = await dumpCanonical(e.RESTORE_DB)
  expect(await routine(e.RESTORE_DB)).not.toEqual(await routine(e.DB))
  await e.RESTORE_DB.prepare("UPDATE members SET name = 'Changed' WHERE id = 'm_smoke'").run()
  const changed = await dumpCanonical(e.RESTORE_DB)
  expect(await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: good.backupId, at })).toMatchObject({ status: 'refused', reason: 'seeded_row_differs: members' })
  expect(await dumpCanonical(e.RESTORE_DB)).toEqual(changed)
  await e.RESTORE_DB.prepare("UPDATE members SET name = 'Smoke check' WHERE id = 'm_smoke'").run()
  // A second routine beside the seeded one: the overwrite accounts for one row, not the table.
  await e.RESTORE_DB.prepare("INSERT INTO routines (id, origin, kind, name, instruction, days_mask, hour, minute, missed, need, creator_id, checked_until_ms, created_at_ms, updated_at_ms) VALUES ('r_extra', 'team', 'agent', 'Extra', 'Do it.', 1, 9, 0, 'skip', 0, 'm_system', 0, 0, 0)").run()
  const extra = await dumpCanonical(e.RESTORE_DB)
  expect(await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: good.backupId, at })).toMatchObject({ status: 'refused', reason: 'target_not_empty: routines' })
  expect(await dumpCanonical(e.RESTORE_DB)).toEqual(extra)
  await e.RESTORE_DB.prepare("DELETE FROM routines WHERE id = 'r_extra'").run()
  expect(await dumpCanonical(e.RESTORE_DB)).toEqual(fresh)
})

it('overwrites the named seeded row with the backup\'s values and proves the restore', async () => {
  const record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: good.backupId, at })
  expect(record).toMatchObject({ status: 'restored_unreconciled' })
  expect(record.d1.tables.every(t => t.verified)).toBe(true)
  expect(await routine(e.RESTORE_DB)).toEqual(await routine(e.DB))
  expect(await dumpCanonical(e.RESTORE_DB)).toEqual(await dumpCanonical(e.DB))
})
