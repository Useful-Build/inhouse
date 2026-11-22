// Today empty-state regressions (P7 W2 items):
// 1. Run headline at h = 0 / n = 0 reads cleanly (never "0 handled before you woke up. 0 need you.").
// 2. Act countLabel at total = 0 is not "all approved".
// 3. Run "N handled before you woke up" banner only shows when h.count > 0.
// 4. Today with cards.length === 0 shows the set-aside empty line only when aside > 0, and a calm
//    "nothing needs you" state when there are zero problems.
import { describe, expect, test } from 'vitest'
import { HttpAgent } from '../agent/http/client'
import type { AgentData, Instant, Problem, StageIndex, ToolDetail } from '../agent/types'
import { handled, todayCopy, todayEmptyState } from './derive'
import type { Ctx } from './derive'

const stub = new HttpAgent()
const EMPTY = stub.read()
const NO_STATE = stub.getSnapshot()
const at = (iso: string): Instant => ({ iso, ms: Date.parse(iso) })
const tool = (name: string): ToolDetail => ({ name, desc: '', ex: [], read: '', draft: '', run: '', conn: '', site: '', since: at('2031-03-03T15:00:00.000Z') })
const makeProblem = (over: Partial<Problem> = {}): Problem => ({
  id: 'p1', sev: 'low', area: 'Stock', logos: ['shopify'], title: 'Low stock', sub: '10 left',
  cost: { minor: 10_000, currency: 'USD' }, costNote: 'at risk', next: 'Reorder',
  draft: { title: 'Reorder', lines: [], kind: 'Purchase order', summary: 'Send PO', cta: 'Approve', rev: true, money: false, customer: false },
  draftedAt: at('2031-03-03T15:00:00.000Z'),
  doneText: '', found: [], sources: [],
  ...over,
})

/** A ready brand with connected tools and zero problems today. */
const clearDay = (over: Partial<AgentData> = {}): AgentData => ({
  ...EMPTY,
  status: 'ready',
  meta: { ...EMPTY.meta, currentUser: { ...EMPTY.meta.currentUser, name: 'Ada Example' } },
  usage: { ...EMPTY.usage, cap: { minor: 40_000, currency: 'USD' } },
  tools: {
    ...EMPTY.tools,
    connected: ['shopify', 'shipbob'],
    readDone: 2,
    details: { shopify: tool('Shopify'), shipbob: tool('ShipBob') },
  },
  problems: [],
  ...over,
})

const ctxOf = (data: AgentData, S: StageIndex, setAside: Ctx['agent']['setAside'] = {}): Ctx => ({
  S,
  agent: { ...NO_STATE, setAside },
  data,
})

describe('Today empty-state copy and view state (zero problems)', () => {
  test('Run headline reads cleanly when h = 0 and n = 0 (no "0 need you" or "0 handled")', () => {
    const copy = todayCopy(ctxOf(clearDay(), 2))
    expect(copy.headline).toBe('Nothing needs you today.')
    expect(copy.headline).not.toMatch(/\b0\s+need/i)
    expect(copy.headline).not.toMatch(/\b0\s+handled/i)
    expect(copy.countLabel).toBe('')
  })

  test('Act countLabel is empty (not "all approved") when total === 0', () => {
    const copy = todayCopy(ctxOf(clearDay(), 1))
    expect(copy.headline).toBe('Nothing is waiting on you.')
    expect(copy.countLabel).not.toContain('approved')
    expect(copy.countLabel).toBe('')
  })

  test('Run overnight banner is hidden when h.count === 0', () => {
    const ctx = ctxOf(clearDay(), 2)
    expect(handled(ctx).count).toBe(0)
    expect(todayEmptyState(ctx).showHandledBanner).toBe(false)
  })

  test('cards.length === 0 distinguishes zero problems ("clear") from all problems set aside ("aside")', () => {
    const clear = todayEmptyState(ctxOf(clearDay(), 1))
    expect(clear.emptyKind).toBe('clear')
    expect(clear.asideCount).toBe(0)

    const allAside = todayEmptyState(ctxOf(
      clearDay({ problems: [makeProblem()] }),
      1,
      { p1: { reason: 'snoozed', at: at('2031-03-03T16:00:00.000Z'), by: 'u1', loggedAt: at('2031-03-03T16:00:00.000Z') } },
    ))
    expect(allAside.emptyKind).toBe('aside')
    expect(allAside.asideCount).toBe(1)
  })

  test('Watch with zero problems shows calm headline, empty countLabel and clear emptyKind', () => {
    const ctx = ctxOf(clearDay(), 0)
    const copy = todayCopy(ctx)
    expect(copy.headline).toBe('Nothing needs you today.')
    expect(copy.countLabel).toBe('')
    expect(todayEmptyState(ctx)).toEqual({ showHandledBanner: false, emptyKind: 'clear', asideCount: 0 })
  })

  test('Act with every problem set aside keeps "1 set aside" countLabel and aside emptyKind', () => {
    const ctx = ctxOf(
      clearDay({ problems: [makeProblem()] }),
      1,
      { p1: { reason: 'snoozed', at: at('2031-03-03T16:00:00.000Z'), by: 'u1', loggedAt: at('2031-03-03T16:00:00.000Z') } },
    )
    expect(todayCopy(ctx).countLabel).toBe('1 set aside')
    expect(todayEmptyState(ctx).emptyKind).toBe('aside')
  })

  test('Run handles mixed h / n / set-aside combinations cleanly', () => {
    const handledProblem = makeProblem({
      id: 'p-done', area: 'Orders', title: 'Fixed tag', sub: 'Done',
      cost: { minor: 0, currency: 'USD' }, costNote: 'saved', next: 'Done',
      draft: { title: 'Fix tag', lines: [], kind: 'Order update', summary: 'Updated', cta: 'Approve', rev: true, money: false, customer: false },
      draftedAt: at('2031-03-03T06:00:00.000Z'),
      done: { text: 'Fixed 1 order at {at:time}', times: { at: at('2031-03-03T06:00:00.000Z') } },
    })
    const waitingProblem = makeProblem({
      id: 'p-wait', sev: 'med',
      draft: { title: 'Reorder', lines: [], kind: 'Purchase order', summary: 'Send PO', cta: 'Approve', rev: true, money: true, customer: false },
      draftedAt: at('2031-03-03T07:00:00.000Z'),
      wait: 'Waiting on your approval',
    })

    // h > 0, n = 0: overnight banner shows and headline states handled count cleanly
    const handledOnly = ctxOf(clearDay({ problems: [handledProblem] }), 2)
    expect(todayEmptyState(handledOnly).showHandledBanner).toBe(true)
    expect(todayCopy(handledOnly).headline).toBe('1 handled before you woke up. Nothing needs you.')
    expect(todayCopy(handledOnly).countLabel).toBe('1 handled')

    // h = 0, n > 0: overnight banner stays hidden and headline omits "0 handled"
    const waitingOnly = ctxOf(clearDay({ problems: [waitingProblem] }), 2)
    expect(todayEmptyState(waitingOnly).showHandledBanner).toBe(false)
    expect(todayCopy(waitingOnly).headline).toBe('1 thing needs you today.')
    expect(todayCopy(waitingOnly).countLabel).toBe('1 waiting on you')

    // h = 0, n = 0, aside > 0: countLabel shows "1 set aside" and emptyKind is "aside"
    const runAside = ctxOf(
      clearDay({ problems: [waitingProblem] }),
      2,
      { 'p-wait': { reason: 'snoozed', at: at('2031-03-03T08:00:00.000Z'), by: 'u1', loggedAt: at('2031-03-03T08:00:00.000Z') } },
    )
    expect(todayEmptyState(runAside)).toEqual({ showHandledBanner: false, emptyKind: 'aside', asideCount: 1 })
    expect(todayCopy(runAside).countLabel).toBe('1 set aside')
  })
})
