// No path marks a restore `restored` before the audit re-append, the deletion-log replay and the confirm (P8a R;
// must-not list). Ways it can fail, written down first:
//  1. a store whose person-deletion runner isn't built (the chat cascade, the bell) is skipped, so its rows come back;
//     the replay must refuse by name, write nothing of the replay, and leave the record unreconciled;
//  2. a Durable Object a deletion reaches has no recorded recovery time, and the replay guesses one;
//  3. the record schema takes `restored` without each step, or `reconciled: true` without `restored`;
//  4. a deletion logged after the replay read the log is lost because the confirm doesn't look;
//  5. a member who isn't an active Admin confirms;
//  6. the reconcile goes on (or appends audit lines) when the FTS rebuild, its first step, didn't rebuild.
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { restoreKey } from '../../../server/db/r2-keys.ts'
import { openStores } from '../../../server/db/stores.ts'
import type { PersonDataAnswer } from '../../../server/do/brand-agent/ports.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import { writeLogEntry } from '../../delete/log.ts'
import { planPersonDeletion, runPersonDeletion } from '../../delete/person.ts'
import { tables } from '../../tables/index.ts'
import { backup } from '../backup.ts'
import { RestoreRecordSchema } from '../manifest.ts'
import type { RestoreRecord } from '../manifest.ts'
import { restore } from '../restore.ts'
import { brandAgentRunner, confirmRestore, reconcile } from './index.ts'
import { ftsStub } from './test-support.ts'
import { readRecord } from './record.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
const at = (nowMs: number, actorId = SYSTEM_MEMBER_ID) => ({ actorId, requestId: `req-refuse-${nowMs}`, nowMs })
const NAMES = ['members', 'settings', 'support_grants', 'audit_log', 'photos/', 'backups/', 'restore/', 'deletion-log/']
const runners = () => ({ BrandAgent: brandAgentRunner(e.BRAND_AGENT.getByName('refusals') as unknown as { personData(p: { personId: string; mode: 'count' | 'delete' }): Promise<PersonDataAnswer> }) })
let ids: { admin: string; dana: string }
let record: RestoreRecord
const danaRow = () => e.RESTORE_DB.prepare('SELECT * FROM members WHERE id = ?').bind(ids.dana).first()

beforeAll(async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const { members } = await seedBrand(e.DB, openStores(e), T)
  ids = { admin: members.admin, dana: members.dana }
  const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: T + 10 })
  const deps = { db: e.DB, bucket: e.FILES, at: at(T + 20), clock: () => T + 20, registry: tables.filter(t => NAMES.includes(t.name)) }
  const plan = await planPersonDeletion(deps, { memberId: ids.dana })
  if (!('ok' in plan)) throw new Error('plan refused')
  if (!('ok' in await runPersonDeletion(deps, plan.ok))) throw new Error('run refused')
  record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(T + 30), durableObjects: [{ name: 'BrandAgent', recoveredAtMs: T + 10 }] })
})

it('stops before the audit re-append when the FTS rebuild didn\'t rebuild', async () => {
  const lines = async () => (await e.RESTORE_DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>())?.n
  const before = await lines()
  const fts = ftsStub('failed')
  const out = await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: fts.rebuildFts, at: at(T + 35), runners: runners() })
  expect(out).toMatchObject({ refused: 'fts_rebuild_failed: failed', record: { status: 'restored_unreconciled', reconcile: { audit: null, replay: null } } })
  expect(fts.calls).toBe(1)
  expect(await lines()).toBe(before)
})

it('refuses by name a store whose runner isn\'t built, writes nothing of the replay, and stays unreconciled (real registry)', async () => {
  expect(record.status).toBe('restored_unreconciled')
  const before = await danaRow()
  const out = await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 40), runners: runners() })
  expect(out).toMatchObject({ refused: "replay_custom_unrun: chats's rule is custom and its runner isn't built yet" })
  expect(await readRecord(e.FILES, record.restoreId)).toMatchObject({ status: 'restored_unreconciled', reconciled: false, reconcile: { audit: null, replay: null, refusal: "replay_custom_unrun: chats's rule is custom and its runner isn't built yet" } })
  expect(await danaRow()).toEqual(before)
  expect(await confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(T + 45, ids.admin) })).toMatchObject({ refused: 'not_reconciled: audit' })
})

it('refuses a Durable Object a deletion reaches with no recorded recovery time', async () => {
  const stored = await readRecord(e.FILES, record.restoreId)
  await e.FILES.put(restoreKey(record.restoreId, 'record.json'), JSON.stringify({ ...stored, durableObjects: [] }))
  const out = await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 50), registry: tables.filter(t => [...NAMES, 'BrandAgent'].includes(t.name)), runners: runners() })
  expect(out).toMatchObject({ refused: 'do_recovery_unrecorded: BrandAgent' })
  await e.FILES.put(restoreKey(record.restoreId, 'record.json'), JSON.stringify(stored))
})

it('the record schema refuses restored without every step and the confirm', () => {
  const steps = { audit: { source: 'snapshot', afterId: 1, throughId: 1, appended: 0, gap: null }, outbox: 'p8b_pending', replay: { watermarkMs: T, throughKey: null, runs: [], skippedRefused: [] }, confirm: { actorId: ids.admin, atMs: T, auditId: 2 }, refusal: null } as const
  const base = { ...record, status: 'restored', reconciled: true }
  expect(RestoreRecordSchema.safeParse({ ...base, reconcile: steps }).success).toBe(true)
  for (const missing of ['audit', 'replay', 'confirm'] as const) expect(RestoreRecordSchema.safeParse({ ...base, reconcile: { ...steps, [missing]: null } }).success, missing).toBe(false)
  expect(RestoreRecordSchema.safeParse({ ...base, reconcile: null }).success).toBe(false)
  expect(RestoreRecordSchema.safeParse({ ...record, reconciled: true }).success).toBe(false)
  expect(RestoreRecordSchema.safeParse({ ...base, reconciled: false, reconcile: steps }).success).toBe(false)
})

it('a confirm refuses a non-Admin and a deletion logged after the replay; a new reconcile then lets it through', async () => {
  const deps = { bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 60), registry: tables.filter(t => [...NAMES, 'BrandAgent'].includes(t.name)), runners: runners() }
  const ok = await reconcile(deps)
  if (!('ok' in ok)) throw new Error(ok.refused)
  expect(ok.ok.reconcile?.replay?.runs).toHaveLength(1)
  expect(await confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(T + 61, ids.dana) })).toMatchObject({ refused: 'not_admin' })
  await writeLogEntry(e.FILES, { format: 1, runId: '00000000000000aa', step: 0, phase: 'start', kind: 'retention', atMs: T + 62, actorId: SYSTEM_MEMBER_ID, cutoffs: [] })
  expect(await confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(T + 63, ids.admin) })).toMatchObject({ refused: 'replay_stale' })
  expect((await readRecord(e.FILES, record.restoreId)).status).toBe('restored_unreconciled')
  const again = await reconcile({ ...deps, at: at(T + 64) })
  if (!('ok' in again)) throw new Error(again.refused)
  expect(again.ok.reconcile?.replay?.runs.map(r => r.kind)).toEqual(['person', 'retention'])
  expect(await confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(T + 65, ids.admin) })).toMatchObject({ ok: { status: 'restored' } })
})
