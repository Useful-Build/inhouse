// The door's clear between case-repeats, on an in-memory SQLite with every real migration applied (server/migrations/)
// and foreign keys on, as D1 enforces them. Read back with the product's own filters (server/routines/store.ts: listRoutines
// and route 52 show `deleted_at_ms IS NULL`, the team cap counts `origin = 'team'` among those, the tick reads `enabled = 1`
// among those); store.ts itself isn't imported, as its D1 types are the worker build's.
// Ways it could go wrong, written first:
//  1. a team routine an earlier repeat or run made is still live for the next one (Stage 1 M2-G: T11 failed 3/3 that way),
//     so routine_list shows it, the tick runs it or the team cap counts it;
//  2. the clear deletes the system routine (the morning check) or touches a routine already deleted;
//  3. a hard delete trips a foreign key (a routine's slots, Today's items) and the clear fails mid-way;
//  4. a clear that didn't take reads as success.
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDoor, DoorRefusal, type RunSql } from './door.ts'

const migrations = fileURLToPath(new URL('../../server/migrations/', import.meta.url))
const CASE_PERSON = 'm_case'

function database() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const f of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(migrations + f, 'utf8'))
  db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Case person', 1)").run(CASE_PERSON)
  const run: RunSql = async sql => db.prepare(sql).all() as Record<string, unknown>[]
  return { db, run }
}

/** The routines a list shows (listRoutines, route 52's live ones), newest first. */
const listed = (db: DatabaseSync) => (db.prepare('SELECT id FROM routines WHERE deleted_at_ms IS NULL ORDER BY created_at_ms DESC, id DESC').all() as { id: string }[]).map(r => r.id)

/** A team routine as createRoutine writes one (store.ts), with one ended slot when `slot` is set. */
function teamRoutine(db: DatabaseSync, id: string, o: { deletedAt?: number; slot?: boolean } = {}) {
  db.prepare(
    `INSERT INTO routines (id, origin, kind, name, instruction, prompt_ref, days_mask, hour, minute, missed, need, enabled, deleted_at_ms,
      creator_id, source_chat_id, checked_until_ms, created_at_ms, updated_at_ms, rev, req_id)
      VALUES (?, 'team', 'agent', 'Low stock check', 'Check stock and tell me which items are low.', NULL, 31, 6, 0, 'skip', 1, 1, ?, ?, NULL, 1, 1, 1, 1, 'r')`,
  ).run(id, o.deletedAt ?? null, CASE_PERSON)
  if (o.slot) {
    db.prepare(
      `INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, local_time, tz, due_at_ms, deadline_ms, state, chat_id, client_key,
        prompt_text, submit_json, routine_rev, creator_id, claimed_at_ms) VALUES (?, ?, 'scheduled', '2026-11-26', '06:00', 'UTC', 1, 2, 'ended', 'c', 'k', 'p', '{}', 1, ?, 1)`,
    ).run(`${id}|2026-11-26|06:00`, id, CASE_PERSON)
  }
}

const row = (db: DatabaseSync, id: string) => db.prepare('SELECT deleted_at_ms, rev, req_id FROM routines WHERE id = ?').get(id) as { deleted_at_ms: number | null; rev: number; req_id: string | null }

describe('the door clears team routines between case-repeats (Stage 1 M2-G, T11)', () => {
  it('deletes every live team routine the product\'s way; the morning check and an already deleted one are untouched (failures 1, 2, 3)', async () => {
    const { db, run } = database()
    teamRoutine(db, 'r_left_by_earlier_run', { slot: true })
    teamRoutine(db, 'r_made_this_repeat')
    teamRoutine(db, 'r_deleted_before', { deletedAt: 7 })
    const system = row(db, 'routine-morning-check')
    expect(system.deleted_at_ms, 'the morning check is a live system routine (migration 0221)').toBeNull()
    expect(listed(db).sort()).toEqual(['r_left_by_earlier_run', 'r_made_this_repeat', 'routine-morning-check'])

    await createDoor(run, () => '5000').clear()

    // What routine_list and route 52 show: the system routine only.
    expect(listed(db)).toEqual(['routine-morning-check'])
    // No live team routine is left for the cap (store.ts LIVE_TEAM_COUNT) or the tick (the routines_due index's rows).
    expect(db.prepare("SELECT COUNT(*) AS n FROM routines WHERE origin = 'team' AND deleted_at_ms IS NULL").get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM routines WHERE enabled = 1 AND deleted_at_ms IS NULL').get()).toEqual({ n: 1 })
    for (const id of ['r_left_by_earlier_run', 'r_made_this_repeat']) expect(row(db, id)).toEqual({ deleted_at_ms: 5000, rev: 2, req_id: 'eval' })
    expect(row(db, 'r_deleted_before'), 'an already deleted routine keeps its own delete').toEqual({ deleted_at_ms: 7, rev: 1, req_id: 'r' })
    expect(row(db, 'routine-morning-check')).toEqual(system)
    // The slot's row stays (a soft delete), so no foreign key is tripped.
    expect(db.prepare('SELECT COUNT(*) AS n FROM routine_slots').get()).toEqual({ n: 1 })

    // A second clear (the next repeat) changes nothing more.
    await createDoor(run, () => '9000').clear()
    expect(row(db, 'r_made_this_repeat')).toEqual({ deleted_at_ms: 5000, rev: 2, req_id: 'eval' })
  })

  it('also empties memory and team requests, as before', async () => {
    const { db, run } = database()
    db.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES ('mem_AAAAAAAAAAAAAAAAAAAAAA', 'brand', NULL, 'A fact.', 'active', 'eval', 1, 1)").run()
    db.prepare("INSERT INTO team_requests (id, kind, subject, text, requested_by, status, created_at_ms, updated_at_ms) VALUES ('tr_1', 'tool', 'TikTok', 'Connect TikTok Shop.', ?, 'open', 1, 1)").run(CASE_PERSON)
    await createDoor(run).clear()
    expect(db.prepare('SELECT (SELECT COUNT(*) FROM memories) AS m, (SELECT COUNT(*) FROM team_requests) AS t').get()).toEqual({ m: 0, t: 0 })
  })

  it('a team routine still live after the clear is a loud failure, before memory is touched (failure 4)', async () => {
    const sqls: string[] = []
    // The update is lost: the read-back still finds one live team routine.
    const run: RunSql = async sql => { sqls.push(sql); return sql.startsWith('SELECT id FROM routines') ? [{ id: 'r_stuck' }] : [] }
    await expect(createDoor(run).clear()).rejects.toThrow(DoorRefusal)
    expect(sqls.some(s => s.includes('memories') || s.includes('team_requests'))).toBe(false)
  })
})
