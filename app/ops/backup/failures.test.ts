// The restore's `failed` records after its checks passed: a write that fails, and a reset hook that fails on a proven
// target. Its own file: the reset case needs a full write into a fresh target. Ways it can fail, written down first:
//  1. a write that fails leaves no record, or a record that claims success or a refusal;
//  2. a failing reset hook is swallowed, so a target with a stale job cursor is reported as restored.
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { restoreKey } from '../../server/db/r2-keys.ts'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import { backup } from './backup.ts'
import { RestoreRecordSchema } from './manifest.ts'
import { restore } from './restore.ts'
import { dumpCanonical } from './test-support.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
await seedBrand(e.DB, openStores(e), T)
const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: T })
const at = { actorId: SYSTEM_MEMBER_ID, requestId: 'req-failure', nowMs: T + 1 }
const stored = async (restoreId: string) => RestoreRecordSchema.parse(JSON.parse(await (await e.FILES.get(restoreKey(restoreId, 'record.json')))!.text()))

it('records `failed` when a write fails (failure 1)', async () => {
  const asMigrated = await dumpCanonical(e.RESTORE_DB)
  // A target whose every insert fails; the first one fails whole (one statement), so the target stays empty.
  const target = {
    prepare: (q: string) => { if (q.startsWith('INSERT')) throw new Error('write refused (test)'); return e.RESTORE_DB.prepare(q) },
    batch: (s: D1PreparedStatement[]) => e.RESTORE_DB.batch(s),
  } as unknown as D1Database
  const record = await restore({ bucket: e.FILES, target, live: e.DB, backupId: manifest.backupId, at })
  expect(record).toMatchObject({ status: 'failed', reason: 'error: write refused (test)', resets: [], r2: { prefixes: [], missingPhotoKeys: [] }, watermarkMs: T })
  expect(record.d1.tables.every(t => !t.verified)).toBe(true)
  expect(await stored(record.restoreId)).toEqual(record)
  expect(await dumpCanonical(e.RESTORE_DB)).toEqual(asMigrated)
})

it('records `failed` when a reset hook fails on a proven target (failure 2)', async () => {
  const ran: string[] = []
  const record = await restore({
    bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at,
    resetAfterRestore: [
      { name: 'first-cursor', run: async () => { ran.push('first-cursor') } },
      { name: 'broken-cursor', run: async () => { throw new Error('cursor table missing (test)') } },
      { name: 'never-reached', run: async () => { ran.push('never-reached') } },
    ],
  })
  expect(ran).toEqual(['first-cursor'])
  expect(record).toMatchObject({ status: 'failed', reason: 'reset_failed: broken-cursor: cursor table missing (test)', resets: ['first-cursor'] })
  // The write and the proof had passed.
  expect(record.d1.tables.every(t => t.verified)).toBe(true)
  expect(await stored(record.restoreId)).toEqual(record)
})
