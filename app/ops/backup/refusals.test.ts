// The restore's refusals and its snapshot step, before any write. Ways it can fail, written down first:
//  1. a backup that's missing, incomplete, corrupted (any single byte of any part), counted wrong, of another format
//     or migration level, or with other columns, is written into the target anyway, or only partly;
//  2. a target that isn't freshly migrated (an extra row, a seeded row that differs) is written over;
//  3. a refusal leaves no record, or a record that doesn't say `refused` and why;
//  4. a readable live database whose snapshot fails still lets the restore write; a target write comes first.
import { fc, test } from '@fast-check/vitest'
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { backupManifestKey, backupPartKey, restoreKey } from '../../server/db/r2-keys.ts'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import { backup, timeId } from './backup.ts'
import { RestoreRecordSchema } from './manifest.ts'
import type { BackupManifest, RestoreRecord } from './manifest.ts'
import { restore } from './restore.ts'
import { dumpCanonical, failingDb } from './test-support.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
await seedBrand(e.DB, openStores(e), T)
const good = await backup({ db: e.DB, bucket: e.FILES, nowMs: T })
const targetAsMigrated = await dumpCanonical(e.RESTORE_DB)
const at = { actorId: SYSTEM_MEMBER_ID, requestId: 'req-refusal', nowMs: T + 10 }

/** A copy of the good backup under a new id, its manifest and part bytes changed by `change`. */
async function copyBackup(change: { manifest?: (m: BackupManifest) => unknown; part?: (table: string, part: number, bytes: Uint8Array) => Uint8Array | null } = {}): Promise<string> {
  const id = timeId(T)
  const m: BackupManifest = structuredClone(good)
  m.backupId = id
  for (const t of m.tables) {
    for (const [i, p] of t.parts.entries()) {
      p.key = backupPartKey(id, t.name, i)
      const bytes = new Uint8Array(await (await e.FILES.get(backupPartKey(good.backupId, t.name, i)))!.arrayBuffer())
      const out = change.part ? change.part(t.name, i, bytes) : bytes
      if (out) await e.FILES.put(p.key, out)
    }
  }
  const body = change.manifest ? change.manifest(m) : m
  if (body !== null) await e.FILES.put(backupManifestKey(id), typeof body === 'string' ? body : JSON.stringify(body))
  return id
}

/** A restore that must refuse: the reason, the target untouched, the record stored and saying so. */
async function expectRefused(backupId: string, reason: RegExp): Promise<RestoreRecord> {
  let wrote = false
  const record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId, at, testing: { beforeTargetWrite: async () => { wrote = true } } })
  expect(record.status).toBe('refused')
  expect(record.reason).toMatch(reason)
  expect(wrote).toBe(false)
  expect(await dumpCanonical(e.RESTORE_DB)).toEqual(targetAsMigrated)
  const stored = RestoreRecordSchema.parse(JSON.parse(await (await e.FILES.get(restoreKey(record.restoreId, 'record.json')))!.text()))
  expect(stored).toEqual(record)
  // The snapshot came first, even for a refusal.
  expect(record.snapshot).toMatchObject({ key: restoreKey(record.restoreId, 'snapshot/manifest.json') })
  expect(record).toMatchObject({ reconciled: false, durableObjects: [], source: 'r2-backup', actorId: SYSTEM_MEMBER_ID, r2: { prefixes: [], missingPhotoKeys: [] } })
  expect(record.d1.tables.every(t => !t.verified)).toBe(true)
  return record
}

describe('a backup that is wrong (failures 1, 3)', () => {
  it('refuses a backup with no manifest', async () => {
    const r = await expectRefused(await copyBackup({ manifest: () => null }), /^manifest_missing/)
    expect(r).toMatchObject({ backup: { takenAtMs: null, migration: null }, d1: { restorePointMs: null, tables: [] }, watermarkMs: null })
  })
  it('refuses an id that is no backup at all', async () => {
    await expectRefused('nothing-here', /^manifest_missing/)
  })
  it('refuses a manifest that does not parse', async () => {
    await expectRefused(await copyBackup({ manifest: () => '{"format":1,' }), /^manifest_invalid/)
    await expectRefused(await copyBackup({ manifest: m => ({ ...m, tables: 'none' }) }), /^manifest_invalid/)
  })
  it('refuses another format', async () => {
    await expectRefused(await copyBackup({ manifest: m => ({ ...m, format: 2 }) }), /^format_unsupported: 2/)
  })
  it('refuses another migration level', async () => {
    const r = await expectRefused(await copyBackup({ manifest: m => ({ ...m, migration: '0004_audit_log.sql' }) }), /^migration_mismatch/)
    expect(r.watermarkMs).toBe(T)
  })
  it('refuses other columns', async () => {
    await expectRefused(await copyBackup({ manifest: m => ({ ...m, tables: m.tables.map(t => (t.name === 'settings' ? { ...t, columns: [...t.columns, 'extra'] } : t)) }) }), /^columns_mismatch: settings/)
  })
  it('refuses a backup that lacks a canonical table', async () => {
    await expectRefused(await copyBackup({ manifest: m => ({ ...m, tables: m.tables.filter(t => t.name !== 'support_grants') }) }), /^tables_mismatch/)
  })
  it('refuses a backup whose derived tables differ from the target\'s', async () => {
    await expectRefused(await copyBackup({ manifest: m => ({ ...m, derived: [{ name: 'search_q', from: ['settings'] }] }) }), /^tables_mismatch: derived/)
  })
  it('refuses a missing part', async () => {
    await expectRefused(await copyBackup({ part: (table, n, bytes) => (table === 'audit_log' && n === 0 ? null : bytes) }), /^part_missing: audit_log\/00000/)
  })
  it('refuses a row count that disagrees', async () => {
    await expectRefused(await copyBackup({ manifest: m => ({ ...m, tables: m.tables.map(t => (t.name === 'members' ? { ...t, parts: t.parts.map(p => ({ ...p, rows: p.rows + 1 })) } : t)) }) }), /^part_rows: members/)
    await expectRefused(await copyBackup({ manifest: m => ({ ...m, tables: m.tables.map(t => (t.name === 'members' ? { ...t, rows: t.rows + 1 } : t)) }) }), /^part_rows: members/)
  })
  const sizes = good.tables.flatMap(t => t.parts.map((p, i) => ({ table: t.name, part: i, rows: p.rows })))
  test.prop([fc.constantFrom(...sizes), fc.nat(), fc.integer({ min: 1, max: 255 })], { numRuns: 30 })('refuses any single changed byte in any part', async (where, pos, flip) => {
    const id = await copyBackup({
      part: (table, n, bytes) => {
        if (table !== where.table || n !== where.part) return bytes
        const out = bytes.slice()
        out[pos % out.length] ^= flip
        return out
      },
    })
    await expectRefused(id, new RegExp(`^part_sha256: ${where.table}/${String(where.part).padStart(5, '0')}$`))
  })
})

describe('a target that is not freshly migrated (failures 2, 3)', () => {
  it('refuses a target with a row the backup lacks', async () => {
    await e.RESTORE_DB.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 'stray', 'null', 1, 0, 'm_system', 'r')").run()
    const stray = await dumpCanonical(e.RESTORE_DB)
    const record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: good.backupId, at })
    expect(record).toMatchObject({ status: 'refused', reason: 'target_not_empty: settings' })
    expect(await dumpCanonical(e.RESTORE_DB)).toEqual(stray)
    await e.RESTORE_DB.prepare("DELETE FROM settings WHERE key = 'stray'").run()
    expect(await dumpCanonical(e.RESTORE_DB)).toEqual(targetAsMigrated)
  })
  it('refuses a target whose seeded row differs from the backup', async () => {
    await e.RESTORE_DB.prepare("UPDATE members SET name = 'Changed' WHERE id = 'm_smoke'").run()
    const changed = await dumpCanonical(e.RESTORE_DB)
    const record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: good.backupId, at })
    expect(record).toMatchObject({ status: 'refused', reason: 'seeded_row_differs: members' })
    expect(await dumpCanonical(e.RESTORE_DB)).toEqual(changed)
    await e.RESTORE_DB.prepare("UPDATE members SET name = 'Smoke check' WHERE id = 'm_smoke'").run()
    expect(await dumpCanonical(e.RESTORE_DB)).toEqual(targetAsMigrated)
  })
})

describe('the snapshot first (failure 4)', () => {
  it('stops before any write when a readable live database fails its snapshot', async () => {
    let wrote = false
    const record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: failingDb(), backupId: good.backupId, at, testing: { beforeTargetWrite: async () => { wrote = true } } })
    expect(record).toMatchObject({ status: 'failed', snapshot: null, reconciled: false, backup: { backupId: good.backupId, takenAtMs: null } })
    expect(record.reason).toMatch(/^snapshot_failed: D1 is down/)
    expect(wrote).toBe(false)
    expect(await dumpCanonical(e.RESTORE_DB)).toEqual(targetAsMigrated)
    expect(await e.FILES.head(restoreKey(record.restoreId, 'snapshot/manifest.json'))).toBeNull()
    expect(RestoreRecordSchema.parse(JSON.parse(await (await e.FILES.get(restoreKey(record.restoreId, 'record.json')))!.text()))).toEqual(record)
  })
  it('records the gap and goes on when live is unreadable', async () => {
    const record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: 'unreadable', backupId: await copyBackup({ manifest: m => ({ ...m, format: 3 }) }), at })
    // It went past the snapshot to the backup's check.
    expect(record).toMatchObject({ status: 'refused', reason: 'format_unsupported: 3', snapshot: { gap: 'unreadable' } })
  })
})
