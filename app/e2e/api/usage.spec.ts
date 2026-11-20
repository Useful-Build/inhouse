// Usage (p3-design section 9, route 42): from D1 only, aggregate rows by member, no chat data (BD7), money as USD cents
// rounded half up from micro-USD, finished months with the cap their ledger recorded. Past months are seeded into D1 (the
// ledger is written by the egress, which needs a container), so the spec runs on the local test build and skips on a
// deployed one. Oracles: the design's arithmetic below, worked out by hand.
//   2025-01: cap $100, spent 12,345,678 micro = turns 7,000,000 (Dana, Sonnet) + 5,345,678 (Leo, Haiku)
//            cents: 700, 534.5678 -> 535, total 1234.5678 -> 1235
//   2025-02: cap $10, spent 10,000,000: at the cap, so capReached and alertCrossed
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
const TURNS = ['t_e2eUsageTurn0000000001', 't_e2eUsageTurn0000000002', 't_e2eUsageTurn0000000003']
const at = Date.UTC(2025, 0, 10, 12)

test.beforeAll(async ({ request }) => {
  const [d, l] = await Promise.all([me(request, dana), me(request, leo)])
  for (const t of TURNS) writeSql('DELETE FROM usage_turns WHERE turn_id = ?', t)
  for (const m of ['2025-01', '2025-02']) writeSql('DELETE FROM usage_months WHERE month = ?', m)
  writeSql('INSERT INTO usage_months (month, cap_micro, spent_micro) VALUES (?, ?, ?)', '2025-01', 100_000_000, 12_345_678)
  writeSql('INSERT INTO usage_months (month, cap_micro, spent_micro) VALUES (?, ?, ?)', '2025-02', 10_000_000, 10_000_000)
  const turn = (id: string, chat: string, member: string, model: string, month: string, micro: number) =>
    writeSql('INSERT INTO usage_turns (turn_id, run_id, chat_id, member_id, model, month, reserved_micro, settled_micro, final, source, created_at_ms, settled_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, \'tally\', ?, ?)', id, `r_${id}`, chat, member, model, month, micro, micro, at, at)
  turn(TURNS[0]!, CHATS[0]!, d.memberId, 'claude-sonnet-5-5', '2025-01', 7_000_000)
  turn(TURNS[1]!, CHATS[1]!, l.memberId, 'claude-haiku-5-5', '2025-01', 5_345_678)
  turn(TURNS[2]!, CHATS[0]!, d.memberId, 'claude-sonnet-5-5', '2025-02', 10_000_000)
})
test.afterAll(() => {
  if (process.env.E2E_TEST_BUILD_REMOTE) return // nothing was seeded: writeSql skips there, and a skip inside a hook is not relied on
  for (const t of TURNS) writeSql('DELETE FROM usage_turns WHERE turn_id = ?', t)
  for (const m of ['2025-01', '2025-02']) writeSql('DELETE FROM usage_months WHERE month = ?', m)
})

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
  // Jobs and tools are P4 and P5's: empty.
  expect(r.json.breakdown.job).toEqual([])
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
