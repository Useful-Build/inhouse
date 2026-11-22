// P8a R's core proof (acceptance 1 and 2): a restore finishes at `restored` only after the audit re-append, the
// deletion-log replay and an admin's audited confirm, and a person deleted after the backup stays gone across D1, R2
// and the Durable Objects. Ways it can fail, written down first:
//  1. a person deleted after the backup comes back in D1 (member row, owned rows), R2 (their objects) or the
//     BrandAgent's storage once the restore finishes;
//  2. an entry logged before the backup's point is applied to the restored D1 (C1 review M2), or skipped for a Durable
//     Object rewound to before it;
//  3. the audit lines newer than the backup don't come back, come back twice on a re-run, or come back with new ids;
//  4. the restore reads `restored` before the confirm, or the confirm writes no audit line or two;
//  5. a line by a member added after the backup (no member row in the restored database) blocks the restore or is
//     dropped, or its placeholder row can sign in, keeps anything of the person's, or is written (or audited) twice;
//  6. (review M4) a member removed or demoted after the backup has their old access back, and can approve the confirm;
//  7. (review M3) the confirm takes a self-asserted actor, or records no approving Admin;
//  8. (review L1) a confirm whose record write failed leaves a line that makes every later reconcile refuse;
//  9. (review M2) the switch goes ahead after the live database logged a deletion or an audit line the restore missed.
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
import { memberStore } from '../../../server/db/members.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import { writeLogEntry } from '../../delete/log.ts'
import { planPersonDeletion, runPersonDeletion } from '../../delete/person.ts'
import { addLine, addPerson, addPhoto, addSetting } from '../../delete/test-support.ts'
import { tables } from '../../tables/index.ts'
import { backup } from '../backup.ts'
import { restore } from '../restore.ts'
import type { RestoreRecord } from '../manifest.ts'
import { brandAgentRunner, checkBeforeSwitch, confirmRestore, reconcile } from './index.ts'
import { restoreKey } from '../../../server/db/r2-keys.ts'
import { FtsRecordSchema } from '../fts/rebuild.ts'
import { readRecord } from './record.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
/** The backup's point: well past Leo's deletion (T + 10) and the replay's 60 s skew margin. */
const B = T + 3_600_000
const at = (nowMs: number, actorId = SYSTEM_MEMBER_ID) => ({ actorId, requestId: `req-finish-${nowMs}`, nowMs })
/** P2's stores and the BrandAgent: what G2's person deletion runs on today (C1's runners for the rest aren't built). */
const NAMES = ['members', 'settings', 'support_grants', 'audit_log', 'photos/', 'backups/', 'restore/', 'deletion-log/']
const g2Registry = tables.filter(t => NAMES.includes(t.name))
const replayRegistry = tables.filter(t => [...NAMES, 'BrandAgent'].includes(t.name))
/** The target's audit lines past the backup, this restore's own placeholder lines aside. */
const reappended = async () => (await e.RESTORE_DB.prepare("SELECT * FROM audit_log WHERE id > ? AND action <> 'restore.member_placeholder' ORDER BY id").bind(backupMaxId).all()).results
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

let ids: { admin: string; dana: string; leo: string; inhouse: string; ana: string; kai: string }
let record: RestoreRecord
let backupMaxId: number
let laterLines: Record<string, unknown>[]
let nia: string
let leoBackupRow: unknown
const danaPhoto: string[] = []
const late = { key: '' }

const rev = async (id: string) => (await e.DB.prepare('SELECT rev FROM members WHERE id = ?').bind(id).first<{ rev: number }>())?.rev as number

beforeAll(async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const seeded = await seedBrand(e.DB, openStores(e), T)
  // Ana and Kai are Admins at the backup; after it Ana is removed and Kai demoted.
  const ana = (await addPerson(e.DB, { role: 'admin', status: 'active' }, seeded.members.admin, T)).id
  const kai = (await addPerson(e.DB, { role: 'admin', status: 'active' }, seeded.members.admin, T)).id
  ids = { admin: seeded.members.admin, dana: seeded.members.dana, leo: seeded.members.leo, inhouse: seeded.members.inhouse, ana, kai }
  for (const id of [ids.dana, ids.leo]) {
    await addSetting(e.DB, id, 'mine', id, T)
    await agentRows(id)
  }
  danaPhoto.push((await addPhoto(e.DB, e.FILES, ids.dana)).key)
  // Leo goes before the backup (T + 10): the backup holds him pseudonymised.
  await deletePerson(ids.leo, T + 10)
  const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: B })
  backupMaxId = manifest.tables.find(t => t.name === 'audit_log')?.maxId as number
  leoBackupRow = await e.DB.prepare('SELECT * FROM members WHERE id = ?').bind(ids.leo).first()
  // After the backup: audit lines, a removal and a demotion (with their own lines), Nia, then Dana's deletion.
  for (let i = 0; i < 3; i++) await addLine(e.DB, ids.admin, ids.dana, { n: i }, B + 30 + i)
  const members = memberStore({ db: e.DB })
  expect(await members.remove({ id: ana, ifRev: await rev(ana) }, at(B + 31, ids.admin))).toHaveProperty('ok')
  expect(await members.changeRole({ id: kai, role: 'member', ifRev: await rev(kai) }, at(B + 32, ids.admin))).toHaveProperty('ok')
  // Nia joins after the backup and acts: her line's actor has no member row in the restored database.
  nia = (await addPerson(e.DB, { role: 'member', status: 'active' }, ids.admin, B + 33)).id
  await addLine(e.DB, nia, null, { n: 'nia' }, B + 34)
  laterLines = (await e.DB.prepare('SELECT * FROM audit_log WHERE id > ? ORDER BY id').bind(backupMaxId).all()).results
  await deletePerson(ids.dana, B + 40)
  // An object under Dana's prefix that only the replay's objects step removes (review L3).
  late.key = `photos/${ids.dana}/late`
  await e.FILES.put(late.key, 'late')
  // The BrandAgent recovered to T + 5, before both deletions: both people's rows are back in its storage.
  for (const id of [ids.dana, ids.leo]) await agentRows(id)
  record = await restore({
    bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(B + 50),
    durableObjects: [{ name: 'BrandAgent', recoveredAtMs: T + 5 }],
  })
})

// The real FTS rebuild (C1's rebuildAfterRestore, the default): no stand-in in the core proof.
const deps = () => ({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(B + 60), registry: replayRegistry, runners: { BrandAgent: brandAgentRunner(rpc()) } })
const confirm = (nowMs: number, actorId: string, approvedBy: string, bucket: R2Bucket = e.FILES) =>
  confirmRestore({ bucket, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(nowMs, actorId), approvedBy })

it('imports, then the restored database still holds Dana as she was at the backup', async () => {
  expect(record).toMatchObject({ status: 'restored_unreconciled', reconciled: false, reconcile: null, watermarkMs: T + 5, durableObjects: [{ name: 'BrandAgent', recoveredAtMs: T + 5 }] })
  expect(await e.RESTORE_DB.prepare('SELECT pseudonymised_at_ms FROM members WHERE id = ?').bind(ids.dana).first()).toEqual({ pseudonymised_at_ms: null })
  expect((await e.RESTORE_DB.prepare('SELECT COUNT(*) AS n FROM settings WHERE owner = ?').bind(ids.dana).first<{ n: number }>())?.n).toBeGreaterThan(0)
  expect(record.r2.missingPhotoKeys).toEqual(danaPhoto)
  expect(await agentCount(ids.dana)).toBe(2)
  expect(await e.RESTORE_DB.prepare('SELECT status, role FROM members WHERE id = ?').bind(ids.ana).first()).toEqual({ status: 'active', role: 'admin' })
})

it('a confirm before the reconcile refuses, and the record stays unreconciled', async () => {
  expect(await confirm(B + 55, ids.inhouse, ids.admin)).toMatchObject({ refused: 'not_reconciled: audit' })
  expect((await readRecord(e.FILES, record.restoreId)).record).toMatchObject({ status: 'restored_unreconciled', reconcile: null })
})

it('reconciles: the audit lines come back once with their ids, and Dana stays gone across D1, R2 and the BrandAgent', async () => {
  const first = await reconcile(deps())
  if (!('ok' in first)) throw new Error(first.refused)
  expect(first.ok.status).toBe('restored_unreconciled')
  // The real rebuild ran and wrote its record; it reads the restore record and never writes it, so the write held (L-c).
  const fts = FtsRecordSchema.parse(JSON.parse(await (await e.FILES.get(restoreKey(record.restoreId, 'fts.json')))!.text()))
  expect(fts).toMatchObject({ restoreId: record.restoreId, status: 'rebuilt' })
  expect(fts.tables.map(t => t.name).sort()).toEqual(record.d1.derived.map(d => d.name).sort())
  expect(first.ok.reconcile).toMatchObject({
    fts: 'rebuilt', audit: { source: 'snapshot', afterId: backupMaxId, appended: laterLines.length, gap: null, placeholders: [nia] }, outbox: 'p8b_pending', confirm: null, refusal: null,
  })
  // Leo's run (T + 10) reaches only the BrandAgent (recovered to T + 5); Dana's every store it names.
  const runs = first.ok.reconcile?.replay?.runs ?? []
  expect(runs.map(r => r.stores)).toEqual([['BrandAgent'], replayRegistry.map(t => t.name)])
  expect(await e.RESTORE_DB.prepare('SELECT * FROM members WHERE id = ?').bind(ids.leo).first()).toEqual(leoBackupRow)

  expect(await reappended()).toEqual(laterLines)
  // Nia's placeholder: her id, pseudonymised and removed (no subject, so no sign-in finds it), with one line after hers.
  expect(await e.RESTORE_DB.prepare('SELECT kind, role, status, name, title, email_norm, subject, photo_key, pseudonymised_at_ms FROM members WHERE id = ?').bind(nia).first())
    .toEqual({ kind: 'person', role: 'member', status: 'removed', name: 'Former member', title: null, email_norm: null, subject: null, photo_key: null, pseudonymised_at_ms: B + 60 })
  const placeholderLines = async () => (await e.RESTORE_DB.prepare("SELECT id, actor_id, target_id, args_json FROM audit_log WHERE action = 'restore.member_placeholder'").all<{ id: number }>()).results
  const [line] = await placeholderLines()
  expect(line).toMatchObject({ actor_id: SYSTEM_MEMBER_ID, target_id: nia, args_json: JSON.stringify({ memberId: nia, restoreId: record.restoreId }) })
  expect(line.id).toBeGreaterThan(laterLines[laterLines.length - 1].id as number)
  // Ana's removal and Kai's demotion after the backup hold in the restored rows (M4).
  expect(first.ok.reconcile?.members).toEqual({ removed: [ids.ana], roles: [{ memberId: ids.kai, role: 'member' }] })
  expect(await e.RESTORE_DB.prepare('SELECT status, removed_at_ms FROM members WHERE id = ?').bind(ids.ana).first()).toEqual({ status: 'removed', removed_at_ms: B + 31 })
  expect(await e.RESTORE_DB.prepare('SELECT role FROM members WHERE id = ?').bind(ids.kai).first()).toEqual({ role: 'member' })
  const dana = await e.RESTORE_DB.prepare('SELECT name, email_norm, subject, status, pseudonymised_at_ms FROM members WHERE id = ?').bind(ids.dana).first()
  expect(dana).toEqual({ name: 'Former member', email_norm: null, subject: null, status: 'removed', pseudonymised_at_ms: B + 60 })
  expect(await e.RESTORE_DB.prepare('SELECT COUNT(*) AS n FROM settings WHERE owner = ?').bind(ids.dana).first()).toEqual({ n: 0 })
  expect((await e.FILES.list({ prefix: `photos/${ids.dana}/` })).objects).toEqual([])
  expect(await agentCount(ids.dana)).toBe(0)
  expect(await agentCount(ids.leo)).toBe(0)

  // A re-run appends nothing twice and replays to the same end.
  const again = await reconcile(deps())
  if (!('ok' in again)) throw new Error(again.refused)
  expect(again.ok.reconcile?.audit).toMatchObject({ appended: 0, throughId: first.ok.reconcile?.audit?.throughId, placeholders: [nia] })
  expect(again.ok.reconcile?.members).toEqual(first.ok.reconcile?.members)
  expect(await reappended()).toEqual(laterLines)
  expect(await placeholderLines()).toHaveLength(1)
  expect(await e.RESTORE_DB.prepare('SELECT COUNT(*) AS n FROM members WHERE id = ?').bind(nia).first()).toEqual({ n: 1 })
})

it('the confirm takes an Inhouse operator as actor and an active Admin as approver, never a removed or demoted one', async () => {
  // The actor must be an Inhouse operator, not an Admin asserting themselves (M3).
  expect(await confirm(B + 70, ids.admin, ids.admin)).toMatchObject({ refused: 'not_inhouse' })
  for (const approver of [ids.dana, ids.ana, ids.kai, nia, ids.inhouse]) expect(await confirm(B + 71, ids.inhouse, approver), approver).toMatchObject({ refused: 'not_admin' })
  expect((await readRecord(e.FILES, record.restoreId)).record.status).toBe('restored_unreconciled')
})

it('a confirm whose record write failed leaves its line, and a re-reconcile and confirm finish with that one line (L1)', async () => {
  // A bucket whose record put fails: the line is written, the record isn't.
  const failingPut = { get: e.FILES.get.bind(e.FILES), list: e.FILES.list.bind(e.FILES), put: () => Promise.reject(new Error('R2 down (test)')) } as unknown as R2Bucket
  await expect(confirm(B + 72, ids.inhouse, ids.admin, failingPut)).rejects.toThrow('R2 down')
  const lines = async () => (await e.RESTORE_DB.prepare("SELECT id, actor_id, args_json FROM audit_log WHERE action = 'restore.confirmed'").all<{ id: number }>()).results
  expect(await lines()).toHaveLength(1)
  const again = await reconcile(deps())
  expect(again).toHaveProperty('ok')
  const done = await confirm(B + 80, ids.inhouse, ids.admin)
  if (!('ok' in done)) throw new Error(done.refused)
  expect(done.ok).toMatchObject({ status: 'restored', reconciled: true, reconcile: { confirm: { actorId: ids.inhouse, approvedBy: ids.admin } } })
  expect(done.ok.d1.derived.every(d => d.state === 'rebuilt')).toBe(true)
  const [line] = await lines()
  expect(await lines()).toEqual([{ id: done.ok.reconcile?.confirm?.auditId, actor_id: ids.inhouse, args_json: JSON.stringify({ restoreId: record.restoreId, backupId: record.backup.backupId, approvedBy: ids.admin }) }])
  expect(line.id).toBe(done.ok.reconcile?.confirm?.auditId)
  expect(await confirm(B + 90, ids.inhouse, ids.admin)).toEqual(done)
  // A restored record is never reconciled again.
  expect(await reconcile(deps())).toMatchObject({ refused: 'not_reconcilable: restored' })
})

it('the check before the switch refuses a live audit line or deletion the restore missed (M2)', async () => {
  expect(await checkBeforeSwitch({ bucket: e.FILES, restoreId: record.restoreId, live: e.DB })).toEqual({ ok: true })
  await addLine(e.DB, ids.admin, null, { n: 'after' }, B + 100)
  expect(await checkBeforeSwitch({ bucket: e.FILES, restoreId: record.restoreId, live: e.DB })).toMatchObject({ refused: expect.stringMatching(/^audit_after_snapshot: /) })
  await writeLogEntry(e.FILES, { format: 1, runId: '00000000000000bb', step: 0, phase: 'start', kind: 'retention', atMs: B + 101, actorId: SYSTEM_MEMBER_ID, cutoffs: [] })
  expect(await checkBeforeSwitch({ bucket: e.FILES, restoreId: record.restoreId, live: e.DB })).toMatchObject({ refused: expect.stringMatching(/^deletion_after_replay: /) })
})
