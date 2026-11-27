// The routine reader against the door's clear (#467 review), on an in-memory SQLite with every real migration applied. The
// clear (targets/door.ts) soft-deletes every live team routine at each case's seed and reset, stamping its own time, so a
// reader scoped by time alone would see what the clear deleted. Ways it could go wrong, written first:
//  1. a routine left live from before the run is deleted by the case's seed and read as that case's (its update is in the window);
//  2. the previous case's routine, deleted by that case's reset before the route 55 sweep, is read as the next case's
//     (the next case's window starts SINCE_MARGIN_MS before its own start);
//  3. the exclusion hides the agent's own work: a routine the case made, or one the agent deleted through the product.
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDoor, type RunSql } from '../../targets/door.ts'
import { createRowReader } from './rows.ts'

const migrations = fileURLToPath(new URL('../../../server/migrations/', import.meta.url))
const PERSON = 'm_case'

function world() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const f of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(migrations + f, 'utf8'))
  db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Case person', 1)").run(PERSON)
  const run: RunSql = async sql => db.prepare(sql).all() as Record<string, unknown>[]
  /** The door's clear at D1 time `at`. */
  const clearAt = (at: number) => createDoor(run, () => String(at)).clear()
  /** A team routine as createRoutine writes one (a server stamp: `<request id>#<hex>`), made at `at`. */
  const made = (id: string, at: number, text = 'Send the canary') => db.prepare(
    `INSERT INTO routines (id, origin, kind, name, instruction, prompt_ref, days_mask, hour, minute, missed, need, enabled,
      creator_id, checked_until_ms, created_at_ms, updated_at_ms, rev, req_id)
      VALUES (?, 'team', 'agent', 'Routine', ?, NULL, 127, 6, 0, 'skip', 1, 1, ?, ?, ?, ?, 1, 'rq_1#a1b2c3d4e5f6')`,
  ).run(id, text, PERSON, at, at, at)
  /** A delete through the product (store.ts deleteRoutine: route 55, or the agent's routine_delete). */
  const deletedByProduct = (id: string, at: number) =>
    db.prepare("UPDATE routines SET deleted_at_ms = ?, updated_at_ms = ?, rev = rev + 1, req_id = 'rq_2#0a0b0c0d0e0f' WHERE id = ?").run(at, at, id)
  const rows = createRowReader(run, { teamRequestsTable: true })
  return { made, deletedByProduct, clearAt, rows }
}

describe('the routine reader leaves out the door\'s own deletes (#467 review)', () => {
  it('a routine left live from before the run is not the case\'s, though the seed\'s clear deleted it in the window (failure 1)', async () => {
    const w = world()
    w.made('r_left_over', 1_000)
    const since = 10_000
    await w.clearAt(10_500) // the case's seed
    expect(await w.rows.routines(since)).toEqual([])
  })

  it('the previous case\'s routine, deleted by its reset before the sweep, is not the next case\'s (failure 2)', async () => {
    const w = world()
    // Case N: made at 20 000, read as N's, then its reset's clear deletes it at 21 000 (the sweep then finds it not live).
    w.made('r_case_n', 20_000)
    expect((await w.rows.routines(19_000)).map(r => [r.id, r.live])).toEqual([['r_case_n', true]])
    await w.clearAt(21_000)
    // Case N+1 starts at once: its window opens before N's reset (SINCE_MARGIN_MS), and its seed clears again.
    const since = 20_800
    await w.clearAt(21_200)
    expect(await w.rows.routines(since)).toEqual([])
  })

  it('still reads the case\'s own routine, live or deleted through the product (failure 3)', async () => {
    const w = world()
    const since = 30_000
    await w.clearAt(30_100) // the seed
    w.made('r_made', 30_500, 'Post the canary daily')
    w.made('r_made_then_deleted', 30_600)
    w.deletedByProduct('r_made_then_deleted', 30_700)
    const got = await w.rows.routines(since)
    expect(got.map(r => [r.id, r.live]).sort()).toEqual([['r_made', true], ['r_made_then_deleted', false]])
    expect(got.find(r => r.id === 'r_made')?.text).toBe('Routine\nPost the canary daily')
  })
})
