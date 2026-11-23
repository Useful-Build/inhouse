// Use the same generated history on live storage and on a restored backup. A deleted row returning, a boundary
// row disappearing, or a stopped person run deleting more than the live run did all break the comparison.
import { applyD1Migrations, runInDurableObject } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { fc } from '@fast-check/vitest'
import { expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { libraryKey } from '../../../server/db/r2-keys.ts'
import { openStores } from '../../../server/db/stores.ts'
import type { BrandAgent } from '../../../server/do/brand-agent/index.ts'
import { brandRetentionDays, retentionStores } from '../../../server/ops/retention-handlers.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import { CHAT_TABLES } from '../../coverage/chat-watch-connectors/brand-agent-storage.ts'
import { addActivity, addChat, addMemory, addNotice, addRead, withoutIndexes } from '../../coverage/chat-watch-connectors/test-support.ts'
import { planPersonDeletion, runPersonDeletion } from '../../delete/person.ts'
import { listAll } from '../../delete/r2.ts'
import { addPerson, addPhoto, addSetting, snapshotAll } from '../../delete/test-support.ts'
import { planRetention, runRetention } from '../../retention/retention.ts'
import { DEFAULT_DAYS, hasRetentionWork, periodsFor } from '../../retention/rules.ts'
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
const AGENT_TABLES = [...CHAT_TABLES, 'authority', 'flags'] as const
const RETENTION_STORES = [
  'chats', 'tool_calls', 'chat_files', 'BrandAgent', 'memories',
  'routine_slots', 'today_items', 'today_aside', 'activity_lines', 'notices', 'library_uploads',
] as const

const at = (nowMs: number, actorId = SYSTEM_MEMBER_ID) => ({ actorId, nowMs, requestId: `differential-${nowMs}` })

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
  const keys = (await listAll(bucket, '')).map(o => o.key)
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000))
}

const comparable = async (db: D1Database) => {
  const { d1, r2 } = withoutIndexes(await snapshotAll(db, bucket))
  // The deletion's replay gets its own write time and request stamp. All other member data must match.
  d1.members = d1.members.map(row => row.pseudonymised_at_ms === null ? row : {
    ...row, pseudonymised_at_ms: true, removed_at_ms: true, req_id: null,
  })
  return { d1, r2: Object.fromEntries(Object.entries(r2).filter(([key]) => !/^(backups|restore|deletion-log)\//.test(key))) }
}

const sortRows = (rows: Record<string, SqlStorageValue>[]) =>
  [...rows].sort((a, b) => {
    const sa = JSON.stringify(a)
    const sb = JSON.stringify(b)
    return sa < sb ? -1 : sa > sb ? 1 : 0
  })

const agentState = (sql: SqlStorage) =>
  Object.fromEntries(AGENT_TABLES.map(t => [t, sortRows(sql.exec(`SELECT * FROM ${t}`).toArray())]))

async function assertFts(
  db: D1Database,
  checks: { chatKeep?: readonly string[]; chatGone?: readonly string[]; memKeep?: readonly string[]; memGone?: readonly string[] },
): Promise<void> {
  const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n
  expect(await count('chat_messages_fts_docsize')).toBe(await count('chat_messages'))
  expect(await count('memories_fts_docsize')).toBe(await count('memories'))
  for (const m of checks.chatKeep ?? []) {
    const r = await db.prepare('SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH ?').bind(`"${m}"`).all()
    expect(r.results.length, `chat_messages_fts keep ${m}`).toBeGreaterThan(0)
  }
  for (const m of checks.chatGone ?? []) {
    const r = await db.prepare('SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH ?').bind(`"${m}"`).all()
    expect(r.results, `chat_messages_fts gone ${m}`).toEqual([])
  }
  for (const m of checks.memKeep ?? []) {
    const r = await db.prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?').bind(`"${m}"`).all()
    expect(r.results.length, `memories_fts keep ${m}`).toBeGreaterThan(0)
  }
  for (const m of checks.memGone ?? []) {
    const r = await db.prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?').bind(`"${m}"`).all()
    expect(r.results, `memories_fts gone ${m}`).toEqual([])
  }
}

const historyArb = fc.record({
  offsets: fc.array(fc.integer({ min: -60_000, max: 60_000 }), { minLength: 1, maxLength: 3 }),
  blockSecondSlot: fc.boolean(),
  orphanFileDelta: fc.constantFrom(-1, 0, 1),
})

let runSeq = 0

it('backup, live retention and person deletion, restore and replay converge across D1, R2 and BrandAgent', async () => {
  await fc.assert(fc.asyncProperty(historyArb, async generated => {
    const seq = ++runSeq
    await resetAll()
    const liveAgent = () => e.BRAND_AGENT.getByName(`replay-diff-live-${seq}`) as DurableObjectStub<BrandAgent>
    const recoveredAgent = () => e.BRAND_AGENT.getByName(`replay-diff-rec-${seq}`) as DurableObjectStub<BrandAgent>

    const { members } = await seedBrand(e.DB, openStores(e), B - 2 * DAY)
    const { id: stopped } = await addPerson(e.DB, { role: 'member', status: 'active' }, members.admin, B - DAY)
    const { id: retry } = await addPerson(e.DB, { role: 'member', status: 'active' }, members.admin, B - DAY)

    const chatCut = AFTER - DEFAULT_DAYS.chats * DAY
    const stepCut = AFTER - DEFAULT_DAYS.steps * DAY
    const trashCut = AFTER - DEFAULT_DAYS.trash * DAY
    const pendingCut = AFTER - DEFAULT_DAYS.pendingUpload * DAY
    const memoryCut = AFTER - DEFAULT_DAYS.forgottenMemory * DAY
    const offsets = [-1, 0, 1, ...generated.offsets]

    interface ChatCase { id: string; owner: string; lastAtMs: number; deletedAtMs?: number; fileMarkedAtMs?: number; runEndMs?: number }
    const history: ChatCase[] = [
      { id: 'c_before', owner: members.admin, lastAtMs: chatCut - DAY },
      { id: 'c_stopped', owner: stopped, lastAtMs: B - DAY },
      { id: 'c_retry', owner: retry, lastAtMs: B - DAY },
      // Chat stays alive while its ended run ages past `stepCut`, exercising BrandAgent run retention separately from chat cascade.
      { id: 'c_step_only', owner: members.admin, lastAtMs: B - DAY, runEndMs: stepCut - 1 },
      ...offsets.flatMap((delta, i) => [
        { id: `c_age_${i}`, owner: members.admin, lastAtMs: chatCut + delta },
        { id: `c_trash_${i}`, owner: members.admin, lastAtMs: B - DAY, deletedAtMs: trashCut + delta },
        { id: `c_ftrash_${i}`, owner: members.admin, lastAtMs: B - DAY, fileMarkedAtMs: trashCut + delta },
      ]),
    ]

    const seedAgent = (sql: SqlStorage) => {
      sql.exec("INSERT OR IGNORE INTO authority (kind, id, at_ms) VALUES ('member', ?, ?)", members.admin, B - DAY)
      sql.exec("INSERT OR IGNORE INTO flags (key, value) VALUES ('diff-flag', 'on')")
      for (const chat of history) {
        const end = chat.runEndMs ?? chat.lastAtMs
        const runId = `r_${chat.id}`
        const turnId = `t_${chat.id}`
        sql.exec('INSERT INTO chat_state (chat_id, owner_id, next_pos, last_at_ms) VALUES (?, ?, 2, ?)', chat.id, chat.owner, chat.lastAtMs)
        sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms, ended_at_ms) VALUES (?, ?, ?, 'ended', ?, ?)",
          runId, chat.id, chat.owner, end - 10, end)
        sql.exec(
          `INSERT INTO turns (turn_id, run_id, chat_id, owner_id, ord, client_key, payload_hash, state, priority, text,
            attachments_json, model, picker_id, side_model, effort, max_turns, answer_position, outcome, d1_flushed,
            created_at_ms, ended_at_ms)
           VALUES (?, ?, ?, ?, 0, ?, 'ph', 'ended', 'now', 'hi', '[]', 'sonnet', 'sonnet', 'haiku', 'low', 10, 'after', 'ok', 1, ?, ?)`,
          turnId, runId, chat.id, chat.owner, `ck_${chat.id}`, end - 10, end,
        )
        sql.exec('INSERT INTO events (run_id, seq, turn_id, at_ms, json) VALUES (?, 0, ?, ?, ?)',
          runId, turnId, end - 5, JSON.stringify({ type: 'part', messageId: `${turnId}.0`, part: { type: 'text', text: chat.id } }))
        sql.exec(
          `INSERT INTO run_tokens (token_hash, turn_id, run_id, chat_id, member_id, session_id, model, side_model, routes_open, issued_at_ms, expires_at_ms)
           VALUES (?, ?, ?, ?, ?, 's1', 'sonnet', 'haiku', ',model,', ?, ?)`,
          `tok_${chat.id}`, turnId, runId, chat.id, chat.owner, end - 10, end + DAY,
        )
        sql.exec(
          `INSERT INTO model_calls (turn_id, call_id, n, model, input_tokens, max_tokens, modifiers_json, worst_micro, state, arrived_at_ms)
           VALUES (?, ?, 0, 'sonnet', 10, 100, '[]', 100, 'done', ?)`,
          turnId, `mc_${chat.id}`, end - 8,
        )
        sql.exec("INSERT INTO ledger_queue (turn_id, n, op, state) VALUES (?, 0, 'settle', 'answered')", turnId)
        sql.exec('INSERT INTO turn_trace (turn_id, n, at_ms, json) VALUES (?, 0, ?, ?)', turnId, end - 4, '{}')
        sql.exec('INSERT INTO turn_rows (turn_id, chat_id, at_ms, json) VALUES (?, ?, ?, ?)', turnId, chat.id, end, '[]')
        if (chat.deletedAtMs !== undefined) {
          sql.exec('INSERT INTO chat_deletion (chat_id, deleted, rev, at_ms) VALUES (?, 1, 1, ?)', chat.id, chat.deletedAtMs)
        }
      }
    }

    for (const chat of history) await addChat(e.DB, bucket, { ...chat, marker: chat.id })
    // Non-vacuous tool_calls retention: old and edge tool_calls on surviving chat `c_step_only` (chat lastAtMs = B - DAY).
    await e.DB.batch([
      e.DB.prepare("INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES ('t_c_step_only', 1, 'c_step_only', ?, 'pre', 'shop.old', 'allow', 2, 'ab', ?)").bind(members.admin, stepCut - 1),
      e.DB.prepare("INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES ('t_c_step_only', 2, 'c_step_only', ?, 'pre', 'shop.edge', 'allow', 2, 'ab', ?)").bind(members.admin, stepCut),
    ])

    // Routine separate from migration-seeded `routine-morning-check` (restore checks pristine seeded rows).
    await e.DB.prepare(
      `INSERT INTO routines (id, origin, name, instruction, days_mask, hour, minute, missed, need, creator_id, checked_until_ms, created_at_ms, updated_at_ms)
       VALUES ('r_diff', 'team', 'Diff routine', 'check', 127, 9, 0, 'skip', 0, ?, ?, ?, ?)`,
    ).bind(members.admin, B - 2 * DAY, B - 2 * DAY, B - 2 * DAY).run()

    for (const [i, delta] of offsets.entries()) {
      await addActivity(e.DB, { id: `a_${i}`, actor: members.admin, subject: null, atMs: stepCut + delta })
      await addMemory(e.DB, { id: `mem_${i}`, owner: null, createdBy: members.admin, marker: `memory${i}`, status: 'forgotten',
        updatedAtMs: memoryCut + delta })

      // Team notices and their reads, aged by `notices`.
      const noticeId = `nt_${i}`
      await addNotice(e.DB, { id: noticeId, audience: 'team', atMs: stepCut + delta })
      await addRead(e.DB, members.admin, noticeId, stepCut + delta)

      // Routine slots, Today items (referencing the first few slots so both freed and still-referenced slots are tested), and Today aside.
      const slotKey = `r_diff|2026-01-0${i + 1}|09:00`
      await e.DB.prepare(
        `INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, local_time, tz, due_at_ms, deadline_ms, state, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, claimed_at_ms)
         VALUES (?, 'r_diff', 'scheduled', ?, '09:00', 'UTC', ?, ?, 'ended', 'c_before', ?, 'go', '{}', 1, ?, ?)`,
      ).bind(slotKey, `2026-01-0${i + 1}`, stepCut + delta, stepCut + delta + 60_000, `ck_slot_${i}`, members.admin, stepCut + delta).run()

      if (i === 0 || (i === 1 && generated.blockSecondSlot)) {
        // When `today_items` isn't past retention (`B - DAY`), `routine_slots` must keep `slotKey` even if its slot is old.
        const itemAtMs = i === 0 ? stepCut + delta : B - DAY
        await e.DB.prepare(
          `INSERT INTO today_items (id, key, local_date, slot_key, claimed_at_ms, run_id, item_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?, 'r_diff_run', '{}', ?)`,
        ).bind(`ti_${i}`, `k_${i}`, `2026-01-0${i + 1}`, slotKey, stepCut + delta, itemAtMs).run()
      }
      await e.DB.prepare(
        "INSERT INTO today_aside (item_id, reason, by, at_ms) VALUES (?, 'snoozed', ?, ?)",
      ).bind(`ta_${i}`, members.admin, stepCut + delta).run()

      // Library uploads: a pending upload around pendingCut and a saved trashed upload around trashCut (plus R2 bytes + mark).
      const pendingId = `up_p_${i}`
      const pendingKey = libraryKey(pendingId)
      await e.DB.prepare(
        "INSERT INTO library_uploads (id, name, content_type, bytes, sha256, r2_key, state, created_by, created_at_ms) VALUES (?, 'p.txt', 'text/plain', 3, 'ab', ?, 'pending', ?, ?)",
      ).bind(pendingId, pendingKey, members.admin, pendingCut + delta).run()
      await bucket.put(pendingKey, `pending-${i}`)

      const trashUpId = `up_t_${i}`
      const trashUpKey = libraryKey(trashUpId)
      await e.DB.batch([
        e.DB.prepare("INSERT INTO library_uploads (id, name, content_type, bytes, sha256, r2_key, state, created_by, created_at_ms) VALUES (?, 't.txt', 'text/plain', 3, 'ab', ?, 'saved', ?, ?)").bind(trashUpId, trashUpKey, members.admin, B - 2 * DAY),
        e.DB.prepare("INSERT INTO library_marks (file_id, source, deleted_at_ms, deleted_by) VALUES (?, 'upload', ?, ?)").bind(trashUpId, trashCut + delta, members.admin),
      ])
      await bucket.put(trashUpKey, `trashed-upload-${i}`)
    }

    // Unmarked saved library upload must stay untouched, while orphaned chat_files mark follows trashCut.
    await e.DB.prepare("INSERT INTO library_uploads (id, name, content_type, bytes, sha256, r2_key, state, created_by, created_at_ms) VALUES ('up_keep', 'keep.txt', 'text/plain', 4, 'ab', ?, 'saved', ?, ?)")
      .bind(libraryKey('up_keep'), members.admin, B - 2 * DAY).run()
    await bucket.put(libraryKey('up_keep'), 'keep')
    await e.DB.prepare("INSERT INTO library_marks (file_id, source, deleted_at_ms, deleted_by) VALUES ('f_orphan', 'chat', ?, ?)")
      .bind(trashCut + generated.orphanFileDelta, members.admin).run()

    // Surviving active brand memory + personal data for person deletion (settings, memories, photos/, notices & own notice_reads).
    await addMemory(e.DB, { id: 'mem_keep', owner: null, createdBy: members.admin, marker: 'memkeepbrand', status: 'active', updatedAtMs: B - DAY })
    for (const member of [stopped, retry, members.dana]) {
      const id = `n_${member}`
      await addNotice(e.DB, { id, audience: 'member', member, atMs: B - DAY })
      await addRead(e.DB, members.admin, id, B - DAY)
    }
    for (const [tag, member] of [['stopped', stopped], ['retry', retry]] as const) {
      await addSetting(e.DB, member, { theme: tag }, member, B - DAY)
      await addMemory(e.DB, { id: `mem_${tag}`, owner: member, createdBy: member, marker: `memperson${tag}`, status: 'active', updatedAtMs: B - DAY })
      await addPhoto(e.DB, bucket, member)
      await addRead(e.DB, member, 'nt_1', B - DAY)
    }

    const retain = async (names: readonly string[], atMs: number, sql: SqlStorage, logAtMs = atMs) => {
      const registry = tables.filter(t => names.includes(t.name))
      const deps = { db: e.DB, bucket, sql, registry, at: at(atMs), clock: () => logAtMs }
      return runRetention(deps, await planRetention(deps, { periods: periodsFor(registry) }))
    }
    await runInDurableObject(liveAgent(), async (_instance, state) => {
      await state.storage.deleteAlarm()
      seedAgent(state.storage.sql)
      expect((await retain(['chats'], BEFORE, state.storage.sql)).removed.chats).toBe(1)
    })

    const manifest = await backup({ db: e.DB, bucket, nowMs: B })
    const backedUp = await comparable(e.DB)
    await runInDurableObject(liveAgent(), async (instance, state) => {
      const sql = state.storage.sql
      let tick = AFTER
      // Production (`retentionPass`) plans and runs one store at a time; run a second `routine_slots` pass after `today_items`
      // so the slot freed by `today_items` deletion is also reclaimed while an active `today_items` still protects its slot.
      for (const store of [...RETENTION_STORES, 'routine_slots']) {
        await retain([store], AFTER, sql, tick++)
      }
      for (const [i, memberId] of [stopped, retry, retry].entries()) {
        const nowMs = AFTER + 50 + i
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
    expect(expected.d1.chats.map(row => row.id)).toEqual(expect.arrayContaining(['c_age_1', 'c_trash_1', 'c_stopped', 'c_step_only']))
    for (const id of ['c_before', 'c_age_0', 'c_trash_0', 'c_retry']) expect(expected.d1.chats.map(row => row.id)).not.toContain(id)
    expect(expected.d1.library_uploads.map(row => row.id)).toContain('up_keep')
    expect(expected.d1.library_uploads.map(row => row.id)).not.toContain('up_p_0')
    expect(expected.d1.library_uploads.map(row => row.id)).not.toContain('up_t_0')
    expect(expected.d1.tool_calls.filter(r => r.chat_id === 'c_step_only').map(r => r.n)).toEqual([0, 2])
    expect(expected.d1.settings.some(r => r.owner === retry)).toBe(false)
    expect(expected.d1.notice_reads.some(r => r.member_id === retry)).toBe(false)
    expect(Object.keys(expected.r2).some(k => k.startsWith(`photos/${retry}/`))).toBe(false)
    const ftsChecks = {
      chatKeep: ['c_age_1', 'c_stopped', 'c_step_only'],
      chatGone: ['c_before', 'c_age_0', 'c_trash_0', 'c_retry'],
      memKeep: ['memkeepbrand', 'mempersonstopped'],
      memGone: ['memory0', 'mempersonretry'],
    }
    await assertFts(e.DB, ftsChecks)
    const expectedAgent = await runInDurableObject(liveAgent(), (_instance, state) => agentState(state.storage.sql))
    expect(expectedAgent.runs.map(r => r.run_id)).not.toContain('r_c_step_only')

    // Recreate backup-era objects still present in R2. Replay must clean up their stale bytes as well as D1 rows.
    for (const [key, body] of Object.entries(backedUp.r2)) {
      if (!(key in expected.r2)) await bucket.put(key, Uint8Array.from(atob(body.base64), c => c.charCodeAt(0)))
    }
    const record = await restore({ bucket, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(AFTER + 100),
      durableObjects: [{ name: 'BrandAgent', recoveredAtMs: BEFORE - 1 }] })
    expect(record.status).toBe('restored_unreconciled')
    await runInDurableObject(recoveredAgent(), async (instance, state) => {
      await state.storage.deleteAlarm()
      seedAgent(state.storage.sql)
      const deps = { bucket, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(AFTER + 110), retentionSql: state.storage.sql,
        runners: { BrandAgent: brandAgentRunner(instance) } }
      for (let pass = 0; pass < 2; pass++) {
        const reconciled = await reconcile(deps)
        if (!('ok' in reconciled)) throw new Error(reconciled.refused)
        expect(await comparable(e.RESTORE_DB)).toEqual(expected)
        expect(agentState(state.storage.sql)).toEqual(expectedAgent)
        await assertFts(e.RESTORE_DB, ftsChecks)
      }
      const confirmed = await confirmRestore({ ...deps, at: at(AFTER + 120, members.inhouse), approvedBy: members.admin })
      expect(confirmed).toMatchObject({ ok: { status: 'restored' } })
    })
  }), { numRuns: 4 })
})

it('topology agentPoint > d1Point converges across D1, R2, BrandAgent and FTS', async () => {
  await resetAll()
  const { members } = await seedBrand(e.DB, openStores(e), B - 2 * DAY)
  const early = (await addPerson(e.DB, { role: 'member', status: 'active' }, members.admin, B - DAY)).id
  const late = (await addPerson(e.DB, { role: 'member', status: 'active' }, members.admin, B - DAY)).id
  const chats = [
    { id: 'c_early', owner: early, lastAtMs: B - DAY },
    { id: 'c_late', owner: late, lastAtMs: B - DAY },
    { id: 'c_live', owner: members.admin, lastAtMs: B - DAY },
  ]
  for (const c of chats) await addChat(e.DB, bucket, { ...c, marker: c.id })
  await addMemory(e.DB, { id: 'mem_early', owner: early, createdBy: early, marker: 'memearly', status: 'active', updatedAtMs: B - DAY })
  await addMemory(e.DB, { id: 'mem_late', owner: late, createdBy: late, marker: 'memlate', status: 'active', updatedAtMs: B - DAY })
  await addPhoto(e.DB, bucket, early)
  await addPhoto(e.DB, bucket, late)
  await addSetting(e.DB, early, { a: 1 }, early, B - DAY)
  await addSetting(e.DB, late, { b: 2 }, late, B - DAY)

  const seedChatRows = (sql: SqlStorage, list: readonly { id: string; owner: string; lastAtMs: number }[]) => {
    for (const c of list) {
      sql.exec('INSERT INTO chat_state (chat_id, owner_id, next_pos, last_at_ms) VALUES (?, ?, 2, ?)', c.id, c.owner, c.lastAtMs)
      sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms, ended_at_ms) VALUES (?, ?, ?, 'ended', ?, ?)", `r_${c.id}`, c.id, c.owner, c.lastAtMs - 10, c.lastAtMs)
    }
  }
  const liveAgent = e.BRAND_AGENT.getByName('diff-after-live') as DurableObjectStub<BrandAgent>
  const recAgent = e.BRAND_AGENT.getByName('diff-after-rec') as DurableObjectStub<BrandAgent>
  await runInDurableObject(liveAgent, async (_i, state) => { await state.storage.deleteAlarm(); seedChatRows(state.storage.sql, chats) })

  const manifest = await backup({ db: e.DB, bucket, nowMs: B })
  const backedUp = await comparable(e.DB)
  const T1 = B + 10_000 // > d1Point (B - 60_000), < agentPoint (B + 120_000 - 60_000 = B + 60_000)
  const R = B + 120_000
  const T2 = R + 30_000 // >= agentPoint
  await runInDurableObject(liveAgent, async instance => {
    for (const [memberId, when] of [[early, T1], [late, T2]] as const) {
      const deps = { db: e.DB, bucket, brandAgent: instance, at: at(when), clock: () => when }
      const plan = await planPersonDeletion(deps, { memberId })
      if (!('ok' in plan)) throw new Error(plan.refused)
      expect(await runPersonDeletion(deps, plan.ok)).toHaveProperty('ok')
    }
  })
  const expected = await comparable(e.DB)
  const expectedAgent = await runInDurableObject(liveAgent, (_i, state) => agentState(state.storage.sql))
  for (const [key, body] of Object.entries(backedUp.r2)) {
    if (!(key in expected.r2)) await bucket.put(key, Uint8Array.from(atob(body.base64), c => c.charCodeAt(0)))
  }

  const record = await restore({ bucket, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(T2 + 10), durableObjects: [{ name: 'BrandAgent', recoveredAtMs: R }] })
  await runInDurableObject(recAgent, async (instance, state) => {
    await state.storage.deleteAlarm()
    // Recovered to R > T1: `early` was already deleted from the DO at T1, while `late` and `c_live` were present.
    seedChatRows(state.storage.sql, chats.filter(c => c.id !== 'c_early'))
    const deps = { bucket, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(T2 + 20), retentionSql: state.storage.sql, runners: { BrandAgent: brandAgentRunner(instance) } }
    const out = await reconcile(deps)
    if (!('ok' in out)) throw new Error(out.refused)
    expect(await comparable(e.RESTORE_DB)).toEqual(expected)
    expect(agentState(state.storage.sql)).toEqual(expectedAgent)
    await assertFts(e.RESTORE_DB, { chatKeep: ['c_live'], chatGone: ['c_early', 'c_late'], memGone: ['memearly', 'memlate'] })
    expect(await confirmRestore({ ...deps, at: at(T2 + 30, members.inhouse), approvedBy: members.admin })).toMatchObject({ ok: { status: 'restored' } })
  })
})

it('topology Until deleted replays trash-only without deleting old live chats or steps', async () => {
  await resetAll()
  const stores = openStores(e)
  const { members } = await seedBrand(e.DB, stores, B - 2 * DAY)
  for (const key of ['d:chats', 'd:steps'] as const) {
    expect(await stores.settings.write({ owner: 'brand', scope: 'technical', key, value: 'Until deleted', ifRev: 0 }, at(B - 2 * DAY, members.admin))).toHaveProperty('ok')
  }
  const trashCut = AFTER - DEFAULT_DAYS.trash * DAY
  const old = B - 900 * DAY
  await addChat(e.DB, bucket, { id: 'c_old_live', owner: members.admin, lastAtMs: old, marker: 'cOldLive' })
  await addChat(e.DB, bucket, { id: 'c_trash_gone', owner: members.admin, lastAtMs: B - DAY, deletedAtMs: trashCut - 1, marker: 'cTrashGone' })
  await addChat(e.DB, bucket, { id: 'c_trash_edge', owner: members.admin, lastAtMs: B - DAY, deletedAtMs: trashCut, marker: 'cTrashEdge' })
  await addChat(e.DB, bucket, { id: 'c_file_trash', owner: members.admin, lastAtMs: B - DAY, fileMarkedAtMs: trashCut - 1, marker: 'cFileTrash' })
  await addActivity(e.DB, { id: 'a_old_keep', actor: members.admin, subject: null, atMs: old })
  await addMemory(e.DB, { id: 'mem_f_gone', owner: null, createdBy: members.admin, marker: 'memFGone', status: 'forgotten', updatedAtMs: AFTER - DEFAULT_DAYS.forgottenMemory * DAY - 1 })

  const liveAgent = e.BRAND_AGENT.getByName('diff-until-live') as DurableObjectStub<BrandAgent>
  const recAgent = e.BRAND_AGENT.getByName('diff-until-rec') as DurableObjectStub<BrandAgent>
  const seed = (sql: SqlStorage) => {
    for (const c of ['c_old_live', 'c_trash_gone', 'c_trash_edge', 'c_file_trash']) {
      sql.exec('INSERT INTO chat_state (chat_id, owner_id, next_pos, last_at_ms) VALUES (?, ?, 2, ?)', c, members.admin, B - DAY)
    }
  }
  await runInDurableObject(liveAgent, async (_i, state) => { await state.storage.deleteAlarm(); seed(state.storage.sql) })

  const manifest = await backup({ db: e.DB, bucket, nowMs: B })
  const backedUp = await comparable(e.DB)
  const days = await brandRetentionDays(e.DB)
  expect(days).toEqual({ ...DEFAULT_DAYS, chats: null, steps: null })
  await runInDurableObject(liveAgent, async (_i, state) => {
    let tick = AFTER
    for (const entry of retentionStores()) {
      const reg = [entry]
      const periods = periodsFor(reg, days)
      if (!hasRetentionWork(entry.name, periods)) continue
      const deps = { db: e.DB, bucket, sql: state.storage.sql, registry: reg, at: at(AFTER), clock: () => tick++ }
      await runRetention(deps, await planRetention(deps, { periods }))
    }
  })
  const expected = await comparable(e.DB)
  const expectedAgent = await runInDurableObject(liveAgent, (_i, state) => agentState(state.storage.sql))
  expect(expected.d1.chats.map(r => r.id).sort()).toEqual(['c_file_trash', 'c_old_live', 'c_trash_edge'])
  expect(expected.d1.activity_lines.map(r => r.id)).toContain('a_old_keep')
  for (const [key, body] of Object.entries(backedUp.r2)) {
    if (!(key in expected.r2)) await bucket.put(key, Uint8Array.from(atob(body.base64), c => c.charCodeAt(0)))
  }

  const record = await restore({ bucket, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(AFTER + 50), durableObjects: [{ name: 'BrandAgent', recoveredAtMs: BEFORE - 1 }] })
  await runInDurableObject(recAgent, async (instance, state) => {
    await state.storage.deleteAlarm()
    seed(state.storage.sql)
    const deps = { bucket, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(AFTER + 60), retentionSql: state.storage.sql, runners: { BrandAgent: brandAgentRunner(instance) } }
    for (let pass = 0; pass < 2; pass++) {
      const out = await reconcile(deps)
      if (!('ok' in out)) throw new Error(out.refused)
      expect(await comparable(e.RESTORE_DB)).toEqual(expected)
      expect(agentState(state.storage.sql)).toEqual(expectedAgent)
      await assertFts(e.RESTORE_DB, { chatKeep: ['cOldLive', 'cTrashEdge', 'cFileTrash'], chatGone: ['cTrashGone'], memGone: ['memFGone'] })
    }
    expect(await confirmRestore({ ...deps, at: at(AFTER + 70, members.inhouse), approvedBy: members.admin })).toMatchObject({ ok: { status: 'restored' } })
  })
})

it('topology busy DO recovery refuses replay_stopped until settled, then converges', async () => {
  await resetAll()
  const { members } = await seedBrand(e.DB, openStores(e), B - 2 * DAY)
  const chatCut = AFTER - DEFAULT_DAYS.chats * DAY
  const stepCut = AFTER - DEFAULT_DAYS.steps * DAY
  await addChat(e.DB, bucket, { id: 'c_ret_busy', owner: members.admin, lastAtMs: chatCut - 10, marker: 'cRetBusy' })
  await addChat(e.DB, bucket, { id: 'c_ret_keep', owner: members.admin, lastAtMs: B - DAY, marker: 'cRetKeep' })

  const liveAgent = e.BRAND_AGENT.getByName('diff-busy-live') as DurableObjectStub<BrandAgent>
  const recAgent = e.BRAND_AGENT.getByName('diff-busy-rec') as DurableObjectStub<BrandAgent>
  await runInDurableObject(liveAgent, async (_i, state) => {
    await state.storage.deleteAlarm()
    const sql = state.storage.sql
    sql.exec('INSERT INTO chat_state (chat_id, owner_id, next_pos, last_at_ms) VALUES (?, ?, 2, ?)', 'c_ret_busy', members.admin, chatCut - 10)
    sql.exec('INSERT INTO chat_state (chat_id, owner_id, next_pos, last_at_ms) VALUES (?, ?, 2, ?)', 'c_ret_keep', members.admin, B - DAY)
    sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms, ended_at_ms) VALUES ('r_ret_old', 'c_ret_keep', ?, 'ended', ?, ?)", members.admin, stepCut - 20, stepCut - 1)
  })
  const manifest = await backup({ db: e.DB, bucket, nowMs: B })
  const backedUp = await comparable(e.DB)
  await runInDurableObject(liveAgent, async (_i, state) => {
    let tick = AFTER
    for (const store of ['chats', 'BrandAgent']) {
      const reg = tables.filter(t => t.name === store)
      const deps = { db: e.DB, bucket, sql: state.storage.sql, registry: reg, at: at(AFTER), clock: () => tick++ }
      await runRetention(deps, await planRetention(deps, { periods: periodsFor(reg) }))
    }
  })
  const expected = await comparable(e.DB)
  const expectedAgent = await runInDurableObject(liveAgent, (_i, state) => agentState(state.storage.sql))
  for (const [key, body] of Object.entries(backedUp.r2)) {
    if (!(key in expected.r2)) await bucket.put(key, Uint8Array.from(atob(body.base64), c => c.charCodeAt(0)))
  }

  const record = await restore({ bucket, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(AFTER + 50), durableObjects: [{ name: 'BrandAgent', recoveredAtMs: BEFORE - 1 }] })
  await runInDurableObject(recAgent, async (instance, state) => {
    await state.storage.deleteAlarm()
    const sql = state.storage.sql
    // Recovered DO holds a busy chat (live_run_id set) and an unsafe ended run (d1_flushed = 0).
    sql.exec("INSERT INTO chat_state (chat_id, owner_id, live_run_id, next_pos, last_at_ms) VALUES ('c_ret_busy', ?, 'r_live_busy', 2, ?)", members.admin, chatCut - 10)
    sql.exec("INSERT INTO chat_state (chat_id, owner_id, next_pos, last_at_ms) VALUES ('c_ret_keep', ?, 2, ?)", members.admin, B - DAY)
    sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms, ended_at_ms) VALUES ('r_ret_old', 'c_ret_keep', ?, 'ended', ?, ?)", members.admin, stepCut - 20, stepCut - 1)
    sql.exec(
      `INSERT INTO turns (turn_id, run_id, chat_id, owner_id, ord, client_key, payload_hash, state, priority, text,
        attachments_json, model, picker_id, side_model, effort, max_turns, answer_position, d1_flushed, created_at_ms)
       VALUES ('t_ret_old', 'r_ret_old', 'c_ret_keep', ?, 0, 'ck_ret', 'ph', 'ended', 'now', 'hi', '[]', 'm', 'p', 's', 'e', 1, 'after', 0, ?)`,
      members.admin, stepCut - 20,
    )

    const deps = { bucket, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(AFTER + 60), retentionSql: sql, runners: { BrandAgent: brandAgentRunner(instance) } }
    const refused = await reconcile(deps)
    expect(refused).toMatchObject({ refused: expect.stringMatching(/^replay_stopped: /), record: { status: 'restored_unreconciled' } })
    expect(await confirmRestore({ ...deps, at: at(AFTER + 65, members.inhouse), approvedBy: members.admin })).toMatchObject({ refused: 'not_reconciled: audit' })

    // Settle the busy chat and flush the ended turn, then re-run reconcile -> converges and confirms.
    sql.exec("UPDATE chat_state SET live_run_id = NULL WHERE chat_id = 'c_ret_busy'")
    sql.exec("UPDATE turns SET d1_flushed = 1 WHERE turn_id = 't_ret_old'")
    const out = await reconcile({ ...deps, at: at(AFTER + 70) })
    if (!('ok' in out)) throw new Error(out.refused)
    expect(await comparable(e.RESTORE_DB)).toEqual(expected)
    expect(agentState(sql)).toEqual(expectedAgent)
    await assertFts(e.RESTORE_DB, { chatKeep: ['cRetKeep'], chatGone: ['cRetBusy'] })
    expect(await confirmRestore({ ...deps, at: at(AFTER + 80, members.inhouse), approvedBy: members.admin })).toMatchObject({ ok: { status: 'restored' } })
  })
})
