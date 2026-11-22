// Which run Today shows and the status cards (p4-w3.md tests 4, 5 and 6), as literal timelines in the New York zone with an
// oracle written in the test. Ways it can fail, written down first:
//  1. an older run's items shown over a newer one, or the order taken from the slot key's text;
//  2. a run that couldn't read everything (or didn't run, or isn't connected) looks like an all clear;
//  3. one card's id covers a later, different card, so dismissing one hides the other;
//  4. a snooze comes back too early (before local midnight) or too late, a dismissal comes back;
//  5. the mapped `Problem` doesn't parse, or the status card shows model words.
import { describe, expect, it } from 'vitest'
import { ProblemSchema } from '../../shared/contract/problem.ts'
import { MorningCheckItemSchema } from '../../shared/contract/today.ts'
import { intlZone } from '../routines/slots.ts'
import { cardId, itemId } from './ids.ts'
import { cardProblem, toProblem } from './problem.ts'
import { hides } from './store.ts'
import { fixedWords, incompleteSummary, gapsOfSummary, stripFixed, thingsWords } from './words.ts'
import { resultWords } from '../routines/store.ts'
import { clockWords, todayView } from './view.ts'
import type { RoutineFacts, SlotFacts } from './view.ts'

const TZ = 'America/New_York'
const at = (iso: string) => Date.parse(iso)
const ROUTINE: RoutineFacts = { id: 'routine-morning-check', enabled: true, deleted: false, days_mask: 127, hour: 6, minute: 0 }
const DAY = '2026-06-01'
const slot = (over: Partial<SlotFacts> & Pick<SlotFacts, 'slot_key'>): SlotFacts => ({
  local_date: DAY, local_time: '06:00', state: 'ended', reason: null, failure: null, result_text: 'found 2 things', claimed_at_ms: at('2026-06-01T10:00:00Z'), ended_at_ms: at('2026-06-01T10:03:00Z'), ...over,
})
const view = (nowIso: string, slots: SlotFacts[], routine: RoutineFacts | null = ROUTINE) => todayView({ nowMs: at(nowIso), tz: TZ, routine, slots })
const causes = (v: ReturnType<typeof view>) => v.cards.map(c => c.cause)

describe('which run is shown', () => {

  it('is the newest by (local_date, claimed_at_ms), not the key text', () => {
    const early = slot({ slot_key: 'zzz|early', claimed_at_ms: 100 })
    const late = slot({ slot_key: 'aaa|late', claimed_at_ms: 200 })
    expect(view('2026-06-01T15:00:00Z', [early, late]).shown?.slot_key).toBe('aaa|late')
    expect(view('2026-06-01T15:00:00Z', [late, early]).shown?.slot_key).toBe('aaa|late')
  })
  it("shows yesterday's run before today's has ended (OC 4)", () => {
    const yesterday = slot({ slot_key: 'y', local_date: '2026-05-31' })
    const running = slot({ slot_key: 't', state: 'started', ended_at_ms: null })
    const v = view('2026-06-01T10:05:00Z', [yesterday, running])
    expect(v.shown?.slot_key).toBe('y')
    expect(v.cards).toEqual([])
  })
  it('skips a failed run: a failed Run now after a good run shows the good run and a failed card', () => {
    const good = slot({ slot_key: 'g' })
    const failed = slot({ slot_key: 'f', state: 'ended', failure: 'run_failed', claimed_at_ms: at('2026-06-01T12:14:00Z'), ended_at_ms: at('2026-06-01T12:16:00Z'), local_time: null })
    const v = view('2026-06-01T13:00:00Z', [good, failed])
    expect(v.shown?.slot_key).toBe('g')
    expect(causes(v)).toEqual(['failed'])
    expect(v.cards[0].clock).toBe('8:16 AM')
  })
})

describe('status cards, literal states', () => {
  it('an incomplete run: its items and the card naming the gaps', () => {
    const r = slot({ slot_key: 'i', failure: 'incomplete', result_text: "found 3 things; couldn't read refunds, returns" })
    const v = view('2026-06-01T12:00:00Z', [r])
    expect(v.shown?.slot_key).toBe('i')
    expect(v.cards).toMatchObject([{ cause: 'incomplete', clock: '6:00 AM', areas: ['refunds', 'returns'], tooMany: false }])
  })
  it('a failed run after yesterday\'s complete run: yesterday\'s items plus the card', () => {
    const yesterday = slot({ slot_key: 'y', local_date: '2026-05-31', claimed_at_ms: at('2026-05-31T10:00:00Z') })
    const failed = slot({ slot_key: 't', failure: 'invalid_result' })
    const v = view('2026-06-01T12:00:00Z', [yesterday, failed])
    expect(v.shown?.slot_key).toBe('y')
    expect(causes(v)).toEqual(['failed'])
  })
  it("shows yesterday's failed check at 06:05, before today's scheduled check is late", () => {
    const failed = slot({
      slot_key: 'y-failed', local_date: '2026-05-31', failure: 'run_failed',
      claimed_at_ms: at('2026-05-31T10:00:00Z'), ended_at_ms: at('2026-05-31T10:03:00Z'),
    })
    const early = '2026-06-01T10:05:00Z'
    const v = view(early, [failed])
    expect(v.shown).toBeNull()
    expect(v.cards).toMatchObject([{
      cause: 'failed', hashed: 'y-failed', localDate: '2026-05-31', clock: '6:00 AM', atMs: failed.ended_at_ms,
    }])
    expect(causes(view('2026-06-01T10:11:00Z', [failed]))).toEqual(['not_run'])
    expect(causes(view(early, [failed, slot({ slot_key: 'success' })]))).toEqual([])
    const recovered = { ...failed, slot_key: 'y-recovered', failure: null, claimed_at_ms: failed.claimed_at_ms + 600_000 }
    expect(causes(view(early, [failed, recovered]))).toEqual([])
  })
  describe('a failure carried from the previous local date', () => {
    const fri = slot({ slot_key: 'fri', local_date: '2026-06-05', claimed_at_ms: at('2026-06-05T10:00:00Z'), ended_at_ms: at('2026-06-05T10:03:00Z'), failure: 'run_failed' })
    const weekdays: RoutineFacts = { ...ROUTINE, days_mask: 0b0011111 } // Monday to Friday
    it('a failure from two days ago shows nothing, even when the view is given it', () => {
      const old = slot({ slot_key: 'old', local_date: '2026-05-30', failure: 'run_failed', claimed_at_ms: at('2026-05-30T10:00:00Z'), ended_at_ms: at('2026-05-30T10:03:00Z') })
      expect(causes(view('2026-06-01T10:05:00Z', [old]))).toEqual([])
    })
    it('a deleted (null) routine carries nothing', () => {
      expect(causes(view('2026-06-01T10:05:00Z', [slot({ slot_key: 'y', local_date: '2026-05-31', failure: 'run_failed' })], null))).toEqual([])
    })
    it('a Saturday after a failed Friday shows it; a Sunday shows nothing', () => {
      expect(causes(view('2026-06-06T15:00:00Z', [fri], weekdays))).toEqual(['failed'])
      expect(causes(view('2026-06-07T15:00:00Z', [fri], weekdays))).toEqual([])
    })
    it('exactly 06:10 still carries it; a minute later the overdue card takes over', () => {
      const y = slot({ slot_key: 'y', local_date: '2026-05-31', failure: 'run_failed', claimed_at_ms: at('2026-05-31T10:00:00Z'), ended_at_ms: at('2026-05-31T10:03:00Z') })
      expect(causes(view('2026-06-01T10:10:00Z', [y]))).toEqual(['failed'])
      expect(causes(view('2026-06-01T10:11:00Z', [y]))).toEqual(['not_run'])
    })
    it("uses the brand's local date, not the UTC one", () => {
      // 02:00 UTC on June 2 is 22:00 on June 1 in New York: the previous local date is May 31, not June 1.
      const may31 = slot({ slot_key: 'may31', local_date: '2026-05-31', failure: 'run_failed', claimed_at_ms: at('2026-05-31T10:00:00Z'), ended_at_ms: at('2026-05-31T10:03:00Z') })
      const jun1 = slot({ slot_key: 'jun1', failure: 'run_failed' })
      const night = view('2026-06-02T02:00:00Z', [may31, jun1], { ...ROUTINE, days_mask: 0 })
      expect(night.cards).toMatchObject([{ cause: 'failed', hashed: 'jun1' }])
      const early = view('2026-06-01T04:30:00Z', [may31], ROUTINE) // 00:30 June 1 in New York, still June 1 locally
      expect(early.cards).toMatchObject([{ cause: 'failed', hashed: 'may31' }])
    })
    it('a set-aside carried card stays hidden', async () => {
      const y = slot({ slot_key: 'y', local_date: '2026-05-31', failure: 'run_failed' })
      const [c] = view('2026-06-01T10:05:00Z', [y]).cards
      const same = view('2026-06-01T10:06:00Z', [y]).cards[0]
      expect(await cardId(c.localDate, c.cause, c.hashed)).toBe(await cardId(same.localDate, same.cause, same.hashed))
      expect(hides({ reason: 'dismissed', at_ms: at('2026-06-01T10:05:30Z') }, at('2026-06-01T10:06:00Z'), intlZone(TZ))).toBe(true)
    })
  })
  it('lost, missed and refused slots are failed cards; claimed and started are none', () => {
    for (const state of ['lost', 'missed', 'refused'] as const) expect(causes(view('2026-06-01T12:00:00Z', [slot({ slot_key: state, state, ended_at_ms: null })]))).toEqual(['failed'])
    for (const state of ['claimed', 'started'] as const) expect(causes(view('2026-06-01T12:00:00Z', [slot({ slot_key: state, state, ended_at_ms: null })]))).toEqual([])
  })
  it('past 06:10 with no slot today: the card; before 06:10: none; on the minute after: the card', () => {
    expect(causes(view('2026-06-01T10:05:00Z', []))).toEqual([])
    expect(causes(view('2026-06-01T10:10:00Z', []))).toEqual([])
    expect(causes(view('2026-06-01T10:11:00Z', []))).toEqual(['not_run'])
    expect(view('2026-06-01T10:11:00Z', []).cards[0]).toMatchObject({ hashed: 'routine-morning-check|2026-06-01', localDate: '2026-06-01' })
  })
  it('the off card, instead of not_run, when the routine is off or gone', () => {
    expect(causes(view('2026-06-01T12:00:00Z', [], { ...ROUTINE, enabled: false }))).toEqual(['off'])
    expect(causes(view('2026-06-01T12:00:00Z', [], { ...ROUTINE, deleted: true }))).toEqual(['off'])
    expect(causes(view('2026-06-01T12:00:00Z', [slot({ slot_key: 's', state: 'skipped', reason: 'disabled', ended_at_ms: null })]))).toEqual(['off'])
  })
  it('a routine that does not run today has no not_run card', () => {
    // 2026-06-01 is a Monday (bit 0): a Tuesday-only routine has no slot due.
    expect(causes(view('2026-06-01T12:00:00Z', [], { ...ROUTINE, days_mask: 0b10 }))).toEqual([])
  })
  it('a complete run with zero items: no card, an empty list', () => {
    const v = view('2026-06-01T12:00:00Z', [slot({ slot_key: 'c', result_text: 'found 0 things' })])
    expect(v.cards).toEqual([])
    expect(v.shown?.slot_key).toBe('c')
  })
  it('not connected: its quiet card', () => {
    expect(causes(view('2026-06-01T12:00:00Z', [slot({ slot_key: 'n', failure: 'not_connected' })]))).toEqual(['not_connected'])
  })
  it('no routine row at all: no card (nothing to say it should have run)', () => {
    expect(causes(view('2026-06-01T12:00:00Z', [], null))).toEqual([])
  })
})

describe('ids', () => {
  it('an item id is stable per key and local date, and differs on a new date or key', async () => {
    const a = await itemId('late-orders', '2026-06-01')
    expect(a).toMatch(/^p_[A-Za-z0-9_-]{22}$/)
    expect(await itemId('late-orders', '2026-06-01')).toBe(a)
    expect(await itemId('late-orders', '2026-06-02')).not.toBe(a)
    expect(await itemId('low-stock', '2026-06-01')).not.toBe(a)
  })
  it('a card id is per cause and slot, in the audit contract\'s shape', async () => {
    const i = await cardId('2026-06-01', 'incomplete', 's1')
    const f = await cardId('2026-06-01', 'failed', 's1')
    expect(i).toMatch(/^p_check_2026-06-01_incomplete_[A-Za-z0-9_-]{22}$/)
    expect(f).not.toBe(i)
    expect(await cardId('2026-06-01', 'failed', 's2')).not.toBe(f)
    expect(await cardId('2026-06-01', 'not_run', 'routine-morning-check|2026-06-01')).toMatch(/^p_check_2026-06-01_not_run_[A-Za-z0-9_-]{22}$/)
  })
})

describe('set aside, New York local days', () => {
  const zone = intlZone(TZ)
  const snooze = { reason: 'snoozed' as const, at_ms: at('2026-06-02T03:50:00Z') } // 23:50 on June 1 in New York
  it('a snooze at 23:50 hides until local midnight, then the item comes back', () => {
    expect(hides(snooze, at('2026-06-02T03:55:00Z'), zone)).toBe(true) // 23:55
    expect(hides(snooze, at('2026-06-02T03:59:59Z'), zone)).toBe(true)
    expect(hides(snooze, at('2026-06-02T04:00:00Z'), zone)).toBe(false) // 00:00 June 2
  })
  it('a snooze early in the day lasts to that day\'s end', () => {
    const s = { reason: 'snoozed' as const, at_ms: at('2026-06-01T11:00:00Z') }
    expect(hides(s, at('2026-06-02T03:59:00Z'), zone)).toBe(true)
    expect(hides(s, at('2026-06-02T04:01:00Z'), zone)).toBe(false)
  })
  it('a dismissal stays through any later time; a brought-back row hides nothing; declined stays hidden', () => {
    expect(hides({ reason: 'dismissed', at_ms: at('2026-06-01T11:00:00Z') }, at('2026-07-01T11:00:00Z'), zone)).toBe(true)
    expect(hides({ reason: null, at_ms: at('2026-06-01T11:00:00Z') }, at('2026-06-01T12:00:00Z'), zone)).toBe(false)
    expect(hides({ reason: 'declined', at_ms: at('2026-06-01T11:00:00Z') }, at('2026-06-03T12:00:00Z'), zone)).toBe(true)
  })
})

describe('the words', () => {
  it('writes a summary and reads its gaps back', () => {
    expect(thingsWords(0)).toBe('found 0 things')
    expect(thingsWords(1)).toBe('found 1 thing')
    expect(thingsWords(4)).toBe('found 4 things')
    expect(incompleteSummary(3, ['returns', 'refunds'])).toBe("found 3 things; couldn't read refunds, returns")
    expect(incompleteSummary(10, ['too_many'])).toBe('found more than 10 things; showing 10')
    expect(incompleteSummary(10, ['too_many', 'orders'])).toBe("found more than 10 things; showing 10; couldn't read orders")
    expect(gapsOfSummary("found 3 things; couldn't read refunds, returns")).toEqual({ areas: ['refunds', 'returns'], tooMany: false })
    expect(gapsOfSummary("found more than 10 things; showing 10; couldn't read orders")).toEqual({ areas: ['orders'], tooMany: true })
    expect(gapsOfSummary("found more than 10 things; showing 10 (fixed: 1 over the cap)")).toEqual({ areas: [], tooMany: true })
    expect(gapsOfSummary("found 2 things; couldn't read refunds (fixed: 3 cut)")).toEqual({ areas: ['refunds'], tooMany: false })
    expect(fixedWords({ truncated: 0, dropped: 0, deduped: 0, overflow: 0, costsRemoved: 0 })).toBe('')
    expect(fixedWords({ truncated: 2, dropped: 0, deduped: 1, overflow: 3, costsRemoved: 0 })).toBe(' (fixed: 2 cut, 1 repeated, 3 over the cap)')
    expect(fixedWords({ truncated: 0, dropped: 0, deduped: 0, overflow: 0, costsRemoved: 1 })).toBe(' (fixed: 1 cost removed)')
    expect(fixedWords({ truncated: 0, dropped: 0, deduped: 0, overflow: 0, costsRemoved: 2 })).toBe(' (fixed: 2 costs removed)')
    expect(gapsOfSummary(null)).toEqual({ areas: [], tooMany: false })
  })
  it('the tail of fixed counts never reaches the product text: resultWords drops it, the stored text keeps it', () => {
    const stored = "found 3 things; couldn't read refunds (fixed: 2 cut, 1 repeated)"
    expect(stripFixed(stored)).toBe("found 3 things; couldn't read refunds")
    expect(stripFixed('found 3 things')).toBe('found 3 things')
    expect(stripFixed('found 1 thing (fixed: 1 cut) and more')).toBe('found 1 thing (fixed: 1 cut) and more')
    const slot = { state: 'ended' as const, failure: 'incomplete', outcome: 'done', reason: null }
    expect(resultWords({ ...slot, result_text: stored })).toBe("found 3 things; couldn't read refunds")
    expect(resultWords({ ...slot, result_text: `found 4 things${fixedWords({ truncated: 1, dropped: 2, deduped: 3, overflow: 4, costsRemoved: 0 })}` })).toBe('found 4 things')
    expect(resultWords({ ...slot, result_text: 'found 4 things' })).toBe('found 4 things')
    expect(gapsOfSummary(stored).areas).toEqual(['refunds'])
  })
  it('names the clock', () => {
    expect([clockWords('06:00'), clockWords('00:05'), clockWords('12:30'), clockWords('13:07'), clockWords('23:59')]).toEqual(['6:00 AM', '12:05 AM', '12:30 PM', '1:07 PM', '11:59 PM'])
  })
})

describe('the Problem mapping', () => {
  const foundAt = { iso: '2026-06-01T10:03:00.000Z', ms: at('2026-06-01T10:03:00Z') }
  const item = {
    id: 'p_AAAAAAAAAAAAAAAAAAAAAA', key: 'late-orders', sev: '#b23c22' as const, area: 'Orders' as const, title: '4 orders are late', sub: 'Past their ship date', cost: { minor: 119000, currency: 'USD' },
    costNote: 'in orders at risk', next: 'Email the 4 customers', found: [['Late orders', '4'] as [string, string]], sources: [{ n: '#1042', text: 'Placed 9 days ago' }],
    since: { iso: '2026-05-30T13:00:00.000Z', ms: at('2026-05-30T13:00:00Z') }, foundAt, routineRun: 'r_run1',
  }
  it('maps a literal item to a literal Problem that ProblemSchema parses', () => {
    const p = toProblem(item, 'USD')
    expect(p).toEqual({
      id: 'p_AAAAAAAAAAAAAAAAAAAAAA', sev: '#b23c22', area: 'Orders', title: '4 orders are late', sub: 'Past their ship date', logos: ['shopify'],
      cost: { minor: 119000, currency: 'USD' }, costNote: 'in orders at risk', next: 'Email the 4 customers', doneText: 'Nothing done yet', trace: 'r_run1',
      found: [['Late orders', '4']], sources: [{ n: '#1042', logo: 'shopify', name: 'Shopify', text: 'Placed 9 days ago' }],
      draft: { title: 'Email the 4 customers', lines: [], cta: 'Approve' }, draftedAt: foundAt,
    })
    expect(ProblemSchema.safeParse(p).success).toBe(true)
  })
  it('a null cost is zero in the brand currency with an empty note', () => {
    const p = toProblem({ ...item, cost: null }, 'GBP')
    expect(p.cost).toEqual({ minor: 0, currency: 'GBP' })
    expect(p.costNote).toBe('')
    expect(ProblemSchema.safeParse(p).success).toBe(true)
  })
  it('the item still parses as the model returned it, without since (the server sets it)', () => {
    const { since: _s, id: _i, foundAt: _f, routineRun: _r, ...fromModel } = item
    expect(MorningCheckItemSchema.safeParse({ ...fromModel, since: null }).success).toBe(true)
  })
  it('every status card parses, in fixed words', async () => {
    const base = { localDate: DAY, hashed: 'x', clock: '6:00 AM', atMs: at('2026-06-01T10:03:00Z'), areas: [] as string[], tooMany: false }
    const cards = [
      { ...base, cause: 'incomplete' as const, areas: ['refunds'] }, { ...base, cause: 'incomplete' as const, tooMany: true }, { ...base, cause: 'incomplete' as const, areas: ['orders'], tooMany: true },
      { ...base, cause: 'failed' as const }, { ...base, cause: 'not_run' as const, clock: null }, { ...base, cause: 'not_connected' as const }, { ...base, cause: 'off' as const, clock: null },
    ]
    const titles = []
    for (const c of cards) {
      const p = cardProblem(c, await cardId(c.localDate, c.cause, c.hashed), 'USD')
      expect(ProblemSchema.safeParse(p).success).toBe(true)
      expect(p.sources).toEqual([])
      expect(p.logos).toEqual(['shopify'])
      titles.push(p.title)
    }
    expect(titles).toEqual([
      "The 6:00 AM check couldn't read everything: refunds", 'The 6:00 AM check found more than 10 things; showing 10',
      "The 6:00 AM check couldn't read everything: orders. It also found more than 10 things; showing 10", "The 6:00 AM check didn't finish",
      "The morning check hasn't run today", "Shopify isn't connected yet", 'The morning check is off',
    ])
    expect(cardProblem(cards[6], 'p_x', 'USD').next).toBe('The morning check is off. Turn it on in Routines.')
    expect(cardProblem(cards[3], 'p_x', 'USD').next).toBe('Ask the Inhouse team to check the Shopify connection')
  })
})
