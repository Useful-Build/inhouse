// Use the same generated history on live storage and on a restored backup. A deleted row returning, a boundary
// row disappearing, or a stopped person run deleting more than the live run did all break the comparison.
import { applyD1Migrations, runInDurableObject } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { fc } from '@fast-check/vitest'
import { expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { openStores } from '../../../server/db/stores.ts'
import type { BrandAgent } from '../../../server/do/brand-agent/index.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import { addActivity, addChat, addMemory, addNotice, addRead, withoutIndexes } from '../../coverage/chat-watch-connectors/test-support.ts'
import { planPersonDeletion, runPersonDeletion } from '../../delete/person.ts'
import { addPerson, snapshotAll } from '../../delete/test-support.ts'
import { planRetention, runRetention } from '../../retention/retention.ts'
import { DEFAULT_DAYS, periodsFor } from '../../retention/rules.ts'
import { tables } from '../../tables/index.ts'
import { backup } from '../backup.ts'
import { restore } from '../restore.ts'
import { brandAgentRunner, confirmRestore, reconcile } from './index.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const bucket = e.FILES
const B = 1_800_000_000_000
const BEFORE = B - 120_000
const AFTER = B + 120_000
const DAY = 86_400_000
const at = (nowMs: number, actorId = SYSTEM_MEMBER_ID) => ({ actorId, nowMs, requestId: `differential-${nowMs}` })
const liveAgent = () => e.BRAND_AGENT.getByName('replay-differential-live') as DurableObjectStub<BrandAgent>
const recoveredAgent = () => e.BRAND_AGENT.getByName('replay-differential-recovered') as DurableObjectStub<BrandAgent>

const comparable = async (db: D1Database) => {
  const { d1, r2 } = withoutIndexes(await snapshotAll(db, bucket))
  // The deletion's replay gets its own write time and request stamp. All other member data must match.
  d1.members = d1.members.map(row => row.pseudonymised_at_ms === null ? row : {
    ...row, pseudonymised_at_ms: true, removed_at_ms: true, req_id: null,
  })
  return { d1, r2: Object.fromEntries(Object.entries(r2).filter(([key]) => !/^(backups|restore|deletion-log)\//.test(key))) }
}

const agentState = (sql: SqlStorage) => ({
  runs: sql.exec('SELECT * FROM runs ORDER BY run_id').toArray(),
  chats: sql.exec('SELECT * FROM chat_state ORDER BY chat_id').toArray(),
})

it('backup, live retention and person deletion, restore and replay converge across D1, R2 and BrandAgent', async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const { members } = await seedBrand(e.DB, openStores(e), B - 2 * DAY)
  const { id: stopped } = await addPerson(e.DB, { role: 'member', status: 'active' }, members.admin, B - DAY)
  const { id: retry } = await addPerson(e.DB, { role: 'member', status: 'active' }, members.admin, B - DAY)

  const chatCut = AFTER - DEFAULT_DAYS.chats * DAY
  const stepCut = AFTER - DEFAULT_DAYS.steps * DAY
  const trashCut = AFTER - DEFAULT_DAYS.trash * DAY
  const offsets = [-1, 0, 1, ...fc.sample(fc.integer({ min: -60_000, max: 60_000 }), { seed: 346334, numRuns: 6 })]
  const history = [
    { id: 'c_before', owner: members.admin, lastAtMs: chatCut - DAY },
    { id: 'c_stopped', owner: stopped, lastAtMs: B - DAY },
    { id: 'c_retry', owner: retry, lastAtMs: B - DAY },
    ...offsets.flatMap((delta, i) => [
      { id: `c_age_${i}`, owner: members.admin, lastAtMs: chatCut + delta },
      { id: `c_trash_${i}`, owner: members.admin, lastAtMs: B - DAY, deletedAtMs: trashCut + delta },
    ]),
  ]
  const seedAgent = (sql: SqlStorage) => {
    for (const chat of history) {
      sql.exec('INSERT INTO chat_state (chat_id, owner_id, last_at_ms) VALUES (?, ?, ?)', chat.id, chat.owner, chat.lastAtMs)
      const end = chat.id === 'c_age_1' ? stepCut - 1 : chat.lastAtMs
      sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms, ended_at_ms) VALUES (?, ?, ?, 'ended', ?, ?)",
        `r_${chat.id}`, chat.id, chat.owner, end - 1, end)
    }
  }

  for (const chat of history) await addChat(e.DB, bucket, { ...chat, marker: chat.id })
  for (const [i, delta] of offsets.entries()) {
    await addActivity(e.DB, { id: `a_${i}`, actor: members.admin, subject: null, atMs: stepCut + delta })
    await addMemory(e.DB, { id: `mem_${i}`, owner: null, createdBy: members.admin, marker: `memory${i}`, status: 'forgotten',
      updatedAtMs: AFTER - DEFAULT_DAYS.forgottenMemory * DAY + delta })
  }
  for (const member of [stopped, retry, members.dana]) {
    const id = `n_${member}`
    await addNotice(e.DB, { id, audience: 'member', member, atMs: B - DAY })
    await addRead(e.DB, members.admin, id, B - DAY)
  }
  const retain = async (names: string[], nowMs: number, sql: SqlStorage) => {
    const registry = tables.filter(t => names.includes(t.name))
    const deps = { db: e.DB, bucket, sql, registry, at: at(nowMs), clock: () => nowMs }
    return runRetention(deps, await planRetention(deps, { periods: periodsFor(registry) }))
  }
  await runInDurableObject(liveAgent(), async (_instance, state) => {
    seedAgent(state.storage.sql)
    expect((await retain(['chats'], BEFORE, state.storage.sql)).removed.chats).toBe(1)
  })

  const manifest = await backup({ db: e.DB, bucket, nowMs: B })
  const backedUp = await comparable(e.DB)
  await runInDurableObject(liveAgent(), async (instance, state) => {
    const sql = state.storage.sql
    const retained = await retain(['chats', 'tool_calls', 'BrandAgent', 'activity_lines', 'memories'], AFTER, sql)
    expect(retained.removed).toMatchObject({ chats: 2 * offsets.filter(delta => delta < 0).length, activity_lines: offsets.filter(delta => delta < 0).length })
    for (const [i, memberId] of [stopped, retry, retry].entries()) {
      const nowMs = AFTER + i + 1
      const brandAgent = { personData: (p: { personId: string; mode: 'count' | 'delete' }) =>
        p.mode === 'delete' && i < 2 ? Promise.resolve({ busy: true as const }) : instance.personData(p) }
      const deps = { db: e.DB, bucket, brandAgent, at: at(nowMs), clock: () => nowMs }
      const plan = await planPersonDeletion(deps, { memberId })
      if (!('ok' in plan)) throw new Error(plan.refused)
      const result = await runPersonDeletion(deps, plan.ok)
      if (i < 2) expect(result).toEqual({ refused: 'busy' })
      else expect(result).toHaveProperty('ok')
    }
  })
  const expected = await comparable(e.DB)
  expect(expected.d1.chats.map(row => row.id)).toEqual(expect.arrayContaining(['c_age_1', 'c_trash_1', 'c_stopped']))
  for (const id of ['c_before', 'c_age_0', 'c_trash_0', 'c_retry']) expect(expected.d1.chats.map(row => row.id)).not.toContain(id)
  const expectedAgent = await runInDurableObject(liveAgent(), (_instance, state) => agentState(state.storage.sql))

  // Recreate backup-era objects still present in R2. Replay must clean up their stale bytes as well as D1 rows.
  for (const [key, body] of Object.entries(backedUp.r2)) {
    if (!(key in expected.r2)) await bucket.put(key, Uint8Array.from(atob(body.base64), c => c.charCodeAt(0)))
  }
  const record = await restore({ bucket, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(AFTER + 10),
    durableObjects: [{ name: 'BrandAgent', recoveredAtMs: BEFORE - 1 }] })
  expect(record.status).toBe('restored_unreconciled')
  await runInDurableObject(recoveredAgent(), async (instance, state) => {
    seedAgent(state.storage.sql)
    const deps = { bucket, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(AFTER + 20), retentionSql: state.storage.sql,
      runners: { BrandAgent: brandAgentRunner(instance) } }
    for (let pass = 0; pass < 2; pass++) {
      const reconciled = await reconcile(deps)
      if (!('ok' in reconciled)) throw new Error(reconciled.refused)
      expect(await comparable(e.RESTORE_DB)).toEqual(expected)
      expect(agentState(state.storage.sql)).toEqual(expectedAgent)
    }
    const confirmed = await confirmRestore({ ...deps, at: at(AFTER + 30, members.inhouse), approvedBy: members.admin })
    expect(confirmed).toMatchObject({ ok: { status: 'restored' } })
  })
})
