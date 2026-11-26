// No path marks a restore `restored` before the audit re-append, the deletion-log replay and the confirm (P8a R;
// must-not list). Ways it can fail, written down first:
//  1. a store whose person-deletion runner isn't built (the chat cascade, the bell) is skipped, so its rows come back;
//     the replay must refuse by name, write nothing of the replay, and leave the record unreconciled;
//  2. a Durable Object a deletion reaches has no recorded recovery time, and the replay guesses one;
//  3. the record schema takes `restored` without each step, or `reconciled: true` without `restored`;
//  4. a deletion logged after the replay read the log is lost because the confirm doesn't look;
//  5. a member who isn't an active Admin confirms;
//  6. the reconcile goes on (or appends audit lines) when the FTS rebuild, its first step, didn't rebuild;
//  7. (review M1) a run a `refused` entry stopped is replayed (here: pseudonymising the last Admin);
//  8. (review L2) a record write lands over a record another run wrote since it was read;
//  9. (review L6) a record from before the reconcile throws a schema error instead of refusing by name.
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { deletionLogKey, restoreKey } from '../../../server/db/r2-keys.ts'
import { openStores } from '../../../server/db/stores.ts'
import type { PersonDataAnswer } from '../../../server/do/brand-agent/ports.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import { newRunId, writeLogEntry } from '../../delete/log.ts'
import { planPersonDeletion, runPersonDeletion } from '../../delete/person.ts'
import { tables } from '../../tables/index.ts'
import { backup } from '../backup.ts'
import { RestoreRecordSchema } from '../manifest.ts'
import type { RestoreRecord } from '../manifest.ts'
import { restore } from '../restore.ts'
import { brandAgentRunner, confirmRestore, reconcile } from './index.ts'
import { ftsStub } from './test-support.ts'
import { readRecord, writeRecord } from './record.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
const at = (nowMs: number, actorId = SYSTEM_MEMBER_ID) => ({ actorId, requestId: `req-refuse-${nowMs}`, nowMs })
const NAMES = ['members', 'settings', 'support_grants', 'audit_log', 'photos/', 'backups/', 'restore/', 'deletion-log/']
const runners = () => ({ BrandAgent: brandAgentRunner(e.BRAND_AGENT.getByName('refusals') as unknown as { personData(p: { personId: string; mode: 'count' | 'delete' }): Promise<PersonDataAnswer> }) })
let ids: { admin: string; dana: string; inhouse: string }
let record: RestoreRecord
const refusedRun = newRunId()
const row = (id: string) => e.RESTORE_DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first()
const fixture = tables.filter(t => [...NAMES, 'BrandAgent'].includes(t.name))
const stored = async () => (await readRecord(e.FILES, record.restoreId)).record
const confirm = (nowMs: number, actorId: string, approvedBy: string) => confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(nowMs, actorId), approvedBy })

beforeAll(async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const { members } = await seedBrand(e.DB, openStores(e), T)
  ids = { admin: members.admin, dana: members.dana, inhouse: members.inhouse }
  const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: T + 10 })
  const deps = { db: e.DB, bucket: e.FILES, at: at(T + 20), clock: () => T + 20, registry: tables.filter(t => NAMES.includes(t.name)) }
  const plan = await planPersonDeletion(deps, { memberId: ids.dana })
  if (!('ok' in plan)) throw new Error('plan refused')
  if (!('ok' in await runPersonDeletion(deps, plan.ok))) throw new Error('run refused')
  // A person deletion of the only Admin, logged and then refused at pseudonymise (P2's last-Admin guard): it removed nothing.
  for (const [step, phase] of [[0, 'start'], [1, 'refused']] as const) {
    await writeLogEntry(e.FILES, { format: 1, runId: refusedRun, step, phase, kind: 'person', atMs: T + 25, actorId: SYSTEM_MEMBER_ID, memberId: ids.admin, ...(phase === 'refused' ? { reason: 'last_admin' } : {}) })
  }
  record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(T + 30), durableObjects: [{ name: 'BrandAgent', recoveredAtMs: T + 10 }] })
})

it('stops before the audit re-append when the FTS rebuild didn\'t rebuild', async () => {
  const lines = async () => (await e.RESTORE_DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>())?.n
  const before = await lines()
  const fts = ftsStub('failed')
  const out = await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: fts.rebuildFts, at: at(T + 35), runners: runners() })
  expect(out).toMatchObject({ refused: 'fts_rebuild_failed: failed', record: { status: 'restored_unreconciled', reconcile: { fts: null, audit: null, replay: null } } })
  expect(fts.calls).toBe(1)
  expect(await lines()).toBe(before)
})

it('returns, never throws, a record changed by another run while this one refused (L-d)', async () => {
  const kept = await stored()
  // Another run writes the record while this one's FTS step is running; this one's step then fails.
  const racing = async () => {
    await e.FILES.put(restoreKey(record.restoreId, 'record.json'), JSON.stringify({ ...kept, reconcile: { ...(kept.reconcile ?? {}), refusal: 'another_run' } }))
    return { failed: 'racing' } as const
  }
  const out = await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: racing, at: at(T + 36), runners: runners() })
  expect(out).toEqual({ refused: `fts_rebuild_failed: racing (and record_changed: ${record.restoreId})`, record: null })
  expect((await stored()).reconcile?.refusal).toBe('another_run')
  await e.FILES.put(restoreKey(record.restoreId, 'record.json'), JSON.stringify(kept))
})

it('refuses by name when the recovered BrandAgent person runner is missing and writes nothing of the replay', async () => {
  expect(record.status).toBe('restored_unreconciled')
  const before = await row(ids.dana)
  const out = await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 40) })
  const refusal = "replay_custom_unrun: BrandAgent's rule is custom and its runner isn't built yet"
  expect(out).toMatchObject({ refused: refusal })
  expect(await stored()).toMatchObject({ status: 'restored_unreconciled', reconciled: false, reconcile: { audit: null, replay: null, refusal } })
  expect(await row(ids.dana)).toEqual(before)
  expect(await confirm(T + 45, ids.inhouse, ids.admin)).toMatchObject({ refused: 'not_reconciled: audit' })
})

it('refuses a Durable Object a deletion reaches with no recorded recovery time', async () => {
  const kept = await stored()
  await e.FILES.put(restoreKey(record.restoreId, 'record.json'), JSON.stringify({ ...kept, durableObjects: [] }))
  const out = await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 50), registry: fixture, runners: runners() })
  expect(out).toMatchObject({ refused: 'do_recovery_unrecorded: BrandAgent' })
  await e.FILES.put(restoreKey(record.restoreId, 'record.json'), JSON.stringify(kept))
})

it('refuses a record from before the reconcile by name, and a write over a record changed since it was read', async () => {
  const kept = await stored()
  const { reconcile: _gone, ...old } = kept
  await e.FILES.put(restoreKey(record.restoreId, 'record.json'), JSON.stringify(old))
  expect(await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 51), registry: fixture, runners: runners() })).toMatchObject({ refused: `record_pre_reconcile: ${record.restoreId}`, record: null })
  await e.FILES.put(restoreKey(record.restoreId, 'record.json'), JSON.stringify(kept))
  // Another run writes first (an etag is the content's, so it writes something else); the stale write then refuses.
  const { etag } = await readRecord(e.FILES, record.restoreId)
  const other = { ...kept, reconcile: { ...(kept.reconcile as NonNullable<typeof kept.reconcile>), refusal: 'another_run' } }
  await writeRecord(e.FILES, other, etag)
  await expect(writeRecord(e.FILES, kept, etag)).rejects.toMatchObject({ reason: `record_changed: ${record.restoreId}` })
  expect(await stored()).toEqual(other)
  await e.FILES.put(restoreKey(record.restoreId, 'record.json'), JSON.stringify(kept))
})

it('the record schema refuses restored without every step, with a refusal, or with an index not rebuilt', () => {
  const steps = {
    fts: 'rebuilt', audit: { source: 'snapshot', afterId: 1, throughId: 1, appended: 0, gap: null, placeholders: [] }, members: { removed: [], roles: [] }, outbox: { held: [], revoked: [], closed: [] },
    replay: { watermarkMs: T, throughKey: null, runs: [], skippedRefused: [] }, confirm: { actorId: ids.inhouse, approvedBy: ids.admin, atMs: T, auditId: 2 }, refusal: null,
  } as const
  const base = { ...record, status: 'restored', reconciled: true, d1: { ...record.d1, derived: record.d1.derived.map(d => ({ ...d, state: 'rebuilt' })) } }
  expect(record.d1.derived.length).toBeGreaterThan(0)
  expect(RestoreRecordSchema.safeParse({ ...base, reconcile: steps }).success).toBe(true)
  // A record written before the outbox hold existed (`p8b_pending`) still parses as restored; a new confirm refuses it.
  expect(RestoreRecordSchema.safeParse({ ...base, reconcile: { ...steps, outbox: 'p8b_pending' } }).success).toBe(true)
  for (const missing of ['fts', 'audit', 'members', 'outbox', 'replay', 'confirm'] as const) expect(RestoreRecordSchema.safeParse({ ...base, reconcile: { ...steps, [missing]: null } }).success, missing).toBe(false)
  expect(RestoreRecordSchema.safeParse({ ...base, reconcile: { ...steps, refusal: 'x' } }).success).toBe(false)
  expect(RestoreRecordSchema.safeParse({ ...base, d1: record.d1, reconcile: steps }).success).toBe(false)
  expect(RestoreRecordSchema.safeParse({ ...base, reconcile: null }).success).toBe(false)
  expect(RestoreRecordSchema.safeParse({ ...record, reconciled: true }).success).toBe(false)
  expect(RestoreRecordSchema.safeParse({ ...base, reconciled: false, reconcile: steps }).success).toBe(false)
})

it('records deletion_log_invalid when replayRetention hits a missing cutoff tag instead of throwing a plain Error', async () => {
  const badRestoreId = 'refusal-missing-tag'
  const badKey = deletionLogKey(T + 66, '00000000000000cc', 0, 'done')
  await e.FILES.put(restoreKey(badRestoreId, 'record.json'), JSON.stringify({
    ...record, restoreId: badRestoreId, status: 'restored_unreconciled', reconciled: false, reconcile: null,
    durableObjects: [{ name: 'BrandAgent', recoveredAtMs: T + 100_000 }],
  }))
  await e.FILES.put(badKey, JSON.stringify({
    format: 1, runId: '00000000000000cc', step: 0, phase: 'done', kind: 'retention', atMs: T + 66, actorId: SYSTEM_MEMBER_ID,
    cutoffs: [{ store: 'chats', cutoffMs: 1 }],
  }))
  try {
    const withChats = [...fixture, tables.find(t => t.name === 'chats')!]
    const out = await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: badRestoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 70), registry: withChats, runners: runners() })
    expect(out).toMatchObject({
      refused: expect.stringMatching(/^deletion_log_invalid: .*chats.*trash/),
      record: { status: 'restored_unreconciled', reconcile: { replay: null, refusal: expect.stringMatching(/^deletion_log_invalid: /) } },
    })
    expect((await readRecord(e.FILES, badRestoreId)).record.reconcile?.refusal).toMatch(/^deletion_log_invalid: /)
  } finally {
    await e.FILES.delete(badKey)
  }
})

it('skips a refused run (the Admin stays as restored), refuses a deletion logged after the replay, then lets a new reconcile through', async () => {
  const deps = { bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 60), registry: fixture, runners: runners() }
  const adminBefore = await row(ids.admin)
  const ok = await reconcile(deps)
  if (!('ok' in ok)) throw new Error(ok.refused)
  expect(ok.ok.reconcile?.replay).toMatchObject({ skippedRefused: [refusedRun] })
  expect(ok.ok.reconcile?.replay?.runs.map(r => r.kind)).toEqual(['person'])
  expect(await row(ids.admin)).toEqual(adminBefore)
  expect(await confirm(T + 61, ids.inhouse, ids.dana)).toMatchObject({ refused: 'not_admin' })
  await writeLogEntry(e.FILES, { format: 1, runId: '00000000000000aa', step: 0, phase: 'start', kind: 'retention', atMs: T + 62, actorId: SYSTEM_MEMBER_ID, cutoffs: [] })
  expect(await confirm(T + 63, ids.inhouse, ids.admin)).toMatchObject({ refused: 'replay_stale' })
  expect((await stored()).status).toBe('restored_unreconciled')
  const again = await reconcile({ ...deps, at: at(T + 64) })
  if (!('ok' in again)) throw new Error(again.refused)
  expect(again.ok.reconcile?.replay?.runs.map(r => r.kind)).toEqual(['person', 'retention'])
  expect(await confirm(T + 65, ids.inhouse, ids.admin)).toMatchObject({ ok: { status: 'restored', reconcile: { confirm: { actorId: ids.inhouse, approvedBy: ids.admin } } } })
})
