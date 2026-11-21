// 0130_usage on top of 0001-0005 and 0100 (every migration applied, server/testing/apply-migrations.ts). Ways it can fail:
//  1. a table or a design column is missing;
//  2. the month's reserved can go below zero, a turn names a month that has no row, a source other than 'tally', a
//     second extend row for one (turn, call), a second audit-copy state row.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const db = env.DB
const fails = async (sql: string, ...args: unknown[]) => {
  let error: unknown = null
  try { await db.prepare(sql).bind(...args).run() } catch (err) { error = err }
  return error !== null
}
const cols = async (t: string) => (await db.prepare(`SELECT name FROM pragma_table_info('${t}') ORDER BY cid`).all<{ name: string }>()).results.map(r => r.name)

describe('0130_usage', () => {
  it('creates the four tables with the design columns (failure 1)', async () => {
    expect(await cols('usage_months')).toEqual(['month', 'cap_micro', 'reserved_micro', 'spent_micro', 'last_reserve_micro', 'alert_crossed_at_ms', 'stamp'])
    expect(await cols('usage_turns')).toEqual(['turn_id', 'run_id', 'chat_id', 'member_id', 'model', 'month', 'reserved_micro', 'settled_micro', 'final', 'source', 'runner_cost_micro', 'created_at_ms', 'settled_at_ms', 'stamp'])
    expect(await cols('usage_extends')).toEqual(['turn_id', 'call_id', 'need_micro', 'actual_micro', 'closed', 'at_ms'])
    expect(await cols('audit_copy_state')).toEqual(['id', 'last_id', 'pending_from', 'pending_to', 'at_ms'])
  })

  it('refuses negative holds, orphan turns, other sources, repeated extends and a second state row (failure 2)', async () => {
    await db.prepare("INSERT INTO usage_months (month, cap_micro) VALUES ('2026-01', 1000000)").run()
    expect(await fails("UPDATE usage_months SET reserved_micro = -1 WHERE month = '2026-01'")).toBe(true)
    const turn = "INSERT INTO usage_turns (turn_id, run_id, chat_id, member_id, model, month, reserved_micro, created_at_ms, source) VALUES (?, 'r', 'c', 'm', 'claude-sonnet-5-5', ?, 250000, 1, ?)"
    expect(await fails(turn, 't_orphan', '2099-01', null)).toBe(true)
    expect(await fails(turn, 't_src', '2026-01', 'runner')).toBe(true)
    expect(await fails(turn, 't_ok', '2026-01', 'tally')).toBe(false)
    const ext = "INSERT INTO usage_extends (turn_id, call_id, need_micro, at_ms) VALUES ('t_ok', 'c1', 50000, 1)"
    expect(await fails(ext)).toBe(false)
    expect(await fails(ext)).toBe(true)
    expect(await fails('INSERT INTO audit_copy_state (id, last_id, at_ms) VALUES (1, 0, 1)')).toBe(false)
    expect(await fails('INSERT INTO audit_copy_state (id, last_id, at_ms) VALUES (2, 0, 1)')).toBe(true)
  })
})
