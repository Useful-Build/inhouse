// Usage (p3-design section 9, route 42): from D1 only, aggregate rows by member, no chat data (BD7), money as USD cents
// rounded half up from micro-USD, finished months with the cap their ledger recorded. Past months are seeded into D1 (the
// ledger is written by the egress, which needs a container), so the spec runs on the local test build and skips on a
// deployed one. Oracles: the design's arithmetic below, worked out by hand.
//   2025-01: cap $100, spent 12,345,678 micro = turns 7,000,000 (Dana, Sonnet) + 5,345,678 (Leo, Haiku)
//            cents: 700, 534.5678 -> 535, total 1234.5678 -> 1235
//   2025-02: cap $10, spent 10,000,000: at the cap, so capReached and alertCrossed
//   2025-03: cap $100, spent 8,000,000 = a question 5,000,000 (Dana, Sonnet) + a routine's run 3,000,000 (a chat `m_system`
//            owns, Sonnet): the run is a job (Jobs run 1, one Job row "E2E usage routine"), not a question or a person's row
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, allPages, call, expectError, me } from './kit.ts'
import { writeSql } from './db.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')
const smoke = actor('smoke')
test.describe.configure({ mode: 'serial' })

const CHATS = ['e2e-usage-chat-1', 'e2e-usage-chat-2']
const TURNS = ['t_e2eUsageTurn0000000001', 't_e2eUsageTurn0000000002', 't_e2eUsageTurn0000000003', 't_e2eUsageTurn0000000004', 't_e2eUsageTurn0000000005']
const ROUTINE = { id: 'rt_e2eUsageRoutine000001', slotKey: 'rt_e2eUsageRoutine000001|2025-03-10|06:00|e2e', chat: 'rc_e2eUsageRoutineChat1' }
const at = Date.UTC(2025, 0, 10, 12)

test.beforeAll(async ({ request }) => {
  const [d, l] = await Promise.all([me(request, dana), me(request, leo)])
  clean()
  writeSql('INSERT INTO usage_months (month, cap_micro, spent_micro) VALUES (?, ?, ?)', '2025-01', 100_000_000, 12_345_678)
  writeSql('INSERT INTO usage_months (month, cap_micro, spent_micro) VALUES (?, ?, ?)', '2025-02', 10_000_000, 10_000_000)
  const turn = (id: string, chat: string, member: string, model: string, month: string, micro: number) =>
    writeSql('INSERT INTO usage_turns (turn_id, run_id, chat_id, member_id, model, month, reserved_micro, settled_micro, final, source, created_at_ms, settled_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, \'tally\', ?, ?)', id, `r_${id}`, chat, member, model, month, micro, micro, at, at)
  turn(TURNS[0]!, CHATS[0]!, d.memberId, 'claude-sonnet-5-5', '2025-01', 7_000_000)
  turn(TURNS[1]!, CHATS[1]!, l.memberId, 'claude-haiku-5-5', '2025-01', 5_345_678)
  turn(TURNS[2]!, CHATS[0]!, d.memberId, 'claude-sonnet-5-5', '2025-02', 10_000_000)
  // March: a question, and a routine's run. The routine is soft-deleted and its slot ended, so no other spec or the tick sees it.
  writeSql('INSERT INTO usage_months (month, cap_micro, spent_micro) VALUES (?, ?, ?)', '2025-03', 100_000_000, 8_000_000)
  writeSql("INSERT INTO routines (id, origin, kind, name, instruction, days_mask, hour, minute, missed, need, enabled, deleted_at_ms, creator_id, checked_until_ms, created_at_ms, updated_at_ms) VALUES (?, 'team', 'agent', 'E2E usage routine', 'Check the stock levels.', 127, 6, 0, 'skip', 0, 0, ?, ?, ?, ?, ?)", ROUTINE.id, at, d.memberId, at, at, at)
  writeSql("INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, local_time, tz, due_at_ms, deadline_ms, state, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, claimed_at_ms) VALUES (?, ?, 'scheduled', '2025-03-10', '06:00', 'America/New_York', ?, ?, 'ended', ?, 'rs_e2eUsageRoutineKey001', 'x', '{}', 1, 'm_system', ?)", ROUTINE.slotKey, ROUTINE.id, at, at + 600_000, ROUTINE.chat, at)
  turn(TURNS[3]!, CHATS[0]!, d.memberId, 'claude-sonnet-5-5', '2025-03', 5_000_000)
  turn(TURNS[4]!, ROUTINE.chat, 'm_system', 'claude-sonnet-5-5', '2025-03', 3_000_000)
})
test.afterAll(() => {
  if (process.env.E2E_TEST_BUILD_REMOTE) return // nothing was seeded: writeSql skips there, and a skip inside a hook is not relied on
  clean()
})
function clean() {
  for (const t of TURNS) writeSql('DELETE FROM usage_turns WHERE turn_id = ?', t)
  writeSql('DELETE FROM routine_slots WHERE slot_key = ?', ROUTINE.slotKey)
  writeSql('DELETE FROM routines WHERE id = ?', ROUTINE.id)
  for (const m of ['2025-01', '2025-02', '2025-03']) writeSql('DELETE FROM usage_months WHERE month = ?', m)
}

const usage = async (request: APIRequestContext, who: typeof dana, month: string) => {
  const r = await call(request, who, 'GET', `/api/usage?month=${month}`)
  expect(r.status, r.text).toBe(200)
  return r
}

test('a finished month: money in cents rounded half up, counts from settled turns, rows by member', async ({ request }) => {
  const r = await usage(request, dana, '2025-01')
  expect(r.json).toMatchObject({
    monthKey: '2025-01', cap: { minor: 10_000, currency: 'USD' }, total: { minor: 1235, currency: 'USD' },
    conversations: 2, questionsAsked: 2, jobsRun: 0, capReached: false,
  })
  expect(Array.isArray(r.json.daily)).toBe(true)
  const members = (await allPages<{ id: string; name: string }>(request, admin, '/api/members', 100)).items
  const nameOf = (id: string) => members.find(m => m.id === id)!.name
  const [danaId, leoId] = [(await me(request, dana)).memberId, (await me(request, leo)).memberId]
  const people = r.json.breakdown.person as { name: string; spent: { minor: number }; conversations: number }[]
  expect(people.map(p => [p.name, p.spent.minor, p.conversations]).sort()).toEqual([[nameOf(danaId), 700, 1], [nameOf(leoId), 535, 1]].sort())
  expect((r.json.breakdown.model as { spent: { minor: number } }[]).map(m => m.spent.minor).sort((a, b) => a - b)).toEqual([535, 700])
  // No routine ran in this month: no jobs. The ledger holds no per-tool spend: the Tool breakdown stays empty.
  expect(r.json.breakdown.job).toEqual([])
  expect(r.json.breakdown.tool).toEqual([])
})

test("a routine's turn is a job run: not a question, not a person's row, and the split adds up", async ({ request }) => {
  const r = await usage(request, dana, '2025-03')
  expect(r.json).toMatchObject({ monthKey: '2025-03', total: { minor: 800 }, conversations: 1, questionsAsked: 1, jobsRun: 1 })
  const dName = (await me(request, dana)).name
  const people = r.json.breakdown.person as { name: string; spent: { minor: number }; conversations: number }[]
  expect(people.map(p => [p.name, p.spent.minor, p.conversations])).toEqual([[dName, 500, 1]])
  expect(r.json.breakdown.job).toEqual([{ name: 'E2E usage routine', sub: '1 run', spent: { minor: 300, currency: 'USD' }, conversations: 1 }])
  const sum = (rows: { spent: { minor: number } }[]) => rows.reduce((n, x) => n + x.spent.minor, 0)
  // Person and Job split the month's spend between them; Model covers all of it.
  expect(sum(r.json.breakdown.person) + sum(r.json.breakdown.job)).toBe(r.json.total.minor)
  expect(sum(r.json.breakdown.model)).toBe(r.json.total.minor)
  expect(r.json.breakdown.tool).toEqual([])
})

test('a month spent to its cap reads as reached, with the alert crossed', async ({ request }) => {
  const r = await usage(request, dana, '2025-02')
  expect(r.json).toMatchObject({ monthKey: '2025-02', cap: { minor: 1000 }, total: { minor: 1000 }, capReached: true, alertCrossed: true })
})

test('the month picker lists this month first, then the earlier months newest first', async ({ request }) => {
  const r = await call(request, dana, 'GET', '/api/usage')
  expect(r.status, r.text).toBe(200)
  const months = r.json.months as string[]
  expect(months[0]).toBe(r.json.monthKey)
  expect(months.indexOf('2025-02')).toBeGreaterThan(0)
  expect(months.indexOf('2025-01')).toBeGreaterThan(months.indexOf('2025-02'))
})

test('no chat data: the answer holds no chat or turn id', async ({ request }) => {
  const r = await usage(request, admin, '2025-01')
  for (const id of [...CHATS, ...TURNS]) expect(r.text).not.toContain(id)
  const routine = await usage(request, admin, '2025-03')
  for (const id of [ROUTINE.chat, ROUTINE.slotKey, ...TURNS]) expect(routine.text).not.toContain(id)
})

test('every member, the Admin and Inhouse (no grant needed) read the same page; smoke does not', async ({ request }) => {
  const base = (await usage(request, dana, '2025-01')).json
  for (const who of [leo, admin, inhouse]) expect((await usage(request, who, '2025-01')).json).toEqual(base)
  expectError(await call(request, smoke, 'GET', '/api/usage?month=2025-01'), 403, 'forbidden')
})

test('a malformed month or an unknown parameter is refused', async ({ request }) => {
  for (const q of ['month=2025-13', 'month=2025-1', 'month=latest', 'month=2025-01&x=1', 'x=1']) {
    const r = await call(request, dana, 'GET', `/api/usage?${q}`)
    expect(r.status, q).toBe(400)
    expect(r.json.error.code).toBe('invalid')
  }
})
