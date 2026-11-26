// Migration-seeded rows on the restore target (P8 C1). A freshly migrated target already holds the rows migrations
// insert, and once a brand has used them they differ from the backup's (0221's morning-check routine carries the
// migration's own times), so G1's match would refuse every real restore. Ways it can fail, written down first:
//  1. a named seeded row that differs refuses the restore, or is left with the target's values instead of the backup's;
//  2. any other differing row, or a row the backup lacks, no longer refuses (the overwrite is a hole in the check);
//  3. a refused restore writes anything to the target;
//  4. (P8a R, C1 review L1) a seeded row the target has used since the migration (rev past 1, a slot run) is overwritten;
//  5. (L2) the seeded key's text in another table is overwritten as if it were the seeded row.
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
  // The seeded key's text as another table's key (L2): its own row, nothing to do with the routine.
  await e.DB.prepare("INSERT INTO today_aside (item_id, reason, by, at_ms, rev, req_id) VALUES ('routine-morning-check', 'snoozed', 'm_system', ?, 1, 'req-l2')").bind(T).run()
  good = await backup({ db: e.DB, bucket: e.FILES, nowMs: T + 1 })
})

it('names the morning-check routine 0221 inserts and the outbox gate 0730 inserts', () => {
  expect(SEEDED_ROWS).toEqual([
    { table: 'routines', key: ['routine-morning-check'], migration: '0221_morning_check.sql', pristine: { rev: 1, last_slot_key: null } },
    { table: 'outbox_gate', key: [1], migration: '0730_outbox.sql', pristine: { paused: 0, restore_hold: 0, epoch: 1, do_gen: 0, updated_at_ms: 0, stamp: null } },
  ])
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

it('refuses a seeded row the target has used since its migration, and writes nothing (L1)', async () => {
  const fresh = await dumpCanonical(e.RESTORE_DB)
  for (const change of ["rev = 2", "last_slot_key = 'routine-morning-check|2026-11-22'"]) {
    const before = await routine(e.RESTORE_DB)
    await e.RESTORE_DB.prepare(`UPDATE routines SET ${change} WHERE id = 'routine-morning-check'`).run()
    const used = await routine(e.RESTORE_DB)
    expect(await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: good.backupId, at }), change).toMatchObject({ status: 'refused', reason: 'seeded_row_differs: routines' })
    expect(await routine(e.RESTORE_DB), change).toEqual(used)
    await e.RESTORE_DB.prepare('UPDATE routines SET rev = ?, last_slot_key = ? WHERE id = ?').bind(before?.rev, before?.last_slot_key ?? null, 'routine-morning-check').run()
  }
  expect(await dumpCanonical(e.RESTORE_DB)).toEqual(fresh)
})

it('refuses the seeded key\'s text in another table when that row differs (L2)', async () => {
  await e.RESTORE_DB.prepare("INSERT INTO today_aside (item_id, reason, by, at_ms, rev, req_id) VALUES ('routine-morning-check', 'dismissed', 'm_system', 1, 1, 'req-other')").run()
  expect(await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: good.backupId, at })).toMatchObject({ status: 'refused', reason: 'seeded_row_differs: today_aside' })
  expect(await e.RESTORE_DB.prepare("SELECT reason FROM today_aside WHERE item_id = 'routine-morning-check'").first()).toEqual({ reason: 'dismissed' })
  await e.RESTORE_DB.prepare("DELETE FROM today_aside WHERE item_id = 'routine-morning-check'").run()
})

it('overwrites the named seeded row with the backup\'s values and proves the restore', async () => {
  const record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: good.backupId, at })
  expect(record).toMatchObject({ status: 'restored_unreconciled' })
  expect(record.d1.tables.every(t => t.verified)).toBe(true)
  expect(await routine(e.RESTORE_DB)).toEqual(await routine(e.DB))
  expect(await dumpCanonical(e.RESTORE_DB)).toEqual(await dumpCanonical(e.DB))
})
