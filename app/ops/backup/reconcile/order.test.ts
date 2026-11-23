// The reconcile's step order and its edges (P8a R, review round 2). Ways it can fail, written down first:
//  1. (L-a) the replay runs before step 3b: an Admin removed after the backup and then deleted is still the restored
//     database's only active Admin when the replay pseudonymises them, so P2's last-Admin guard stops the restore;
//  2. step 3b applies a re-invite or a restore after a removal, giving a removed member access back;
//  3. a deletion logged inside the 60 s skew margin before the backup's point isn't replayed;
//  4. with no active Admin left in the restored database, nobody can confirm (L5), or a removed Admin still can.
import { applyD1Migrations, runInDurableObject } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { memberStore } from '../../../server/db/members.ts'
import { openStores } from '../../../server/db/stores.ts'
import type { PersonDataAnswer } from '../../../server/do/brand-agent/ports.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import { planPersonDeletion, runPersonDeletion } from '../../delete/person.ts'
import { addPerson } from '../../delete/test-support.ts'
import { tables } from '../../tables/index.ts'
import { backup } from '../backup.ts'
import type { RestoreRecord } from '../manifest.ts'
import { restore } from '../restore.ts'
import { brandAgentRunner, confirmRestore, reconcile } from './index.ts'
import { readRecord } from './record.ts'
import { SKEW_MARGIN_MS } from './replay.ts'
import { ftsStub } from './test-support.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
const B = T + 3_600_000
const at = (nowMs: number, actorId = SYSTEM_MEMBER_ID) => ({ actorId, requestId: `req-order-${nowMs}`, nowMs })
const registry = tables.filter(t => ['members', 'settings', 'support_grants', 'audit_log', 'photos/', 'backups/', 'restore/', 'deletion-log/'].includes(t.name))
const rev = async (id: string) => (await e.DB.prepare('SELECT rev FROM members WHERE id = ?').bind(id).first<{ rev: number }>())?.rev as number
const row = (id: string) => e.RESTORE_DB.prepare('SELECT status, role, pseudonymised_at_ms FROM members WHERE id = ?').bind(id).first()

async function deletePerson(memberId: string, atMs: number): Promise<string> {
  const deps = { db: e.DB, bucket: e.FILES, at: at(atMs), clock: () => atMs, registry }
  const plan = await planPersonDeletion(deps, { memberId })
  if (!('ok' in plan)) throw new Error(`plan refused: ${JSON.stringify(plan)}`)
  const done = await runPersonDeletion(deps, plan.ok)
  if (!('ok' in done)) throw new Error(`run refused: ${JSON.stringify(done)}`)
  return done.ok.runId
}

let ids: { admin: string; dana: string; leo: string; inhouse: string; yan: string }
let record: RestoreRecord
let marginRun: string

beforeAll(async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const { members } = await seedBrand(e.DB, openStores(e), T)
  const store = memberStore({ db: e.DB })
  // Leo is removed before the backup; his restore and a re-invite come after it.
  expect(await store.remove({ id: members.leo, ifRev: await rev(members.leo) }, at(T + 1, members.admin))).toHaveProperty('ok')
  // Dana is deleted 30 s before the backup's point: inside the skew margin.
  marginRun = await deletePerson(members.dana, B - 30_000)
  const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: B })
  // After the backup: Yan joins as an Admin (no row in the restored database), removes the seed's only Admin, who is
  // then deleted.
  const yan = (await addPerson(e.DB, { role: 'admin', status: 'active' }, members.admin, B + 1)).id
  ids = { admin: members.admin, dana: members.dana, leo: members.leo, inhouse: members.inhouse, yan }
  expect(await store.remove({ id: members.admin, ifRev: await rev(members.admin) }, at(B + 2, yan))).toHaveProperty('ok')
  for (const action of ['member.restored', 'member.reinvited'] as const) {
    await e.DB.prepare('INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(B + 3, yan, action, 'member', members.leo, JSON.stringify(action === 'member.restored' ? { memberId: members.leo } : { memberId: members.leo, role: 'member' }), `req-${action}`).run()
  }
  await deletePerson(members.admin, B + 40)
  record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(B + 50) })
})

it('applies the removal before the replay, so deleting the restored database\'s last Admin finishes (L-a)', async () => {
  expect(await row(ids.admin)).toEqual({ status: 'active', role: 'admin', pseudonymised_at_ms: null })
  const out = await reconcile({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts, at: at(B + 60), registry })
  if (!('ok' in out)) throw new Error(out.refused)
  expect(out.ok.reconcile?.members).toEqual({ removed: [ids.admin], roles: [] })
  expect(await row(ids.admin)).toEqual({ status: 'removed', role: 'admin', pseudonymised_at_ms: B + 60 })
  expect(out.ok.reconcile?.audit?.placeholders).toEqual([ids.yan])
})

it('leaves a re-invite or restore after the backup unapplied: the removed member stays removed', async () => {
  expect(await row(ids.leo)).toEqual({ status: 'removed', role: 'member', pseudonymised_at_ms: null })
})

it('replays a deletion logged inside the skew margin before the backup\'s point', async () => {
  expect(SKEW_MARGIN_MS).toBe(60_000)
  const { record: r } = await readRecord(e.FILES, record.restoreId)
  expect(r.reconcile?.replay?.runs.map(x => x.runId)).toContain(marginRun)
  expect(r.reconcile?.replay?.watermarkMs).toBe(B - SKEW_MARGIN_MS)
})

it('with no active Admin left, an Inhouse operator approves; the removed Admin can\'t (L5)', async () => {
  const confirm = (approvedBy: string) => confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(B + 70, ids.inhouse), approvedBy })
  expect(await confirm(ids.admin)).toMatchObject({ refused: 'not_admin' })
  expect(await confirm(ids.yan)).toMatchObject({ refused: 'not_admin' })
  expect(await confirm(ids.inhouse)).toMatchObject({ ok: { status: 'restored', reconcile: { confirm: { actorId: ids.inhouse, approvedBy: ids.inhouse } } } })
})

it('applies SKEW_MARGIN_MS to BrandAgent recoveredAtMs and watermarkMs when recoveredAtMs < d1Point', async () => {
  const doRegistry = tables.filter(t => ['members', 'settings', 'support_grants', 'audit_log', 'photos/', 'backups/', 'restore/', 'deletion-log/', 'BrandAgent'].includes(t.name))
  const liveAgent = e.BRAND_AGENT.getByName('skew-do-live')
  const recAgent = e.BRAND_AGENT.getByName('skew-do-rec')
  // Reset RESTORE_DB for this independent backup -> delete -> restore flow.
  const tbls = (await e.RESTORE_DB.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('trigger', 'view', 'table') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'").all<{ name: string; type: string }>()).results
  const stmts: string[] = []
  for (const r of tbls.filter(x => x.type === 'trigger' || x.type === 'view')) stmts.push(`DROP ${r.type.toUpperCase()} IF EXISTS "${r.name}";`)
  for (const r of tbls.filter(x => x.type === 'table' && /_fts$/.test(x.name))) stmts.push(`DROP TABLE IF EXISTS "${r.name}";`)
  const regular = tbls.filter(x => x.type === 'table' && !/_fts/.test(x.name)).map(x => x.name)
  const parents = new Map<string, Set<string>>()
  for (const name of regular) {
    const fks = (await e.RESTORE_DB.prepare(`PRAGMA foreign_key_list("${name}")`).all<{ table: string }>()).results
    parents.set(name, new Set(fks.map(f => f.table).filter(p => p !== name)))
  }
  const dropped = new Set<string>()
  while (dropped.size < regular.length) {
    const leaf = regular.find(t => !dropped.has(t) && !regular.some(c => !dropped.has(c) && (parents.get(c)?.has(t) ?? false)))
    if (!leaf) throw new Error('cyclic fk')
    stmts.push(`DROP TABLE IF EXISTS "${leaf}";`)
    dropped.add(leaf)
  }
  stmts.push('DELETE FROM d1_migrations;')
  await e.RESTORE_DB.exec(stmts.join('\n'))
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)

  const doRecovery = B + 120_000
  const loggedAt = doRecovery - 30_000 // Inside the 60 s skew margin before DO recovery, well before B + 10 min backup.
  const skewPerson = (await addPerson(e.DB, { role: 'member', status: 'active' }, ids.inhouse, T)).id
  const laterBackup = await backup({ db: e.DB, bucket: e.FILES, nowMs: B + 600_000 })
  const runId = await (async () => {
    const plan = await planPersonDeletion({ db: e.DB, bucket: e.FILES, brandAgent: liveAgent as unknown as { personData(p: { personId: string; mode: 'count' | 'delete' }): Promise<PersonDataAnswer> }, at: at(loggedAt), clock: () => loggedAt, registry: doRegistry }, { memberId: skewPerson })
    if (!('ok' in plan)) throw new Error(plan.refused)
    const done = await runPersonDeletion({ db: e.DB, bucket: e.FILES, brandAgent: liveAgent as unknown as { personData(p: { personId: string; mode: 'count' | 'delete' }): Promise<PersonDataAnswer> }, at: at(loggedAt), clock: () => loggedAt, registry: doRegistry }, plan.ok)
    if (!('ok' in done)) throw new Error(done.refused)
    return done.ok.runId
  })()
  await runInDurableObject(recAgent, async (_i, state) => {
    state.storage.sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms, ended_at_ms) VALUES ('r_skew', 'c_skew', ?, 'ended', ?, ?)", skewPerson, T, T + 1)
    state.storage.sql.exec('INSERT INTO chat_state (chat_id, owner_id, last_at_ms) VALUES (?, ?, ?)', 'c_skew', skewPerson, T)
  })
  const rec = await restore({
    bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: laterBackup.backupId, at: at(B + 605_000),
    durableObjects: [{ name: 'BrandAgent', recoveredAtMs: doRecovery }],
  })
  const out = await reconcile({
    bucket: e.FILES, target: e.RESTORE_DB, restoreId: rec.restoreId, rebuildFts: ftsStub().rebuildFts,
    at: at(B + 610_000), registry: doRegistry,
    runners: { BrandAgent: brandAgentRunner(recAgent as unknown as { personData(p: { personId: string; mode: 'count' | 'delete' }): Promise<PersonDataAnswer> }) },
  })
  if (!('ok' in out)) throw new Error(out.refused)
  expect(out.ok.reconcile?.replay?.watermarkMs).toBe(doRecovery - SKEW_MARGIN_MS)
  expect(out.ok.reconcile?.replay?.runs.map(r => r.runId)).toContain(runId)
  expect(await runInDurableObject(recAgent, async (_i, state) => state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE owner_id = ?', skewPerson).one().n)).toBe(0)
})
