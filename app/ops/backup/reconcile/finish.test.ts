// P8a R's core proof (acceptance 1 and 2): a restore finishes at `restored` only after the audit re-append, the
// deletion-log replay and an admin's audited confirm, and a person deleted after the backup stays gone across D1, R2
// and the Durable Objects. Ways it can fail, written down first:
//  1. a person deleted after the backup comes back in D1 (member row, owned rows), R2 (their objects) or the
//     BrandAgent's storage once the restore finishes;
//  2. an entry logged before the backup's point is applied to the restored D1 (C1 review M2), or skipped for a Durable
//     Object rewound to before it;
//  3. the audit lines newer than the backup don't come back, come back twice on a re-run, or come back with new ids;
//  4. the restore reads `restored` before the confirm, or the confirm writes no audit line or two.
// The Durable Object's point-in-time recovery doesn't run locally (Cloudflare's PITR API is not supported in local
// development), so the test rewinds it by hand: the rows its deletions removed are put back, as a recovery to an
// earlier time would leave them, and the restore records that time.
import { applyD1Migrations, runInDurableObject } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { openStores } from '../../../server/db/stores.ts'
import type { PersonDataAnswer } from '../../../server/do/brand-agent/ports.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import { planPersonDeletion, runPersonDeletion } from '../../delete/person.ts'
import { addLine, addPhoto, addSetting } from '../../delete/test-support.ts'
import { tables } from '../../tables/index.ts'
import { backup } from '../backup.ts'
import { restore } from '../restore.ts'
import type { RestoreRecord } from '../manifest.ts'
import { brandAgentRunner, confirmRestore, reconcile } from './index.ts'
import { ftsStub } from './test-support.ts'
import { readRecord } from './record.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
const at = (nowMs: number, actorId = SYSTEM_MEMBER_ID) => ({ actorId, requestId: `req-finish-${nowMs}`, nowMs })
/** P2's stores and the BrandAgent: what G2's person deletion runs on today (C1's runners for the rest aren't built). */
const NAMES = ['members', 'settings', 'support_grants', 'audit_log', 'photos/', 'backups/', 'restore/', 'deletion-log/']
const g2Registry = tables.filter(t => NAMES.includes(t.name))
const replayRegistry = tables.filter(t => [...NAMES, 'BrandAgent'].includes(t.name))
const agent = () => e.BRAND_AGENT.getByName('restore-proof')
const rpc = () => agent() as unknown as { personData(p: { personId: string; mode: 'count' | 'delete' }): Promise<PersonDataAnswer> }

/** One ended run and its chat state for `owner` in the BrandAgent's storage: nothing busy. */
async function agentRows(owner: string): Promise<void> {
  await runInDurableObject(agent(), async (_i, state) => {
    state.storage.sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms, ended_at_ms) VALUES (?, ?, ?, 'ended', ?, ?)", `r-${owner}`, `c-${owner}`, owner, T, T + 1)
    state.storage.sql.exec('INSERT INTO chat_state (chat_id, owner_id, last_at_ms) VALUES (?, ?, ?)', `c-${owner}`, owner, T)
  })
}
const agentCount = (owner: string) => runInDurableObject(agent(), async (_i, state) =>
  state.storage.sql.exec<{ n: number }>('SELECT (SELECT COUNT(*) FROM runs WHERE owner_id = ?) + (SELECT COUNT(*) FROM chat_state WHERE owner_id = ?) AS n', owner, owner).one().n)

/** G2's person deletion on the live database, logged at `atMs`, and the BrandAgent's personData as C1's runner calls it. */
async function deletePerson(memberId: string, atMs: number): Promise<void> {
  const deps = { db: e.DB, bucket: e.FILES, at: at(atMs), clock: () => atMs, registry: g2Registry }
  const plan = await planPersonDeletion(deps, { memberId })
  if (!('ok' in plan)) throw new Error(`plan refused: ${JSON.stringify(plan)}`)
  const done = await runPersonDeletion(deps, plan.ok)
  if (!('ok' in done)) throw new Error(`run refused: ${JSON.stringify(done)}`)
  expect(await rpc().personData({ personId: memberId, mode: 'delete' })).toHaveProperty('counts')
}

let ids: { admin: string; dana: string; leo: string }
let record: RestoreRecord
let backupMaxId: number
let laterLines: Record<string, unknown>[]
let leoBackupRow: unknown
const danaPhoto: string[] = []

beforeAll(async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const seeded = await seedBrand(e.DB, openStores(e), T)
  ids = { admin: seeded.members.admin, dana: seeded.members.dana, leo: seeded.members.leo }
  for (const id of [ids.dana, ids.leo]) {
    await addSetting(e.DB, id, 'mine', id, T)
    await agentRows(id)
  }
  danaPhoto.push((await addPhoto(e.DB, e.FILES, ids.dana)).key)
  // Leo goes before the backup (T + 10): the backup holds him pseudonymised.
  await deletePerson(ids.leo, T + 10)
  const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: T + 20 })
  backupMaxId = manifest.tables.find(t => t.name === 'audit_log')?.maxId as number
  leoBackupRow = await e.DB.prepare('SELECT * FROM members WHERE id = ?').bind(ids.leo).first()
  // After the backup: audit lines, then Dana's deletion (T + 40).
  for (let i = 0; i < 3; i++) await addLine(e.DB, ids.admin, ids.dana, { n: i }, T + 30 + i)
  laterLines = (await e.DB.prepare('SELECT * FROM audit_log WHERE id > ? ORDER BY id').bind(backupMaxId).all()).results
  await deletePerson(ids.dana, T + 40)
  // The BrandAgent recovered to T + 5, before both deletions: both people's rows are back in its storage.
  for (const id of [ids.dana, ids.leo]) await agentRows(id)
  record = await restore({
    bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(T + 50),
    durableObjects: [{ name: 'BrandAgent', recoveredAtMs: T + 5 }],
  })
})

it('imports, then the restored database still holds Dana as she was at the backup', async () => {
  expect(record).toMatchObject({ status: 'restored_unreconciled', reconciled: false, reconcile: null, watermarkMs: T + 5, durableObjects: [{ name: 'BrandAgent', recoveredAtMs: T + 5 }] })
  expect(await e.RESTORE_DB.prepare('SELECT pseudonymised_at_ms FROM members WHERE id = ?').bind(ids.dana).first()).toEqual({ pseudonymised_at_ms: null })
  expect((await e.RESTORE_DB.prepare('SELECT COUNT(*) AS n FROM settings WHERE owner = ?').bind(ids.dana).first<{ n: number }>())?.n).toBeGreaterThan(0)
  expect(record.r2.missingPhotoKeys).toEqual(danaPhoto)
  expect(await agentCount(ids.dana)).toBe(2)
})

it('a confirm before the reconcile refuses, and the record stays unreconciled', async () => {
  expect(await confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(T + 55, ids.admin) })).toMatchObject({ refused: 'not_reconciled: audit' })
  expect(await readRecord(e.FILES, record.restoreId)).toMatchObject({ status: 'restored_unreconciled', reconcile: null })
})

it('reconciles: the audit lines come back once with their ids, and Dana stays gone across D1, R2 and the BrandAgent', async () => {
  const deps = { bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 60), registry: replayRegistry, runners: { BrandAgent: brandAgentRunner(rpc()) } }
  const first = await reconcile(deps)
  if (!('ok' in first)) throw new Error(first.refused)
  expect(first.ok.status).toBe('restored_unreconciled')
  expect(first.ok.reconcile).toMatchObject({
    audit: { source: 'snapshot', afterId: backupMaxId, appended: laterLines.length, gap: null }, outbox: 'p8b_pending', confirm: null, refusal: null,
  })
  // Leo's run (T + 10) reaches only the BrandAgent (recovered to T + 5); Dana's (T + 40) every store it names.
  const runs = first.ok.reconcile?.replay?.runs ?? []
  expect(runs.map(r => r.stores)).toEqual([['BrandAgent'], replayRegistry.map(t => t.name)])
  expect(await e.RESTORE_DB.prepare('SELECT * FROM members WHERE id = ?').bind(ids.leo).first()).toEqual(leoBackupRow)

  const restored = (await e.RESTORE_DB.prepare('SELECT * FROM audit_log WHERE id > ? ORDER BY id').bind(backupMaxId).all()).results
  expect(restored).toEqual(laterLines)
  const dana = await e.RESTORE_DB.prepare('SELECT name, email_norm, subject, status, pseudonymised_at_ms FROM members WHERE id = ?').bind(ids.dana).first()
  expect(dana).toEqual({ name: 'Former member', email_norm: null, subject: null, status: 'removed', pseudonymised_at_ms: T + 60 })
  expect(await e.RESTORE_DB.prepare('SELECT COUNT(*) AS n FROM settings WHERE owner = ?').bind(ids.dana).first()).toEqual({ n: 0 })
  expect((await e.FILES.list({ prefix: `photos/${ids.dana}/` })).objects).toEqual([])
  expect(await agentCount(ids.dana)).toBe(0)
  expect(await agentCount(ids.leo)).toBe(0)

  // A re-run appends nothing twice and replays to the same end.
  const again = await reconcile(deps)
  if (!('ok' in again)) throw new Error(again.refused)
  expect(again.ok.reconcile?.audit).toMatchObject({ appended: 0, throughId: first.ok.reconcile?.audit?.throughId })
  expect((await e.RESTORE_DB.prepare('SELECT * FROM audit_log WHERE id > ? ORDER BY id').bind(backupMaxId).all()).results).toEqual(laterLines)
})

it('ends restored only on an Admin\'s confirm, with one audit line however often it runs', async () => {
  expect(await confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(T + 70, ids.dana) })).toMatchObject({ refused: 'not_admin' })
  expect((await readRecord(e.FILES, record.restoreId)).status).toBe('restored_unreconciled')
  const done = await confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(T + 80, ids.admin) })
  if (!('ok' in done)) throw new Error(done.refused)
  expect(done.ok).toMatchObject({ status: 'restored', reconciled: true, reconcile: { confirm: { actorId: ids.admin, atMs: T + 80 } } })
  const lines = (await e.RESTORE_DB.prepare("SELECT id, actor_id, args_json FROM audit_log WHERE action = 'restore.confirmed'").all()).results
  expect(lines).toEqual([{ id: done.ok.reconcile?.confirm?.auditId, actor_id: ids.admin, args_json: JSON.stringify({ restoreId: record.restoreId, backupId: record.backup.backupId }) }])
  expect(await confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(T + 90, ids.admin) })).toEqual(done)
  expect((await e.RESTORE_DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'restore.confirmed'").first())).toEqual({ n: 1 })
  // A restored record is never reconciled again.
  expect(await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(T + 95), registry: replayRegistry })).toMatchObject({ refused: 'not_reconcilable: restored' })
})
