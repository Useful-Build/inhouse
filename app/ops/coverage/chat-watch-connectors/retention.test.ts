// Retention over P3 and P4's stores (P8 C1, acceptance 1), with a pinned clock. Ways it can fail, written down first:
//  1. a chat goes by a message's age while it lives, or stays past its last activity's cutoff, or a soft-deleted chat
//     goes a day early or stays a day late; its messages, files, transcripts or BrandAgent rows stay behind;
//  2. a forgotten memory stays past 30 days, or an active or waiting one goes;
//  3. a Library upload goes when it shouldn't (saved and unmarked), stays when it should go (pending a day, marked 30
//     days), or its row goes before its object;
//  4. a BrandAgent ended run's rows stay past the steps cutoff, the run exactly at it goes, or a live run's rows go;
//  5. a steps row strictly older than its cutoff stays, or the row exactly at it goes; a read outlives its notice, or a
//     slot a today item still references goes (its foreign key would refuse the batch);
//  6. the dry run writes anything, or counts other than an independent count;
//  7. a P3 to P5 entry has no retention decision, deletion rule or export decision.
// Each case pins its own clock a decade before the last, so no row from an earlier case is past a later case's cutoff.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { libraryKey } from '../../../server/db/r2-keys.ts'
import { openStores } from '../../../server/db/stores.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import type { Seeded } from '../../../server/seed/seed.ts'
import { snapshotAll, token } from '../../delete/test-support.ts'
import { deletionRules } from '../../delete/rules.ts'
import { planRetention, runRetention } from '../../retention/retention.ts'
import { DEFAULT_DAYS, periodsFor, retentionRules } from '../../retention/rules.ts'
import { tables } from '../../tables/index.ts'
import { addActivity, addChat, addMemory, addNotice, addRead } from './test-support.ts'

const db = env.DB
const bucket = env.FILES as R2Bucket
const DAY = 86_400_000
let base = 2_400_000_000_000
/** A new pinned clock, a decade before the last. */
const nextClock = () => (base -= 3_650 * DAY)
let seeded: Seeded
const entry = (name: string) => {
  const e = tables.find(t => t.name === name)
  if (!e) throw new Error(`no entry ${name}`)
  return e
}
let wall = 3_000_000_000_000
/** Plans and runs retention on `stores` only, at `nowMs`. */
async function retain(stores: string[], nowMs: number, sql?: SqlStorage) {
  const registry = stores.map(entry)
  const d = { db, bucket, sql, at: { actorId: SYSTEM_MEMBER_ID, requestId: `req-${token()}`, nowMs }, clock: () => ++wall, registry }
  const plan = await planRetention(d, { periods: periodsFor(registry) })
  const result = await runRetention(d, plan)
  return { plan, result }
}
const has = async (table: string, where: string, ...args: (string | number)[]) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...args).first<{ n: number }>())!.n
const object = async (key: string) => (await bucket.head(key)) !== null

beforeAll(async () => {
  seeded = await seedBrand(db, openStores(env), base)
})

describe('chats (failure 1)', () => {
  it('removes a chat whose last activity is past the cutoff, with its messages, files and transcripts; keeps every message and transcript part of a chat with recent activity, however old its first message', async () => {
    const now = nextClock()
    const cut = now - DEFAULT_DAYS.chats * DAY
    const old = `c_${token()}`
    const live = `c_${token()}`
    const oldObjs = await addChat(db, bucket, { id: old, owner: seeded.members.dana, lastAtMs: cut - 1, marker: 'old' })
    const liveObjs = await addChat(db, bucket, { id: live, owner: seeded.members.dana, lastAtMs: cut + 1, marker: 'live' })
    // The live chat's first message is years old: it stays with its chat.
    await db.prepare('UPDATE chat_messages SET at_ms = ? WHERE chat_id = ?').bind(cut - 900 * DAY, live).run()
    // The chat cascade's stores (tool_calls and chat_files have own-age jobs too, planned on their own as the handler does).
    const { result } = await retain(['chats', 'chat_messages', 'files/', 'sessions/'], now)
    expect(await has('chats', 'id = ?', old)).toBe(0)
    for (const t of ['chat_messages', 'tool_calls', 'chat_files']) expect(await has(t, 'chat_id = ?', old), t).toBe(0)
    expect(await has('library_marks', 'file_id = ?', oldObjs.fileId)).toBe(0)
    expect(await object(oldObjs.fileKey)).toBe(false)
    expect(await object(oldObjs.sessionKey)).toBe(false)
    expect(await has('chats', 'id = ?', live)).toBe(1)
    expect(await has('chat_messages', 'chat_id = ?', live)).toBe(2)
    expect(await object(liveObjs.fileKey)).toBe(true)
    expect(await object(liveObjs.sessionKey)).toBe(true)
    expect(result.removed).toMatchObject({ chats: 1, chat_messages: 2, 'files/': 1, 'sessions/': 1 })
    expect(result.differences).toEqual([])
  })

  it('removes a soft-deleted chat 30 days after its deletion and not a day before', async () => {
    const now = nextClock()
    const trashCut = now - DEFAULT_DAYS.trash * DAY
    const gone = `c_${token()}`
    const kept = `c_${token()}`
    await addChat(db, bucket, { id: gone, owner: seeded.members.dana, lastAtMs: now - DAY, deletedAtMs: trashCut - 1, marker: 'trash1' })
    await addChat(db, bucket, { id: kept, owner: seeded.members.dana, lastAtMs: now - DAY, deletedAtMs: trashCut + DAY, marker: 'trash2' })
    await retain(['chats'], now)
    expect(await has('chats', 'id = ?', gone)).toBe(0)
    expect(await has('chats', 'id = ?', kept)).toBe(1)
  })

  it('the trash purge removes a Library-deleted chat output\'s files/ object, then its chat_files row and mark, 30 days after the mark', async () => {
    const now = nextClock()
    const trashCut = now - DEFAULT_DAYS.trash * DAY
    const a = await addChat(db, bucket, { id: `c_${token()}`, owner: seeded.members.dana, lastAtMs: now, marker: 'mk1', fileMarkedAtMs: trashCut - 1 })
    const b = await addChat(db, bucket, { id: `c_${token()}`, owner: seeded.members.dana, lastAtMs: now, marker: 'mk2', fileMarkedAtMs: trashCut })
    await retain(['chat_files', 'library_marks', 'files/'], now)
    expect(await object(a.fileKey)).toBe(false)
    expect(await has('chat_files', 'id = ?', a.fileId)).toBe(0)
    expect(await has('library_marks', 'file_id = ?', a.fileId)).toBe(0)
    expect(await object(b.fileKey)).toBe(true)
    expect(await has('chat_files', 'id = ?', b.fileId)).toBe(1)
  })
})

describe('memories and the Library (failures 2 and 3)', () => {
  it('removes a forgotten memory 30 days after its last update and never an active or waiting one', async () => {
    const now = nextClock()
    const cut = now - DEFAULT_DAYS.forgottenMemory * DAY
    const ids = { gone: `m1_${token()}`, edge: `m2_${token()}`, active: `m3_${token()}`, waiting: `m4_${token()}` }
    await addMemory(db, { id: ids.gone, owner: null, createdBy: SYSTEM_MEMBER_ID, marker: 'f1', status: 'forgotten', updatedAtMs: cut - 1 })
    await addMemory(db, { id: ids.edge, owner: null, createdBy: SYSTEM_MEMBER_ID, marker: 'f2', status: 'forgotten', updatedAtMs: cut })
    await addMemory(db, { id: ids.active, owner: null, createdBy: SYSTEM_MEMBER_ID, marker: 'f3', status: 'active', updatedAtMs: cut - 999 * DAY })
    await addMemory(db, { id: ids.waiting, owner: null, createdBy: SYSTEM_MEMBER_ID, marker: 'f4', status: 'waiting', updatedAtMs: cut - 999 * DAY })
    await retain(['memories'], now)
    expect(await has('memories', 'id = ?', ids.gone)).toBe(0)
    for (const id of [ids.edge, ids.active, ids.waiting]) expect(await has('memories', 'id = ?', id), id).toBe(1)
  })

  it('removes a pending Library upload after 1 day, a marked-deleted one 30 days after its mark, never a saved unmarked one, and each object before its row', async () => {
    const now = nextClock()
    const up = async (state: 'pending' | 'saved', createdAtMs: number, markedAtMs?: number) => {
      const id = `u_${token()}`
      await db.prepare('INSERT INTO library_uploads (id, name, content_type, bytes, sha256, r2_key, state, created_by, created_at_ms) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)')
        .bind(id, 'doc.txt', 'text/plain', 'ab', libraryKey(id), state, seeded.members.dana, createdAtMs).run()
      if (markedAtMs !== undefined) await db.prepare("INSERT INTO library_marks (file_id, source, deleted_at_ms, deleted_by) VALUES (?, 'upload', ?, ?)").bind(id, markedAtMs, seeded.members.dana).run()
      await bucket.put(libraryKey(id), 'x')
      return id
    }
    const pendingOld = await up('pending', now - DAY - 1)
    const pendingNew = await up('pending', now - DAY)
    const marked = await up('saved', now - 900 * DAY, now - 30 * DAY - 1)
    const markedNew = await up('saved', now - 900 * DAY, now - 30 * DAY)
    const saved = await up('saved', now - 9_000 * DAY)
    // The object goes first: a bucket whose delete fails leaves every row.
    const failing = Object.assign(Object.create(Object.getPrototypeOf(bucket)), bucket, { delete: async () => { throw new Error('R2 delete failed (test)') } }) as R2Bucket
    const registry = ['library_uploads', 'library_marks', 'library/'].map(entry)
    const d = { db, bucket: failing, at: { actorId: SYSTEM_MEMBER_ID, requestId: 'r', nowMs: now }, clock: () => ++wall, registry }
    for (const m of ['list', 'get', 'head', 'put'] as const) (failing as unknown as Record<string, unknown>)[m] = (bucket[m] as (...a: unknown[]) => unknown).bind(bucket)
    await expect(runRetention(d, await planRetention(d, { periods: periodsFor(registry) }))).rejects.toThrow(/R2 delete failed/)
    for (const id of [pendingOld, marked]) expect(await has('library_uploads', 'id = ?', id), id).toBe(1)
    await retain(['library_uploads', 'library_marks', 'library/'], now)
    for (const id of [pendingOld, marked]) {
      expect(await has('library_uploads', 'id = ?', id), id).toBe(0)
      expect(await object(libraryKey(id)), id).toBe(false)
    }
    expect(await has('library_marks', 'file_id = ?', marked)).toBe(0)
    for (const id of [pendingNew, markedNew, saved]) {
      expect(await has('library_uploads', 'id = ?', id), id).toBe(1)
      expect(await object(libraryKey(id)), id).toBe(true)
    }
  })
})

describe('steps (failure 5)', () => {
  it('removes steps rows strictly older than the cutoff and keeps the row exactly at it, per steps store', async () => {
    const now = nextClock()
    const cut = now - DEFAULT_DAYS.steps * DAY
    const at = { old: cut - 1, edge: cut }
    const a = { old: `a_${token()}`, edge: `a_${token()}` }
    for (const k of ['old', 'edge'] as const) await addActivity(db, { id: a[k], actor: seeded.members.dana, subject: null, atMs: at[k] })
    const chat = `c_${token()}`
    await addChat(db, bucket, { id: chat, owner: seeded.members.dana, lastAtMs: now, marker: 'steps' })
    await db.prepare('UPDATE tool_calls SET at_ms = ? WHERE chat_id = ?').bind(at.old, chat).run()
    await db.prepare("INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES (?, 1, ?, ?, 'pre', 'x', 'allow', 1, 'ab', ?)").bind(`t_${chat}`, chat, seeded.members.dana, at.edge).run()
    const aside = { old: `i_${token()}`, edge: `i_${token()}` }
    for (const k of ['old', 'edge'] as const) await db.prepare('INSERT INTO today_aside (item_id, reason, by, at_ms) VALUES (?, ?, ?, ?)').bind(aside[k], 'dismissed', seeded.members.dana, at[k]).run()
    await retain(['activity_lines', 'tool_calls', 'today_aside'], now)
    expect(await has('activity_lines', 'id = ?', a.old)).toBe(0)
    expect(await has('activity_lines', 'id = ?', a.edge)).toBe(1)
    expect(await has('tool_calls', 'chat_id = ? AND n = 0', chat)).toBe(0)
    expect(await has('tool_calls', 'chat_id = ? AND n = 1', chat)).toBe(1)
    expect(await has('today_aside', 'item_id = ?', aside.old)).toBe(0)
    expect(await has('today_aside', 'item_id = ?', aside.edge)).toBe(1)
  })

  it('removes reads before their notices, and skips a routine slot a today item still references', async () => {
    const now = nextClock()
    const cut = now - DEFAULT_DAYS.steps * DAY
    const old = `n_${token()}`
    const edge = `n_${token()}`
    await addNotice(db, { id: old, audience: 'team', atMs: cut - 1 })
    await addNotice(db, { id: edge, audience: 'team', atMs: cut })
    await addRead(db, seeded.members.dana, old, now)
    await addRead(db, seeded.members.leo, edge, now)
    const slot = (key: string, claimedAtMs: number) => db.prepare("INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, tz, due_at_ms, deadline_ms, state, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, claimed_at_ms) VALUES (?, 'routine-morning-check', 'scheduled', '2000-01-01', 'UTC', 0, 0, 'ended', 'c', 'k', 'p', '{}', 1, 'm_system', ?)").bind(key, claimedAtMs).run()
    const free = `s_${token()}`
    const held = `s_${token()}`
    await slot(free, cut - 1)
    await slot(held, cut - 1)
    // A today item from yesterday still points at the old slot.
    await db.prepare("INSERT INTO today_items (id, key, local_date, slot_key, claimed_at_ms, run_id, item_json, created_at_ms) VALUES (?, 'k', '2000-01-01', ?, 0, 'r', '{}', ?)").bind(`ti_${token()}`, held, now).run()
    const { result } = await retain(['notices', 'notice_reads', 'routine_slots', 'today_items'], now)
    expect(await has('notices', 'id = ?', old)).toBe(0)
    expect(await has('notice_reads', 'notice_id = ?', old)).toBe(0)
    expect(await has('notices', 'id = ?', edge)).toBe(1)
    expect(await has('notice_reads', 'notice_id = ?', edge)).toBe(1)
    expect(await has('routine_slots', 'slot_key = ?', free)).toBe(0)
    expect(await has('routine_slots', 'slot_key = ?', held)).toBe(1)
    expect(result.removed).toMatchObject({ notices: 1, notice_reads: 1, routine_slots: 1 })
  })
})

describe('the BrandAgent\'s storage (failure 4)', () => {
  /** Inserts a run (and its turn, events, model call, ledger row and token) into the object's SQLite. */
  function addRun(sql: SqlStorage, r: { run: string; chat: string; state: 'live' | 'ended'; endedAtMs: number | null; turnState: string }) {
    const turn = `t_${r.run}`
    sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms, ended_at_ms) VALUES (?, ?, 'm_x', ?, 0, ?)", r.run, r.chat, r.state, r.endedAtMs)
    sql.exec(`INSERT INTO turns (turn_id, run_id, chat_id, owner_id, ord, client_key, payload_hash, state, priority, text, attachments_json, model, picker_id, side_model, effort, max_turns, answer_position, d1_flushed, created_at_ms)
      VALUES (?, ?, ?, 'm_x', 0, ?, 'h', ?, 'now', 'question', '[]', 'm', 'p', 's', 'e', 1, 'end', 1, 0)`, turn, r.run, r.chat, `k_${r.run}`, r.turnState)
    for (let i = 0; i < 3; i++) sql.exec("INSERT INTO events (run_id, seq, turn_id, at_ms, json) VALUES (?, ?, ?, 0, '{}')", r.run, i, turn)
    sql.exec("INSERT INTO model_calls (turn_id, call_id, n, model, input_tokens, max_tokens, modifiers_json, worst_micro, state, arrived_at_ms) VALUES (?, 'c1', 0, 'm', 1, 1, '{}', 0, 'done', 0)", turn)
    sql.exec("INSERT INTO ledger_queue (turn_id, n, op, state) VALUES (?, 0, 'close', 'answered')", turn)
    sql.exec("INSERT INTO run_tokens (token_hash, turn_id, run_id, chat_id, member_id, session_id, model, side_model, routes_open, issued_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'm_x', 's', 'm', 's', '[]', 0, 0)", `h_${r.run}`, turn, r.run, r.chat)
  }
  const rowsOf = (sql: SqlStorage, run: string) => ({
    runs: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE run_id = ?', run).one().n,
    turns: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM turns WHERE run_id = ?', run).one().n,
    events: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE run_id = ?', run).one().n,
    model_calls: sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM model_calls WHERE turn_id = ?`, `t_${run}`).one().n,
    ledger_queue: sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ledger_queue WHERE turn_id = ?`, `t_${run}`).one().n,
    run_tokens: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM run_tokens WHERE run_id = ?', run).one().n,
  })
  const none = { runs: 0, turns: 0, events: 0, model_calls: 0, ledger_queue: 0, run_tokens: 0 }
  const all = { runs: 1, turns: 1, events: 3, model_calls: 1, ledger_queue: 1, run_tokens: 1 }

  it('removes a BrandAgent ended run\'s events, turns, model calls, ledger rows and tokens strictly before the steps cutoff by ended_at_ms, and keeps the one at it; never removes a live run\'s events or turns', async () => {
    const now = nextClock()
    const cut = now - DEFAULT_DAYS.steps * DAY
    const stub = env.BRAND_AGENT.get(env.BRAND_AGENT.idFromName(`ret-${token()}`))
    await runInDurableObject(stub, async (_obj, state) => {
      // The object's own seeds aren't part of this test: no alarm runs while it works on the storage.
      await state.storage.deleteAlarm()
      const sql = state.storage.sql
      addRun(sql, { run: 'r_old', chat: 'c_a', state: 'ended', endedAtMs: cut - 1, turnState: 'ended' })
      addRun(sql, { run: 'r_edge', chat: 'c_a', state: 'ended', endedAtMs: cut, turnState: 'ended' })
      addRun(sql, { run: 'r_live', chat: 'c_b', state: 'live', endedAtMs: null, turnState: 'live' })
      // An ended run whose turn's hold isn't given back yet: not safe to drop.
      addRun(sql, { run: 'r_hold', chat: 'c_c', state: 'ended', endedAtMs: cut - 1, turnState: 'ended' })
      sql.exec("UPDATE turns SET reserved = 1, settled = 0 WHERE run_id = 'r_hold'")
      const { plan, result } = await retain(['BrandAgent'], now, sql)
      expect(plan.counts.BrandAgent).toBe(Object.values(all).reduce((a, b) => a + b, 0))
      expect(result.removed.BrandAgent).toBe(plan.counts.BrandAgent)
      expect(rowsOf(sql, 'r_old')).toEqual(none)
      expect(rowsOf(sql, 'r_edge')).toEqual(all)
      expect(rowsOf(sql, 'r_live')).toEqual(all)
      expect(rowsOf(sql, 'r_hold')).toEqual(all)
    })
  })

  it('removes a chat past retention with its BrandAgent rows, and skips a chat whose session is still live', async () => {
    const now = nextClock()
    const cut = now - DEFAULT_DAYS.chats * DAY
    const quiet = `c_${token()}`
    const busy = `c_${token()}`
    await addChat(db, bucket, { id: quiet, owner: seeded.members.dana, lastAtMs: cut - 1, marker: 'baq' })
    await addChat(db, bucket, { id: busy, owner: seeded.members.dana, lastAtMs: cut - 1, marker: 'bab' })
    const stub = env.BRAND_AGENT.get(env.BRAND_AGENT.idFromName(`ret-${token()}`))
    await runInDurableObject(stub, async (_obj, state) => {
      await state.storage.deleteAlarm()
      const sql = state.storage.sql
      addRun(sql, { run: 'r_q', chat: quiet, state: 'ended', endedAtMs: now, turnState: 'ended' })
      sql.exec("INSERT INTO chat_state (chat_id, owner_id, last_at_ms) VALUES (?, 'm_x', 0)", quiet)
      addRun(sql, { run: 'r_b', chat: busy, state: 'live', endedAtMs: null, turnState: 'live' })
      sql.exec("INSERT INTO chat_state (chat_id, owner_id, live_run_id, last_at_ms) VALUES (?, 'm_x', 'r_b', 0)", busy)
      await retain(['chats'], now, sql)
      expect(rowsOf(sql, 'r_q')).toEqual(none)
      expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM chat_state WHERE chat_id = ?', quiet).one().n).toBe(0)
      expect(rowsOf(sql, 'r_b')).toEqual(all)
    })
    expect(await has('chats', 'id = ?', quiet)).toBe(0)
    expect(await has('chats', 'id = ?', busy)).toBe(1)
  })
})

describe('the dry run and coverage (failures 6 and 7)', () => {
  it('the dry run writes nothing in D1, R2 or the BrandAgent\'s storage, and its counts equal an independent count', async () => {
    const now = nextClock()
    const cut = now - DEFAULT_DAYS.chats * DAY
    for (let i = 0; i < 3; i++) await addChat(db, bucket, { id: `c_${token()}`, owner: seeded.members.dana, lastAtMs: cut - 1 - i, marker: `dry${i}` })
    const stores = ['chats', 'chat_messages', 'tool_calls', 'chat_files', 'files/', 'sessions/', 'activity_lines', 'notices', 'notice_reads', 'memories', 'library_uploads', 'library_marks', 'library/', 'routine_slots', 'today_items', 'today_aside']
    const registry = stores.map(entry)
    const before = await snapshotAll(db, bucket)
    const plan = await planRetention({ db, bucket, at: { actorId: SYSTEM_MEMBER_ID, requestId: 'r', nowMs: now }, registry }, { periods: periodsFor(registry) })
    expect(await snapshotAll(db, bucket)).toEqual(before)
    // The oracle: a plain filter over the snapshot.
    const pastChats = new Set(before.d1.chats.filter(c => (c.last_at_ms as number) < cut || (c.deleted_at_ms !== null && (c.deleted_at_ms as number) < now - 30 * DAY)).map(c => c.id))
    expect(plan.counts.chats).toBe(pastChats.size)
    expect(plan.counts.chat_messages).toBe(before.d1.chat_messages.filter(m => pastChats.has(m.chat_id)).length)
    expect(plan.counts['files/']).toBe(Object.keys(before.r2).filter(k => [...pastChats].some(c => k.startsWith(`files/${c}/`))).length)
  })

  it('every P3 to P5 registry entry has a retention decision, a deletion rule or a stated keep, and an export decision', () => {
    const gaps: string[] = []
    for (const e of tables) {
      const retention = e.retention !== 'retention_period' || e.derived !== undefined || retentionRules[e.name] !== undefined
      if (!retention) gaps.push(`${e.name}: retention`)
      const del = deletionRules[e.name]
      if (!del) gaps.push(`${e.name}: deletion`)
      else if (del.action === 'keep' && del.why.length === 0) gaps.push(`${e.name}: keep with no reason`)
      if (typeof e.export !== 'boolean') gaps.push(`${e.name}: export`)
    }
    expect(gaps).toEqual([])
  })
})
