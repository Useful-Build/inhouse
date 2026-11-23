// P8a R person-replay order (review finding): BrandAgent runs before every other custom store (chats, notices),
// matching live deletion, so a busy BrandAgent stops before any chat or D1 row is removed and a flush retry + re-run finishes.
import { applyD1Migrations, runInDurableObject } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { openStores } from '../../../server/db/stores.ts'
import type { BrandAgent } from '../../../server/do/brand-agent/index.ts'
import { fixTurnRows, storedProjection, writeProjection } from '../../../server/do/brand-agent/projection.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import { addChat, addNotice, addRead, agentDouble } from '../../coverage/chat-watch-connectors/test-support.ts'
import { personRunners } from '../../coverage/chat-watch-connectors/replay.ts'
import { planPersonDeletion, runPersonDeletion } from '../../delete/person.ts'
import { listAll } from '../../delete/r2.ts'
import { tables } from '../../tables/index.ts'
import { backup } from '../backup.ts'
import { restore } from '../restore.ts'
import { brandAgentRunner, confirmRestore, reconcile } from './index.ts'
import { ftsStub } from './test-support.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
const B = T + 3_600_000
const at = (nowMs: number, actorId = SYSTEM_MEMBER_ID) => ({ actorId, requestId: `req-replay-order-${nowMs}`, nowMs })

async function resetDb(db: D1Database): Promise<void> {
  const rows = (await db.prepare(
    "SELECT name, type FROM sqlite_master WHERE type IN ('trigger', 'view', 'table') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string; type: string }>()).results
  const triggersAndViews = rows.filter(r => r.type === 'trigger' || r.type === 'view')
  const fts = rows.filter(r => r.type === 'table' && /_fts$/.test(r.name))
  const regular = rows.filter(r => r.type === 'table' && !/_fts/.test(r.name)).map(r => r.name)
  // Drop child tables before parents so foreign keys stay satisfied without disabling them inside a transaction.
  const parents = new Map<string, Set<string>>()
  for (const name of regular) {
    const fks = (await db.prepare(`PRAGMA foreign_key_list("${name}")`).all<{ table: string }>()).results
    parents.set(name, new Set(fks.map(f => f.table).filter(p => p !== name)))
  }
  const dropOrder: string[] = []
  const dropped = new Set<string>()
  const referencedBy = (parent: string) => regular.some(c => !dropped.has(c) && (parents.get(c)?.has(parent) ?? false))
  while (dropOrder.length < regular.length) {
    const leaf = regular.find(t => !dropped.has(t) && !referencedBy(t))
    if (!leaf) throw new Error('resetDb: cyclic foreign keys')
    dropOrder.push(leaf)
    dropped.add(leaf)
  }
  const stmts: string[] = []
  for (const r of triggersAndViews) stmts.push(`DROP ${r.type.toUpperCase()} IF EXISTS "${r.name}";`)
  // Virtual tables drop their own shadow tables; drop them before regular tables.
  for (const r of fts) stmts.push(`DROP TABLE IF EXISTS "${r.name}";`)
  for (const name of dropOrder) stmts.push(`DROP TABLE IF EXISTS "${name}";`)
  if (await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").first() !== null) {
    stmts.push('DELETE FROM d1_migrations;')
  }
  if (stmts.length > 0) await db.exec(stmts.join('\n'))
  await applyD1Migrations(db, e.TEST_MIGRATIONS)
}

async function resetAll(): Promise<void> {
  await resetDb(e.DB)
  await resetDb(e.RESTORE_DB)
  const keys = (await listAll(e.FILES, '')).map(o => o.key)
  for (let i = 0; i < keys.length; i += 1000) await e.FILES.delete(keys.slice(i, i + 1000))
}

beforeAll(async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
})

it('runs BrandAgent before every other custom store (chats, notices) even though chats is earlier in the registry', async () => {
  await resetAll()
  const { members } = await seedBrand(e.DB, openStores(e), T)
  await addChat(e.DB, e.FILES, { id: 'c_order', owner: members.dana, lastAtMs: B - 1000, marker: 'order' })
  await addNotice(e.DB, { id: 'n_order', audience: 'member', member: members.dana, atMs: B - 1000 })
  await addRead(e.DB, members.admin, 'n_order', B - 1000)

  const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: B })
  const agent = agentDouble({ [members.dana]: { chat_state: 1 } })
  const plan = await planPersonDeletion({ db: e.DB, bucket: e.FILES, brandAgent: agent, at: at(B + 10), clock: () => B + 10 }, { memberId: members.dana })
  if (!('ok' in plan)) throw new Error(plan.refused)
  expect(await runPersonDeletion({ db: e.DB, bucket: e.FILES, brandAgent: agent, at: at(B + 10), clock: () => B + 10 }, plan.ok)).toHaveProperty('ok')

  const record = await restore({
    bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(B + 20),
    durableObjects: [{ name: 'BrandAgent', recoveredAtMs: B - 1 }],
  })
  expect(record.status).toBe('restored_unreconciled')

  const order: string[] = []
  const real = personRunners({ db: e.RESTORE_DB, bucket: e.FILES })
  const recovered = e.BRAND_AGENT.getByName('replay-order-seq') as DurableObjectStub<BrandAgent>
  await runInDurableObject(recovered, async instance => {
    const ba = brandAgentRunner(instance)
    const wrap = (name: string, inner: typeof ba) => ({
      async deletePerson(memberId: string) {
        order.push(name)
        return inner.deletePerson(memberId)
      },
    })
    // Sanity check: chats still comes before BrandAgent in the registry itself.
    expect(tables.findIndex(t => t.name === 'chats')).toBeLessThan(tables.findIndex(t => t.name === 'BrandAgent'))
    const out = await reconcile({
      bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts,
      at: at(B + 30),
      runners: { BrandAgent: wrap('BrandAgent', ba), chats: wrap('chats', real.chats), notices: wrap('notices', real.notices) },
    })
    if (!('ok' in out)) throw new Error(out.refused)
  })
  expect(order[0]).toBe('BrandAgent')
  expect(order).toEqual(['BrandAgent', 'chats', 'notices'])
})

it('pending unflushed turn stops on busy before chats is deleted, so the flush retry succeeds and a re-run finishes', async () => {
  await resetAll()
  const { members } = await seedBrand(e.DB, openStores(e), T)
  const chat = await addChat(e.DB, e.FILES, { id: 'c_busy', owner: members.dana, lastAtMs: B - 1000, marker: 'busy' })

  const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: B })
  const agent = agentDouble({ [members.dana]: { runs: 1 } })
  const plan = await planPersonDeletion({ db: e.DB, bucket: e.FILES, brandAgent: agent, at: at(B + 10), clock: () => B + 10 }, { memberId: members.dana })
  if (!('ok' in plan)) throw new Error(plan.refused)
  expect(await runPersonDeletion({ db: e.DB, bucket: e.FILES, brandAgent: agent, at: at(B + 10), clock: () => B + 10 }, plan.ok)).toHaveProperty('ok')

  // Put the chat's R2 objects back so restore sees the pre-deletion state and replay must clean them up.
  await e.FILES.put(chat.fileKey, 'bytes busy')
  await e.FILES.put(chat.sessionKey, 'transcript busy')

  const record = await restore({
    bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(B + 20),
    durableObjects: [{ name: 'BrandAgent', recoveredAtMs: B - 1 }],
  })
  expect(record.status).toBe('restored_unreconciled')

  const recovered = e.BRAND_AGENT.getByName('replay-order-busy') as DurableObjectStub<BrandAgent>
  await runInDurableObject(recovered, async (instance, state) => {
    const sql = state.storage.sql
    // Recovered BrandAgent holds a final turn not yet flushed to D1 (`d1_flushed = 0`).
    sql.exec('INSERT INTO chat_state (chat_id, owner_id, next_pos, last_at_ms) VALUES (?, ?, 2, ?)', 'c_busy', members.dana, B - 1000)
    sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms, ended_at_ms) VALUES ('r_busy', 'c_busy', ?, 'ended', ?, ?)", members.dana, B - 500, B - 400)
    sql.exec(
      `INSERT INTO turns (turn_id, run_id, chat_id, owner_id, ord, client_key, payload_hash, state, priority, text,
        attachments_json, model, picker_id, side_model, effort, max_turns, answer_position, outcome, d1_flushed,
        created_at_ms, ended_at_ms)
       VALUES ('t_busy', 'r_busy', 'c_busy', ?, 0, 'ck-busy', 'ph', 'ended', 'now', 'hello', '[]', 'sonnet',
        'sonnet', 'haiku', 'low', 10, 'after', 'ok', 0, ?, ?)`,
      members.dana, B - 500, B - 400,
    )
    sql.exec("INSERT INTO events (run_id, seq, turn_id, at_ms, json) VALUES ('r_busy', 0, 't_busy', ?, ?)", B - 450,
      JSON.stringify({ type: 'part', messageId: 't_busy.0', part: { type: 'text', text: 'world' }, model: 'sonnet', at: { ms: B - 450 } }))
    fixTurnRows(sql, 't_busy', B - 400)

    const deps = {
      bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: ftsStub().rebuildFts,
      at: at(B + 30), runners: { BrandAgent: brandAgentRunner(instance) },
    }
    const stopped = await reconcile(deps)
    expect(stopped).toMatchObject({ refused: `replay_stopped: BrandAgent: busy (${members.dana})`, record: { status: 'restored_unreconciled' } })

    // Because BrandAgent stopped before `chats`, the chat row and its R2 objects are still intact in the target.
    expect(await e.RESTORE_DB.prepare("SELECT id FROM chats WHERE id = 'c_busy'").first()).toEqual({ id: 'c_busy' })
    expect(await e.FILES.get(chat.fileKey)).not.toBeNull()
    expect(await e.FILES.get(chat.sessionKey)).not.toBeNull()

    // The object's flush retry (`writeProjection`) now succeeds because `chats` still has `c_busy`.
    const proj = storedProjection(sql, 't_busy')
    expect(proj).not.toBeNull()
    await writeProjection(e.RESTORE_DB, proj!)
    sql.exec("UPDATE turns SET d1_flushed = 1 WHERE turn_id = 't_busy'")
    expect(await e.RESTORE_DB.prepare("SELECT id FROM chat_messages WHERE turn_id = 't_busy' ORDER BY pos").all()).toMatchObject({
      results: [{ id: 't_busy.u' }, { id: 't_busy.0' }],
    })

    // Re-running reconcile finishes cleanly and removes all of Dana's chats, flushed messages, R2 objects, and DO rows.
    const finished = await reconcile({ ...deps, at: at(B + 40) })
    if (!('ok' in finished)) throw new Error(finished.refused)
    expect(await e.RESTORE_DB.prepare("SELECT id FROM chats WHERE id = 'c_busy'").first()).toBeNull()
    expect(await e.RESTORE_DB.prepare("SELECT id FROM chat_messages WHERE chat_id = 'c_busy'").all()).toMatchObject({ results: [] })
    expect(await e.FILES.get(chat.fileKey)).toBeNull()
    expect(await e.FILES.get(chat.sessionKey)).toBeNull()
    expect(sql.exec('SELECT COUNT(*) AS n FROM runs WHERE owner_id = ?', members.dana).one().n).toBe(0)
    expect(sql.exec('SELECT COUNT(*) AS n FROM turns WHERE owner_id = ?', members.dana).one().n).toBe(0)

    const confirmed = await confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(B + 50, members.inhouse), approvedBy: members.admin })
    expect(confirmed).toMatchObject({ ok: { status: 'restored' } })
  })
})
