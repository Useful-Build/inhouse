// The evidence query against the real migrations in node:sqlite (P8a K). Each facet: the day's rows in, the evidence out,
// and the read-only runner refuses anything but a SELECT.
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { runChecks } from './checks.ts'
import { collectDay, CANARY_SHAPE, MORNING_ROUTINE_ID } from './collect.ts'
import type { SoakDb } from './collect.ts'
import { hashId } from '../../server/routines/keys.ts'
import { isReadOnly } from './run.ts'
import { dayStartMs } from './window.ts'

const DAY = '2026-12-02'
const T = dayStartMs(DAY)
const HOUR = 3_600_000
const NOW = T + 30 * HOUR

const migrations = fileURLToPath(new URL('../../server/migrations/', import.meta.url))
let sqlite: DatabaseSync
const db: SoakDb = async (sql, params = []) => {
  if (!isReadOnly(sql)) throw new Error(`not read-only: ${sql}`)
  return sqlite.prepare(sql).all(...params) as Record<string, unknown>[]
}
const run = (sql: string, ...p: (string | number | null)[]) => sqlite.prepare(sql).run(...p)

let seq = 0
function slot(o: { routine?: string; state?: string; kind?: string; failure?: string | null; outcome?: string | null; creator?: string; due?: number; ended?: number | null; deadline?: number; reason?: string | null }) {
  const key = `slot-${++seq}`
  run(
    `INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, tz, due_at_ms, deadline_ms, state, reason, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, outcome, failure, claimed_at_ms, ended_at_ms)
     VALUES (?, ?, ?, ?, 'UTC', ?, ?, ?, ?, 'c', 'k', 'p', '{}', 1, ?, ?, ?, ?, ?)`,
    key, o.routine ?? MORNING_ROUTINE_ID, o.kind ?? 'scheduled', DAY, o.due ?? T + 6 * HOUR, o.deadline ?? T + 7 * HOUR, o.state ?? 'ended', o.reason ?? null,
    o.creator ?? 'm_system', o.outcome === undefined ? 'done' : o.outcome, o.failure ?? null, T + 6 * HOUR, o.ended === undefined ? T + 6 * HOUR + 60_000 : o.ended,
  )
  return key
}
function notice(id: string, template: string, at: number, body: string | null = null, fields = '{}') {
  run(`INSERT INTO notices (id, audience, template, fields_json, body, icon, at_ms, link_json, source) VALUES (?, 'admins', ?, ?, ?, 'x', ?, '{}', 's')`, id, template, fields, body, at)
}
// Foreign keys are off in this database, so the rows name members without inserting them.
const member = (_id: string) => {}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = OFF')
  for (const f of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(migrations + f, 'utf8'))
})

describe('read-only', () => {
  it('only a single SELECT passes', () => {
    expect(isReadOnly('SELECT 1')).toBe(true)
    for (const bad of ['DELETE FROM notices', 'SELECT 1; DROP TABLE notices', 'UPDATE routines SET rev = 1', 'PRAGMA writable_schema = 1']) expect(isReadOnly(bad)).toBe(false)
  })
})

describe('the morning check and connector reads', () => {
  it('a day with an ended, ok slot and a connector read is clean on both', async () => {
    slot({})
    run(`INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES ('t', 1, 'c', 'm', 'pre', 'mcp__apps__shopify_orders', 'allow', 1, 'x', ?)`, T + 6 * HOUR)
    const c = runChecks(await collectDay(db, DAY, NOW))
    expect(c.morning_check.status).toBe('clean')
    expect(c.connector_reads.status).toBe('clean')
  })
  it('no slot is missing; a failed or not-connected end is unclean', async () => {
    expect(runChecks(await collectDay(db, DAY, NOW)).morning_check.status).toBe('missing')
    slot({ failure: 'not_connected', outcome: 'done' })
    const c = runChecks(await collectDay(db, DAY, NOW))
    expect(c.morning_check.status).toBe('unclean')
    expect(c.connector_reads.status).toBe('unclean')
  })
  it('a slot due on another UTC day is not this day\'s', async () => {
    slot({ due: T - HOUR })
    expect(runChecks(await collectDay(db, DAY, NOW)).morning_check.status).toBe('missing')
  })
})

describe('bell notices', () => {
  it('a failed end with its admin and creator notices, once each, is clean', async () => {
    member('m_a')
    const key = slot({ failure: 'run_failed', outcome: 'failed', creator: 'm_a' })
    notice(await hashId('rf_', `${key}|admins`), 'routine_failed', T + 7 * HOUR)
    notice(await hashId('rf_', `${key}|m_a`), 'routine_failed', T + 7 * HOUR)
    expect(runChecks(await collectDay(db, DAY, NOW)).bell_notices).toMatchObject({ status: 'clean' })
  })
  it('a missing creator notice is lost; an extra one is doubled', async () => {
    member('m_a')
    const key = slot({ failure: 'run_failed', outcome: 'failed', creator: 'm_a' })
    notice(await hashId('rf_', `${key}|admins`), 'routine_failed', T + 7 * HOUR)
    expect(runChecks(await collectDay(db, DAY, NOW)).bell_notices).toMatchObject({ status: 'unclean', detail: '1 lost, 0 doubled' })
    notice(await hashId('rf_', `${key}|m_a`), 'routine_failed', T + 7 * HOUR)
    notice('rf_stray', 'routine_failed', T + 8 * HOUR)
    expect(runChecks(await collectDay(db, DAY, NOW)).bell_notices).toMatchObject({ status: 'unclean', detail: '0 lost, 1 doubled' })
  })
  it('a not_connected end writes no notice and expects none', async () => {
    slot({ failure: 'not_connected' })
    expect(runChecks(await collectDay(db, DAY, NOW)).bell_notices.status).toBe('clean')
  })
})

describe('memory', () => {
  const save = (id: string, owner: string, at: number, chat: string | null = 'c1') =>
    run(`INSERT INTO memories (id, scope, owner_id, text, status, source_chat_id, created_by, created_at_ms, updated_at_ms) VALUES (?, 'person', ?, 'a fact', 'active', ?, ?, ?, ?)`, id, owner, chat, owner, at, at)
  const learn = (actor: string, value: boolean | null, at: number) =>
    run(`INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id) VALUES (?, ?, 'setting.changed', 'setting', 'm:learn', ?, 'r')`, at, actor, JSON.stringify({ action: 'setting.changed', scope: 'personal', key: 'm:learn', value }))
  beforeEach(() => { member('m_a'); member('m_b') })

  it('a save while the owner\'s setting was off is unclean; while on, or before it was turned off, it isn\'t', async () => {
    learn('m_a', false, T + HOUR)
    save('f1', 'm_a', T + 2 * HOUR)
    expect((await collectDay(db, DAY, NOW)).memory?.learnOffSaves).toBe(1)
    learn('m_a', true, T + 3 * HOUR)
    save('f2', 'm_a', T + 4 * HOUR)
    save('f3', 'm_b', T + 2 * HOUR)
    expect((await collectDay(db, DAY, NOW)).memory?.learnOffSaves).toBe(1)
  })
  it('an unset or reset setting is not a proven off, and a save made by hand (no chat) doesn\'t count', async () => {
    learn('m_a', false, T - 5 * HOUR); learn('m_a', null, T - 4 * HOUR)
    save('f1', 'm_a', T + HOUR)
    learn('m_b', false, T - HOUR); save('f2', 'm_b', T + HOUR, null)
    expect((await collectDay(db, DAY, NOW)).memory?.learnOffSaves).toBe(0)
  })
  it('stays pending until P6a, even on an otherwise clean day', async () => {
    expect(runChecks(await collectDay(db, DAY, NOW)).memory.status).toBe('pending')
  })
})

describe('failed runs', () => {
  it('a slot open past its deadline is stuck; one inside its deadline, or already closed, is not', async () => {
    slot({ state: 'started', ended: null, outcome: null, deadline: T + 7 * HOUR })
    expect((await collectDay(db, DAY, NOW)).runs?.stuck).toBe(1)
    expect((await collectDay(db, DAY, T + 6 * HOUR + 1)).runs?.stuck).toBe(0)
    sqlite.exec("UPDATE routine_slots SET state = 'lost'")
    expect((await collectDay(db, DAY, NOW)).runs?.stuck).toBe(0)
  })
})

describe('guards', () => {
  const fetchCall = (decision: string) =>
    run(`INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES ('t', 1, 'c', 'm', 'pre', 'WebFetch', ?, 1, 'x', ?)`, decision, T + HOUR)
  it('an allowed WebFetch with an empty host list is a bypass; a denied one is the guard working', async () => {
    fetchCall('deny')
    expect((await collectDay(db, DAY, NOW)).guards).toEqual({ webfetchBypass: 0, leaks: 0 })
    sqlite.exec('DELETE FROM tool_calls'); fetchCall('allow')
    expect((await collectDay(db, DAY, NOW)).guards).toEqual({ webfetchBypass: 1, leaks: 0 })
  })
  it('a canary-shaped string in a notice body or fields is a leak', async () => {
    notice('n1', 'morning_check_found', T + HOUR, null, '{"note":"kestrel-x03-r2-0a1b2c3d"}')
    notice('n2', 'routine_failed', T + HOUR, 'see kestrel-x09-r1-deadbeef')
    notice('n3', 'routine_failed', T + HOUR, 'nothing here')
    expect((await collectDay(db, DAY, NOW)).guards?.leaks).toBe(2)
    expect(CANARY_SHAPE.test('kestrel-x03-r2-0a1b2c3d')).toBe(true)
  })
  it('with a host list set the facet is missing (a bypass can\'t be told from a listed fetch)', async () => {
    run(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 't:webfetch', ?, 1, 1, 'm_a', 'r')`, JSON.stringify('example.com'))
    expect((await collectDay(db, DAY, NOW)).guards).toBeNull()
  })
})

describe('an unreadable facet', () => {
  it('is null, so missing, and the other facets still read', async () => {
    sqlite.exec('DROP TABLE notices')
    const e = await collectDay(db, DAY, NOW)
    expect(e.bell).toBeNull()
    expect(e.runs).not.toBeNull()
  })
})
