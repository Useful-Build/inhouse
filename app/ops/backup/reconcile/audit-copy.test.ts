// The audit re-append from the daily copy (P8a R, step 3): when the pre-restore snapshot recorded the live audit log
// as unreadable. Ways it can fail, written down first:
//  1. the lines the daily copy holds past the backup don't come back, or come back twice on a re-run;
//  2. lines the live database held after the last copy are silently missing: the record must name the gap;
//  3. a copy line that disagrees with the target (something else wrote it) is skipped instead of refusing.
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import { copyAuditLog } from '../../../server/audit-copy.ts'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { openStores } from '../../../server/db/stores.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import { addLine } from '../../delete/test-support.ts'
import { tables } from '../../tables/index.ts'
import { backup } from '../backup.ts'
import type { RestoreRecord } from '../manifest.ts'
import { restore } from '../restore.ts'
import { reconcile } from './index.ts'
import { ftsStub } from './test-support.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
const at = (nowMs: number) => ({ actorId: SYSTEM_MEMBER_ID, requestId: `req-copy-${nowMs}`, nowMs })
// No deletion is logged here, so the replay has nothing to do; the BrandAgent is left out (no recovery time to record).
const registry = tables.filter(t => ['members', 'settings', 'support_grants', 'audit_log', 'photos/', 'backups/', 'restore/', 'deletion-log/'].includes(t.name))
let record: RestoreRecord
let backupMaxId: number
let copied: Record<string, unknown>[]
let uncopiedId: number

beforeAll(async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const { members } = await seedBrand(e.DB, openStores(e), T)
  const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: T + 10 })
  backupMaxId = manifest.tables.find(t => t.name === 'audit_log')?.maxId as number
  for (let i = 0; i < 4; i++) await addLine(e.DB, members.admin, null, { n: i }, T + 20 + i)
  // The daily copy runs, then one more line lands that no copy holds before the live database becomes unreadable.
  await copyAuditLog({ db: e.DB, files: e.FILES, nowMs: T + 30 })
  copied = (await e.DB.prepare('SELECT * FROM audit_log WHERE id > ? ORDER BY id').bind(backupMaxId).all()).results
  await addLine(e.DB, members.admin, null, { n: 'late' }, T + 40)
  uncopiedId = (await e.DB.prepare('SELECT MAX(id) AS id FROM audit_log').first<{ id: number }>())?.id as number
  record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: 'unreadable', backupId: manifest.backupId, at: at(T + 50) })
})

it('appends the copied lines past the backup once, and records the gap after the last one', async () => {
  expect(record).toMatchObject({ status: 'restored_unreconciled', snapshot: { gap: 'unreadable' } })
  const deps = { bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 60), registry }
  const first = await reconcile(deps)
  if (!('ok' in first)) throw new Error(first.refused)
  const lastCopied = copied[copied.length - 1].id as number
  expect(first.ok.reconcile?.audit).toEqual({ source: 'audit_copy', afterId: backupMaxId, throughId: lastCopied, appended: copied.length, gap: { afterId: lastCopied, reason: 'live_unreadable' } })
  expect(uncopiedId).toBeGreaterThan(lastCopied)
  expect((await e.RESTORE_DB.prepare('SELECT * FROM audit_log WHERE id > ? ORDER BY id').bind(backupMaxId).all()).results).toEqual(copied)

  const again = await reconcile(deps)
  if (!('ok' in again)) throw new Error(again.refused)
  expect(again.ok.reconcile?.audit).toMatchObject({ appended: 0, throughId: lastCopied })
  expect((await e.RESTORE_DB.prepare('SELECT * FROM audit_log WHERE id > ? ORDER BY id').bind(backupMaxId).all()).results).toEqual(copied)
})

it('refuses a target line that differs from the copy, and records the refusal', async () => {
  const id = (copied[copied.length - 1].id as number) + 1
  await e.RESTORE_DB.prepare("INSERT INTO audit_log (id, at_ms, actor_id, action, args_json, req_id) VALUES (?, 1, 'm_system', 'test.other', '{}', 'req-other')").bind(id).run()
  const out = await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 70), registry })
  expect(out).toMatchObject({ refused: `audit_conflict: the target has line ${id} the source lacks`, record: { status: 'restored_unreconciled', reconcile: { audit: null, replay: null, refusal: `audit_conflict: the target has line ${id} the source lacks` } } })
})
