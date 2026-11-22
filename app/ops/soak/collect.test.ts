// The evidence query against the real migrations in node:sqlite (P8a K). Each facet: the day's rows in, the evidence out,
// and the read-only runner refuses anything but a SELECT.
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { runChecks } from './checks.ts'
import { collectDay, dayPending, CANARY_SHAPE, MORNING_ROUTINE_ID } from './collect.ts'
import type { SoakDb } from './collect.ts'
import { hashId } from '../../server/routines/keys.ts'
import { isReadOnly } from './run.ts'
import { dayEndMs, dayStartMs } from './window.ts'
import { BACKSTOP_MS } from '../../server/routines/limits.ts'

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
function slot(o: { routine?: string; state?: string; kind?: string; failure?: string | null; outcome?: string | null; creator?: string; due?: number; ended?: number | null; deadline?: number; reason?: string | null; started?: number | null }) {
  const key = `slot-${++seq}`
  run(
    `INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, tz, due_at_ms, deadline_ms, state, reason, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, outcome, failure, claimed_at_ms, started_at_ms, ended_at_ms)
     VALUES (?, ?, ?, ?, 'UTC', ?, ?, ?, ?, 'c', 'k', 'p', '{}', 1, ?, ?, ?, ?, ?, ?)`,
    key, o.routine ?? MORNING_ROUTINE_ID, o.kind ?? 'scheduled', DAY, o.due ?? T + 6 * HOUR, o.deadline ?? T + 7 * HOUR, o.state ?? 'ended', o.reason ?? null,
    o.creator ?? 'm_system', o.outcome === undefined ? 'done' : o.outcome, o.failure ?? null, T + 6 * HOUR, o.started ?? null, o.ended === undefined ? T + 6 * HOUR + 60_000 : o.ended,
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
  describe('morning notices, per ended slot', () => {
    const items = (key: string, n: number) => { for (let i = 0; i < n; i++) run(`INSERT INTO today_items (id, key, local_date, slot_key, claimed_at_ms, run_id, item_json, created_at_ms) VALUES (?, 'k', ?, ?, 1, 'r', '{}', 1)`, `${key}-${i}`, DAY, key) }
    const mc = async (key: string, n: number, at = T + 7 * HOUR) => notice(await hashId('mc_', `${key}|${n}`), 'morning_check_found', at, null, JSON.stringify({ items: n }))
    it('one notice for a slot that saved items is clean', async () => {
      const key = slot({}); items(key, 2); await mc(key, 2)
      const e = await collectDay(db, DAY, NOW)
      expect(e.bell?.morning).toEqual([{ items: 2, notices: 1 }])
      expect(runChecks(e).bell_notices.status).toBe('clean')
    })
    it('a slot that saved items and has no notice is lost', async () => {
      const key = slot({}); items(key, 2)
      expect(runChecks(await collectDay(db, DAY, NOW)).bell_notices).toMatchObject({ status: 'unclean', detail: '1 lost, 0 doubled' })
    })
    it('two notices for one slot (a re-run with another count) are doubled', async () => {
      const key = slot({}); items(key, 2); await mc(key, 2); await mc(key, 3)
      expect(runChecks(await collectDay(db, DAY, NOW)).bell_notices).toMatchObject({ status: 'unclean', detail: '0 lost, 1 doubled' })
    })
    it('a notice that belongs to no ended slot is doubled; two slots with one notice each are clean', async () => {
      const a = slot({}), b = slot({ due: T + 8 * HOUR }); items(a, 1); items(b, 1); await mc(a, 1); await mc(b, 1)
      expect(runChecks(await collectDay(db, DAY, NOW)).bell_notices.status).toBe('clean')
      notice('mc_stray', 'morning_check_found', T + 9 * HOUR, null, '{"items":4}')
      expect(runChecks(await collectDay(db, DAY, NOW)).bell_notices).toMatchObject({ status: 'unclean', detail: '0 lost, 1 doubled' })
    })
    it('a slot with no items needs no notice', async () => {
      slot({})
      expect(runChecks(await collectDay(db, DAY, NOW)).bell_notices.status).toBe('clean')
    })
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
  it('boundary: a setting change in the same millisecond as the save applies (<=), one a millisecond later does not (<)', async () => {
    learn('m_a', false, T + 2 * HOUR); save('f1', 'm_a', T + 2 * HOUR)
    expect((await collectDay(db, DAY, NOW)).memory?.learnOffSaves).toBe(1)
  })
  it('boundary: a setting change a millisecond after the save does not apply', async () => {
    learn('m_a', false, T + 2 * HOUR + 1); save('f1', 'm_a', T + 2 * HOUR)
    expect((await collectDay(db, DAY, NOW)).memory?.learnOffSaves).toBe(0)
  })
  it('stays pending until P6a, even on an otherwise clean day', async () => {
    expect(runChecks(await collectDay(db, DAY, NOW)).memory.status).toBe('pending')
  })
})

describe('failed runs', () => {
  const okAfter = (due: number) => slot({ due, deadline: due + HOUR, ended: due + 60_000 })
  it('a failed end followed by an ok slot of the same routine is recovered', async () => {
    slot({ failure: 'run_failed', outcome: 'failed', due: T + 6 * HOUR }); okAfter(T + 8 * HOUR)
    const e = await collectDay(db, DAY, NOW)
    expect(e.runs).toMatchObject({ slots: 2, failed: 1, unrecovered: 0, stuck: 0 })
    expect(runChecks(e).failed_runs.status).toBe('clean')
  })
  it('each product failure shape counts: lost, refused internal, a system routine missed; not_connected does not', async () => {
    slot({ state: 'lost', reason: 'x', ended: null, outcome: null })
    slot({ state: 'refused', reason: 'internal', ended: null, outcome: null })
    slot({ state: 'missed', reason: 'late', ended: null, outcome: null })
    slot({ failure: 'not_connected' })
    const e = await collectDay(db, DAY, NOW)
    expect(e.runs).toMatchObject({ failed: 3, unrecovered: 3 })
  })
  it('a failure with no ok slot after it is unrecovered; an ok slot before it does not count; another routine does not count', async () => {
    okAfter(T + 5 * HOUR)
    slot({ failure: 'run_failed', outcome: 'failed', due: T + 6 * HOUR })
    expect((await collectDay(db, DAY, NOW)).runs?.unrecovered).toBe(1)
    run(`INSERT INTO routines (id, origin, name, instruction, days_mask, hour, minute, missed, need, creator_id, checked_until_ms, created_at_ms, updated_at_ms, kind) VALUES ('other', 'team', 'n', 'i', 127, 1, 1, 'skip', 0, 'm', 1, 1, 1, 'agent')`)
    slot({ routine: 'other', due: T + 9 * HOUR })
    expect((await collectDay(db, DAY, NOW)).runs?.unrecovered).toBe(1)
  })
  it('a failed slot followed only by another failed slot is not recovered, whichever way the later one failed', async () => {
    slot({ failure: 'run_failed', outcome: 'failed', due: T + 6 * HOUR })
    slot({ failure: 'run_failed', outcome: 'failed', due: T + 8 * HOUR, deadline: T + 9 * HOUR, ended: T + 8 * HOUR + 60_000 })
    const e = await collectDay(db, DAY, NOW)
    expect(e.runs).toMatchObject({ slots: 2, failed: 2, unrecovered: 2 })
    expect(runChecks(e).failed_runs.status).toBe('unclean')
    sqlite.exec('DELETE FROM routine_slots')
    // a later end that says done but carries a failure, and one with no failure that did not end done
    slot({ failure: 'run_failed', outcome: 'failed', due: T + 6 * HOUR })
    slot({ failure: 'invalid_result', outcome: 'done', due: T + 8 * HOUR, deadline: T + 9 * HOUR, ended: T + 8 * HOUR + 60_000 })
    slot({ failure: null, outcome: 'failed', due: T + 9 * HOUR, deadline: T + 10 * HOUR, ended: T + 9 * HOUR + 60_000 })
    expect((await collectDay(db, DAY, NOW)).runs).toMatchObject({ slots: 3, failed: 2, unrecovered: 2 })
  })
  it('an ok slot that had not ended by the cut-off does not recover it', async () => {
    slot({ failure: 'run_failed', outcome: 'failed', due: T + 6 * HOUR })
    slot({ due: T + 8 * HOUR, ended: NOW + 1 })
    expect((await collectDay(db, DAY, NOW)).runs?.unrecovered).toBe(1)
  })
  it('claimed past its deadline is stuck; at the deadline it is not (< not <=)', async () => {
    slot({ state: 'claimed', ended: null, outcome: null, deadline: NOW - 1 })
    expect((await collectDay(db, DAY, NOW)).runs?.stuck).toBe(1)
    sqlite.exec('DELETE FROM routine_slots')
    slot({ state: 'claimed', ended: null, outcome: null, deadline: NOW })
    expect((await collectDay(db, DAY, NOW)).runs?.stuck).toBe(0)
  })
  it('a started slot waiting on a question is not stuck until the 8-day backstop', async () => {
    slot({ state: 'started', ended: null, outcome: null, started: NOW - BACKSTOP_MS + 1, deadline: T + HOUR })
    expect((await collectDay(db, DAY, NOW)).runs?.stuck).toBe(0)
    sqlite.exec('DELETE FROM routine_slots')
    slot({ state: 'started', ended: null, outcome: null, started: NOW - BACKSTOP_MS - 1, deadline: T + HOUR })
    expect((await collectDay(db, DAY, NOW)).runs?.stuck).toBe(1)
  })
  it('boundary: a started slot exactly at the backstop is not stuck (< not <=), as the tick loses it only past it', async () => {
    slot({ state: 'started', ended: null, outcome: null, started: NOW - BACKSTOP_MS, deadline: T + HOUR })
    expect((await collectDay(db, DAY, NOW)).runs?.stuck).toBe(0)
  })
  it('no routine slot at all on the day is missing, not clean', async () => {
    const e = await collectDay(db, DAY, NOW)
    expect(e.runs?.slots).toBe(0)
    expect(runChecks(e).failed_runs.status).toBe('missing')
  })
})

describe('days still in flight (dayPending)', () => {
  const EOD = dayEndMs(DAY)
  it('a slot due in the day still claimed or started inside its window defers the day', async () => {
    slot({ state: 'claimed', ended: null, outcome: null, deadline: EOD + HOUR })
    expect(await dayPending(db, DAY, EOD + 1)).toMatch(/window/)
    sqlite.exec('DELETE FROM routine_slots')
    slot({ state: 'started', ended: null, outcome: null, deadline: EOD + HOUR })
    expect(await dayPending(db, DAY, EOD + 1)).toMatch(/window/)
    expect(await dayPending(db, DAY, EOD + 2 * HOUR + 10 * HOUR)).toBeNull()
  })
  it('the open-slot branch alone: a skip routine\'s slot whose deadline runs past the day\'s end defers the day with no catch-up window open', async () => {
    sqlite.exec('UPDATE routines SET enabled = 0')
    run(`INSERT INTO routines (id, origin, name, instruction, days_mask, hour, minute, missed, need, creator_id, checked_until_ms, created_at_ms, updated_at_ms, kind) VALUES ('late', 'team', 'n', 'i', 127, 23, 55, 'skip', 0, 'm', 1, 1, 1, 'agent')`)
    const MIN = 60_000
    for (const state of ['claimed', 'started']) {
      sqlite.exec('DELETE FROM routine_slots')
      slot({ routine: 'late', state, ended: null, outcome: null, due: EOD - 5 * MIN, deadline: EOD + 5 * MIN })
      expect(await dayPending(db, DAY, EOD + MIN)).toBe('a slot due this day is still inside its window')
      expect(await dayPending(db, DAY, EOD + 5 * MIN)).toBeNull()
    }
  })
  it('boundary: a slot whose deadline equals now is no longer inside its window', async () => {
    sqlite.exec('UPDATE routines SET enabled = 0')
    slot({ state: 'claimed', ended: null, outcome: null, deadline: EOD + HOUR })
    expect(await dayPending(db, DAY, EOD + HOUR)).toBeNull()
  })
  it('an open catch-up window defers the day: the longest catch_up_within_min of an enabled catch-up routine after the day ends', async () => {
    // the seeded morning routine catches up within 360 minutes
    expect(await dayPending(db, DAY, EOD + 359 * 60_000)).toMatch(/catch-up/)
    expect(await dayPending(db, DAY, EOD + 360 * 60_000)).toBeNull()
  })
  it('a disabled routine does not hold a day', async () => {
    sqlite.exec('UPDATE routines SET enabled = 0')
    expect(await dayPending(db, DAY, EOD + 1)).toBeNull()
  })
})

describe('guards', () => {
  let calls = 0
  const fetchCall = (decision: string, toolUseId: string | null = 'toolu_a', turn = 't') =>
    run(`INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, tool_use_id, decision, input_bytes, input_sha256, at_ms) VALUES (?, ?, 'c', 'm', 'pre', 'WebFetch', ?, ?, 1, 'x', ?)`, turn, ++calls, toolUseId, decision, T + HOUR)
  const planted = { canaries: ['PLANTED-1'] }
  it('a WebFetch the hook refused leaves its deny row and the audit hook\'s allow row (runner hook-audit.test.ts): not an allowed fetch', async () => {
    fetchCall('deny'); fetchCall('allow')
    expect((await collectDay(db, DAY, NOW)).guards).toMatchObject({ webfetchAllowed: 0, leaks: 0 })
    fetchCall('allow', 'toolu_b')
    expect((await collectDay(db, DAY, NOW)).guards?.webfetchAllowed).toBe(1)
  })
  it('an allow row that can\'t be paired with a deny counts as allowed: no tool_use id, or a deny in another turn', async () => {
    fetchCall('deny', null); fetchCall('allow', null)
    expect((await collectDay(db, DAY, NOW)).guards?.webfetchAllowed).toBe(1)
    sqlite.exec('DELETE FROM tool_calls')
    fetchCall('deny', 'toolu_a', 'other-turn'); fetchCall('allow', 'toolu_a')
    expect((await collectDay(db, DAY, NOW)).guards?.webfetchAllowed).toBe(1)
  })
  it('an allowed WebFetch makes the guards check missing, under an empty list and under a list: no host is recorded', async () => {
    fetchCall('allow')
    expect(runChecks(await collectDay(db, DAY, NOW, planted)).guards).toMatchObject({ status: 'missing', detail: expect.stringContaining('record the fetched host') })
    run(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 't:webfetch', ?, 1, 1, 'm_a', 'r')`, JSON.stringify('example.com'))
    expect(runChecks(await collectDay(db, DAY, NOW, planted)).guards.status).toBe('missing')
  })
  it('with planted canaries and no allowed WebFetch the guards check is clean; a refused WebFetch keeps it clean; without --canary it is missing', async () => {
    expect(runChecks(await collectDay(db, DAY, NOW, planted)).guards.status).toBe('clean')
    fetchCall('deny'); fetchCall('allow')
    expect(runChecks(await collectDay(db, DAY, NOW, planted)).guards.status).toBe('clean')
    expect(runChecks(await collectDay(db, DAY, NOW)).guards).toMatchObject({ status: 'missing', detail: expect.stringContaining('--canary') })
  })
  it('without --canary, a canary-shaped string in a notice body or fields is a leak (shape mode)', async () => {
    notice('n1', 'morning_check_found', T + HOUR, null, '{"note":"kestrel-x03-r2-0a1b2c3d"}')
    notice('n2', 'routine_failed', T + HOUR, 'see kestrel-x09-r1-deadbeef')
    notice('n3', 'routine_failed', T + HOUR, 'nothing here')
    expect((await collectDay(db, DAY, NOW)).guards).toMatchObject({ leaks: 2, canary: 'shape' })
    expect(CANARY_SHAPE.test('kestrel-x03-r2-0a1b2c3d')).toBe(true)
  })
  it('with planted canaries, only those exact strings count, in notices and activity lines', async () => {
    notice('n1', 'routine_failed', T + HOUR, 'text with PLANTED-1 inside')
    notice('n2', 'routine_failed', T + HOUR, 'kestrel-x03-r2-0a1b2c3d is shape only')
    run(`INSERT INTO activity_lines (id, at_ms, kind, template, fields_json, source, source_key) VALUES ('a1', ?, 'read', 't', ?, 's', 'k')`, T + HOUR, '{"x":"PLANTED-2"}')
    expect((await collectDay(db, DAY, NOW, { canaries: ['PLANTED-1', 'PLANTED-2'] })).guards).toEqual({ webfetchAllowed: 0, leaks: 2, canary: 'planted' })
  })
  it('an empty or blank planted canary is refused (it would match everything)', async () => {
    await expect(collectDay(db, DAY, NOW, { canaries: [''] })).rejects.toThrow(/canary/)
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
