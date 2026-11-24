// Route 42 on the real migrations, numbers from a literal fixture (expected values written out by hand). Ways it can fail:
//  1. totals, counts or rows built from unsettled turns, or a refused turn counted;
//  2. money rounded wrongly (micro-USD to cents), a day taken in UTC rather than the brand's zone;
//  3. `capReached` / `alertCrossed` taken from stored marks instead of the cap as it is now (a raised cap must clear);
//  4. a bad, future or extra query parameter reaching the store;
//  5. a routine's turns (chats `m_system` owns) counted as questions or a person's row, left out of Jobs run and the Job
//     breakdown, or the split not adding up (spend by person + spend by job = total, spend by model = total);
//  6. a routine run counted per turn (a run that parks on a question and resumes adds a second turn in the same chat), or
//     routine chats left out of `conversations` (the page's cost per conversation is total / conversations, and the total
//     holds the routines' spend).
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { UsageDataSchema } from '../../shared/contract/usage.ts'
import { openStores } from '../db/stores.ts'
import { ctx, personPrincipal } from '../db/test-support.ts'
import { getUsage, toUsageData } from './api.ts'
import { createUsageLedger } from './ledger.ts'
import { insertRoutine, insertSlot, routine } from '../routines/test-kit.ts'
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

  it('capReached means new chats are refused: cap − spent under the $0.25 start hold (review round 1)', async () => {
    // Spent $4.734567: $4.98 leaves $0.245433 < $0.25 → reached; $4.99 leaves $0.255433 → not.
    await setSetting('s:cap', '$4.98')
    expect(await usage()).toMatchObject({ capReached: true })
    await setSetting('s:cap', '$4.99')
    expect(await usage()).toMatchObject({ capReached: false })
    await setSetting('s:cap', '$10')
    const view = { month: '2026-11', current: true, capMicro: 250_000_000, alertPct: 80, spentMicro: 249_800_000, conversations: 0, questions: 0, jobsRun: 0, dailyMicro: [], people: [], jobs: [], models: [], months: ['2026-11'] }
    expect(toUsageData(view).capReached).toBe(true)
  })

  it('a refused reserve leaves no empty month in the picker (review round 1)', async () => {
    await setSetting('s:cap', '$0.10')
    await ledger.reserve(turnIn('t_refused', { nowMs: Date.UTC(2026, 8, 10, 12) }))
    await setSetting('s:cap', '$10')
    expect((await usage()).months).toEqual(['2026-11', '2026-10'])
  })

  it('a finished month: every day, its own spend and the cap its ledger recorded', async () => {
    const u = await usage('?month=2026-10')
    expect(u).toMatchObject({ month: 'October', monthKey: '2026-10', cap: usd(1000), total: usd(200), questionsAsked: 1, capReached: false })
    expect(u.daily).toHaveLength(31)
    expect(u.daily[19]).toEqual(usd(200))
  })

  it('a routine\'s turns are jobs: Jobs run and the Job rows by routine, never questions or a person (failure 5)', async () => {
    // August: no other test reads it. Ada asks one question ($0.80, Sonnet); two routines run: Morning check twice ($0.60,
    // $0.20, Sonnet) and Stock sweep once ($0.30, Haiku), each run in its own chat that `m_system` owns. The Stock sweep run
    // parked on a question and resumed: a second turn ($0.10, Haiku) in the same chat, which is still one run.
    const aug = Date.UTC(2026, 7, 10, 12)
    const morning = await insertRoutine(routine({ name: 'Morning check', creator_id: 'm_u_ada', checked_until_ms: aug }))
    const sweep = await insertRoutine(routine({ name: 'Stock sweep', creator_id: 'm_u_ada', checked_until_ms: aug }))
    // A slot names its chat's first turn (`turn_id`); the resume turn is in the chat only.
    await insertSlot({ routine_id: morning.id, local_date: '2026-08-10', claimed_at_ms: aug, chat_id: 'rc_aug_1', turn_id: 't_a2' })
    await insertSlot({ routine_id: morning.id, local_date: '2026-08-11', claimed_at_ms: aug, chat_id: 'rc_aug_2', turn_id: 't_a3' })
    await insertSlot({ routine_id: sweep.id, local_date: '2026-08-10', claimed_at_ms: aug, chat_id: 'rc_aug_3', turn_id: 't_a4' })
    const settle = async (t: string, o: Parameters<typeof turnIn>[1], micro: number) => {
      await ledger.reserve(turnIn(t, o))
      await ledger.settle(t, micro, NOW)
    }
    await settle('t_a1', { memberId: 'm_u_ada', chatId: 'c_aug_q', nowMs: aug }, 800_000)
    await settle('t_a2', { memberId: 'm_system', chatId: 'rc_aug_1', nowMs: aug }, 600_000)
    await settle('t_a3', { memberId: 'm_system', chatId: 'rc_aug_2', nowMs: aug }, 200_000)
    await settle('t_a4', { memberId: 'm_system', chatId: 'rc_aug_3', nowMs: aug, model: 'claude-haiku-5-5' }, 300_000)
    await settle('t_a5', { memberId: 'm_system', chatId: 'rc_aug_3', nowMs: aug, model: 'claude-haiku-5-5' }, 100_000)
    const u = await usage('?month=2026-08')
    // Three runs (not four turns); the routine chats are conversations too, so conversations = questions + runs here (one
    // question per person chat) and the cost per conversation is $2.00 / 4 = $0.50.
    expect(u).toMatchObject({ total: usd(200), conversations: 4, questionsAsked: 1, jobsRun: 3 })
    expect(u.conversations).toBe(u.questionsAsked + u.jobsRun)
    expect(u.total.minor / u.conversations).toBe(50)
    expect(u.breakdown.person).toEqual([{ name: 'Ada Example', sub: '1 question', spent: usd(80), conversations: 1 }])
    expect(u.breakdown.job).toEqual([
      { name: 'Morning check', sub: '2 runs', spent: usd(80), conversations: 2 },
      { name: 'Stock sweep', sub: '1 run', spent: usd(40), conversations: 1 },
    ])
    expect(u.breakdown.job.map(r => r.conversations).reduce((a, b) => a + b, 0)).toBe(u.jobsRun)
    // The model rows keep every turn's spend and count every chat they worked in.
    expect(u.breakdown.model).toEqual([
      { name: 'Sonnet 5.5', sub: 'Fast', spent: usd(160), conversations: 3 },
      { name: 'Haiku 5.5', sub: 'Instant', spent: usd(40), conversations: 1 },
    ])
    const sum = (rows: { spent: { minor: number } }[]) => rows.reduce((n, r) => n + r.spent.minor, 0)
    expect(sum(u.breakdown.person) + sum(u.breakdown.job)).toBe(u.total.minor)
    expect(sum(u.breakdown.model)).toBe(u.total.minor)
    // The month a routine runs in is a month with usage: it is offered in the picker.
    expect((await usage()).months).toContain('2026-08')
  })

  it('a routine turn with no slot row is one run under "Other routines" and still adds up (failure 5)', async () => {
    // July: no other test reads it. Ada asks one question ($0.50). Digest runs once ($0.30, its slot names the first turn).
    // A second run's slot was deleted after the steps retention period (the turns outlive the slots), so its system turn
    // matches no `routine_slots` row ($0.20). The cross-month case (first turn in June, resume turn in July) takes the same path.
    const jul = Date.UTC(2026, 6, 10, 12)
    const digest = await insertRoutine(routine({ name: 'Digest', creator_id: 'm_u_ada', checked_until_ms: jul }))
    await insertSlot({ routine_id: digest.id, local_date: '2026-07-10', claimed_at_ms: jul, chat_id: 'rc_jul_1', turn_id: 't_j2' })
    const settle = async (t: string, o: Parameters<typeof turnIn>[1], micro: number) => {
      await ledger.reserve(turnIn(t, o))
      await ledger.settle(t, micro, NOW)
    }
    await settle('t_j1', { memberId: 'm_u_ada', chatId: 'c_jul_q', nowMs: jul }, 500_000)
    await settle('t_j2', { memberId: 'm_system', chatId: 'rc_jul_1', nowMs: jul }, 300_000)
    await settle('t_j3', { memberId: 'm_system', chatId: 'rc_jul_2', nowMs: jul }, 200_000)
    const u = await usage('?month=2026-07')
    expect(u).toMatchObject({ total: usd(100), conversations: 3, questionsAsked: 1, jobsRun: 2 })
    expect(u.breakdown.job).toEqual([
      { name: 'Digest', sub: '1 run', spent: usd(30), conversations: 1 },
      { name: 'Other routines', sub: '1 run', spent: usd(20), conversations: 1 },
    ])
    const sum = (rows: { spent: { minor: number } }[]) => rows.reduce((n, r) => n + r.spent.minor, 0)
    expect(sum(u.breakdown.person) + sum(u.breakdown.job)).toBe(u.total.minor)
    expect(sum(u.breakdown.model)).toBe(u.total.minor)
  })

  it('refuses a future month, a bad month and an extra parameter (failure 4)', async () => {
    for (const q of ['?month=2026-12', '?month=2026-13', '?month=nov', '?month=2026-11&x=1', '?month=2026-11&month=2026-10']) {
      expect((await read(q)).status).toBe(400)
    }
  })
})
