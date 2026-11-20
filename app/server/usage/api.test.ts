// Route 42 on the real migrations, numbers from a literal fixture (expected values written out by hand). Ways it can fail:
//  1. totals, counts or rows built from unsettled turns, or a refused turn counted;
//  2. money rounded wrongly (micro-USD to cents), a day taken in UTC rather than the brand's zone;
//  3. `capReached` / `alertCrossed` taken from stored marks instead of the cap as it is now (a raised cap must clear);
//  4. a bad, future or extra query parameter reaching the store.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { UsageDataSchema } from '../../shared/contract/usage.ts'
import { openStores } from '../db/stores.ts'
import { ctx, personPrincipal } from '../db/test-support.ts'
import { getUsage } from './api.ts'
import { createUsageLedger } from './ledger.ts'
import { db, resetUsage, setSetting, turnIn } from './test-fixtures.ts'

const stores = openStores(env)
const ledger = createUsageLedger({ db })
const NOW = Date.UTC(2026, 10, 15, 12, 0)

const read = async (query = '') => {
  const res = await getUsage(ctx(stores, personPrincipal('m_u_ada', 'member'), { path: `/api/usage${query}`, nowMs: NOW }).c)
  return { status: res.status, body: (await res.json()) as unknown }
}
const usage = async (query = '') => {
  const r = await read(query)
  expect(r.status).toBe(200)
  return UsageDataSchema.parse(r.body)
}
const usd = (minor: number) => ({ minor, currency: 'USD' })

beforeAll(async () => {
  await resetUsage('$10')
  await setSetting('s:alert', '50%')
  for (const [id, name] of [['m_u_ada', 'Ada Example'], ['m_u_ben', 'Ben Example']]) {
    await db.prepare("INSERT INTO members (id, kind, role, status, name, email_norm, created_at_ms) VALUES (?, 'person', 'member', 'active', ?, ?, 1)")
      .bind(id, name, `${id}@example.com`).run()
  }
  const settle = async (t: string, o: Parameters<typeof turnIn>[1], micro: number) => {
    await ledger.reserve(turnIn(t, o))
    await ledger.settle(t, micro, NOW)
  }
  // Nov 1, 00:30 GMT: day 1 in London.
  await settle('t1', { memberId: 'm_u_ada', chatId: 'c1', nowMs: Date.UTC(2026, 10, 1, 0, 30) }, 1_234_567)
  await settle('t2', { memberId: 'm_u_ada', chatId: 'c1', nowMs: NOW }, 500_000)
  await settle('t3', { memberId: 'm_u_ben', chatId: 'c2', nowMs: NOW, model: 'claude-haiku-5-5' }, 3_000_000)
  // Held, not settled: not in any number.
  await ledger.reserve(turnIn('t4', { memberId: 'm_u_ben', chatId: 'c9', nowMs: NOW }))
  // Cancelled before any call: a settled turn of $0.
  await ledger.reserve(turnIn('t5', { memberId: 'm_u_ben', chatId: 'c3', nowMs: NOW }))
  await ledger.release('t5', NOW)
  // October has a ledger row.
  await settle('t_oct', { memberId: 'm_u_ada', chatId: 'c0', nowMs: Date.UTC(2026, 9, 20, 12) }, 2_000_000)
})

describe('route 42', () => {
  it('this month from settled turns, in cents, by day in the brand\'s zone (failures 1, 2)', async () => {
    const u = await usage()
    expect(u).toMatchObject({
      month: 'November', monthKey: '2026-11', cap: usd(1000), alertAt: 50, total: usd(473), conversations: 3, questionsAsked: 4, jobsRun: 0,
      capReached: false, alertCrossed: false, months: ['2026-11', '2026-10'],
    })
    expect(u.daily).toEqual([usd(123), ...Array.from({ length: 13 }, () => usd(0)), usd(350)])
    expect(u.breakdown.person).toEqual([
      { name: 'Ben Example', sub: '2 questions', spent: usd(300), conversations: 2 },
      { name: 'Ada Example', sub: '2 questions', spent: usd(173), conversations: 1 },
    ])
    expect(u.breakdown.model).toEqual([
      { name: 'Haiku 5.5', sub: 'Instant', spent: usd(300), conversations: 1 },
      { name: 'Sonnet 5.5', sub: 'Fast', spent: usd(173), conversations: 2 },
    ])
    expect(u.breakdown.job).toEqual([])
    expect(u.breakdown.tool).toEqual([])
  })

  it('marks follow the cap as it is now: lowered, reached and crossed; raised, both clear (failure 3)', async () => {
    await setSetting('s:cap', '$4')
    expect(await usage()).toMatchObject({ cap: usd(400), capReached: true, alertCrossed: true })
    await setSetting('s:cap', '$100')
    expect(await usage()).toMatchObject({ cap: usd(10000), capReached: false, alertCrossed: false })
    await setSetting('s:cap', null)
    expect(await usage()).toMatchObject({ cap: usd(0), capReached: true, alertCrossed: false })
    await setSetting('s:cap', '$10')
  })

  it('a finished month: every day, its own spend and the cap its ledger recorded', async () => {
    const u = await usage('?month=2026-10')
    expect(u).toMatchObject({ month: 'October', monthKey: '2026-10', cap: usd(1000), total: usd(200), questionsAsked: 1, capReached: false })
    expect(u.daily).toHaveLength(31)
    expect(u.daily[19]).toEqual(usd(200))
  })

  it('refuses a future month, a bad month and an extra parameter (failure 4)', async () => {
    for (const q of ['?month=2026-12', '?month=2026-13', '?month=nov', '?month=2026-11&x=1', '?month=2026-11&month=2026-10']) {
      expect((await read(q)).status).toBe(400)
    }
  })
})
