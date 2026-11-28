// A round trip across migrations applied out of number order (#585): 0790 merged on main before 0780, so a database
// migrated between the two merges applied 0790 first. One per file, as round-trip.test.ts (the audit log can't be
// emptied). The source is migrated in name order; the target really applies 0790 before 0780, as wrangler does when
// 0780 lands later (it applies every file d1_migrations doesn't name yet). Ways it can fail, written down first:
//  1. the restore refuses `migration_mismatch` because the last applied rows differ although the sets are equal;
//  2. the backup records the apply order's last row instead of the set, or drops a migration;
//  3. a table differs between source and target, or the proof isn't verified.
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import { backup } from './backup.ts'
import { restore } from './restore.ts'
import { dumpCanonical } from './test-support.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
const EARLY = '0780_eval_write_log.sql'
const LATE = '0790_connector_accounts_currency.sql'
const byId = async (db: D1Database) => (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map(r => r.name)

it('restores a backup onto a target that applied 0790 before 0780 (the same set, another order)', async () => {
  const names = e.TEST_MIGRATIONS.map(m => m.name)
  expect(names).toContain(EARLY)
  expect(names).toContain(LATE)
  // The target: every migration but 0780 (as main stood when 0790 merged), then the rest once 0780 lands.
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS.filter(m => m.name !== EARLY))
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const targetOrder = await byId(e.RESTORE_DB)
  const sourceOrder = await byId(e.DB)
  expect(targetOrder.indexOf(LATE)).toBeLessThan(targetOrder.indexOf(EARLY))
  expect(sourceOrder.indexOf(EARLY)).toBeLessThan(sourceOrder.indexOf(LATE))
  // The rule the restore used before #585 (the last row by id) would refuse this pair.
  expect(targetOrder.at(-1)).not.toBe(sourceOrder.at(-1))
  expect([...targetOrder].sort()).toEqual([...sourceOrder].sort())

  await seedBrand(e.DB, openStores(e), T)
  const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: T + 1 })
  // Failure 2.
  expect(manifest.migrations).toEqual([...sourceOrder].sort())
  expect(manifest.migration).toBe([...sourceOrder].sort().at(-1))

  const record = await restore({
    bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId,
    at: { actorId: SYSTEM_MEMBER_ID, requestId: 'req-rt-migration-order', nowMs: T + 2 }, resetAfterRestore: [],
  })
  // Failure 1.
  expect(record.status, record.reason).toBe('restored_unreconciled')
  // Failure 3.
  expect(record.d1.tables.length).toBeGreaterThan(0)
  expect(record.d1.tables.every(t => t.verified)).toBe(true)
  expect(await dumpCanonical(e.RESTORE_DB)).toEqual(await dumpCanonical(e.DB))
})
