// @vitest-environment jsdom
// A batch's full list (Stage 1 M3-U, N22, N33), rendered against a fake client. Ways it could break, written first:
//  - a page is skipped or read twice, the list stops before the count the card showed, or reads on past it;
//  - items that joined after the list opened are listed (and so seem covered by its Approve) or not mentioned;
//  - its Approve names another count than the card it opened on, or still shows once the card stopped waiting;
//  - an unclear item can't be settled on its own, or settling one names another item;
//  - a page that fails leaves the list half-read with no word and no way to try again; a search misses rows it hasn't read;
//  - the list reads again for items joining a waiting batch (its rev doesn't move), or not once the card moves on.
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ActionCard, ActionItem } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { TooltipProvider } from '@/components/ui/tooltip'

const fake = vi.hoisted(() => ({ actionItems: vi.fn() }))
vi.mock('../../agent', () => ({ agent: { actionItems: fake.actionItems } }))
vi.mock('../../state/store', () => ({ useUi: (pick: (s: { phone: boolean }) => unknown) => pick({ phone: false }) }))

const { BatchSheet } = await import('./BatchSheet')

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const AC = 'ac_AAAAAAAAAAAAAAAAAAAAAA'
const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const NONE = { allowOnce: false, alwaysAllow: false, approve: false, deny: false, undo: false, resolve: false, withdraw: false }
const lineOf = (n: number) => `Order ${3900 + n} (store-a): add VIP`
const rowOf = (n: number) => ({ ref: `#${3900 + n}`, change: 'add VIP' })
const batch = (n: number, o: Partial<ActionCard> = {}): ActionCard => ({
  id: AC, rev: 1, kind: 'exact', state: 'waiting', title: `Tag ${n} orders`, lines: [], tool: { accountId: 'shopify:store', label: 'Shopify' },
  records: n, reachesCustomer: false, reversible: true, guardrail: 'bulk', chatId: null, askedBy: 'm_A', askedAt: instant(1000), serverNow: instant(2000),
  can: { ...NONE, approve: true, deny: true }, nudgeAlways: false, approverKind: 'person',
  batch: {
    itemCount: n, firstLines: Array.from({ length: Math.min(10, n) }, (_, i) => lineOf(i + 1)), firstRows: Array.from({ length: Math.min(10, n) }, (_, i) => rowOf(i + 1)),
    totals: { records: n, units: n, unitsLabel: 'orders' },
  }, ...o,
})
/** The server's pages: 100 items after `after`, of `total`, each in `state`. */
const serve = (total: number, state: ActionItem['state'] = 'pending', extra: Partial<ActionItem> = {}) => fake.actionItems.mockImplementation(async (_id: string, after: number) => {
  const items: ActionItem[] = []
  for (let n = after + 1; n <= Math.min(total, after + 100); n++) items.push({ n, line: lineOf(n), row: rowOf(n), state, ...extra })
  const last = items.at(-1)?.n
  return { items, ...(last !== undefined && last < total ? { next: last } : {}) }
})

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { fake.actionItems.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = '' })

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() }) }
type Props = Parameters<typeof BatchSheet>[0]
const calls = { answers: [] as string[], resolves: [] as [string, number][], tips: [] as number[], closed: 0 }
const show = async (o: Partial<Props> & { card: ActionCard }) => {
  calls.answers = []; calls.resolves = []; calls.tips = []; calls.closed = 0
  const props: Props = {
    opened: o.card, whose: null, busy: false, refusal: null,
    onClose: () => { calls.closed++ }, onSawTip: n => { calls.tips.push(n) }, onAnswer: b => { calls.answers.push(b.label) }, onResolve: (out, n) => { calls.resolves.push([out, n]) },
    ...o,
  }
  await act(async () => root.render(createElement(TooltipProvider, null, createElement(BatchSheet, props))))
  await flush()
}
const sheet = () => document.querySelector('[data-batch-sheet]')!
const rows = () => [...document.querySelectorAll('[data-item]')]
const sheetButtons = () => [...document.querySelectorAll('[data-sheet-actions] button')].map(b => b.textContent)
const click = async (name: string) => {
  const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === name || x.textContent === name)
  if (!b) throw new Error(`no button ${name}`)
  await act(async () => { b.click() })
  await flush()
}

describe('the full list', () => {
  test('reads every page, in order, up to the count the card showed', async () => {
    serve(450)
    await show({ card: batch(450) })
    expect(fake.actionItems.mock.calls.map(c => c[1])).toEqual([0, 100, 200, 300, 400])
    expect(rows().map(r => Number(r.getAttribute('data-item')))).toEqual(Array.from({ length: 450 }, (_, i) => i + 1))
    expect(rows()[449].textContent).toBe(`${rowOf(450).ref}add VIP`)
    // A list's footer adds no totals line: the header says "450 orders" already.
    expect(sheet().querySelector('[data-sheet-totals]')).toBeNull()
    // No row numbers: the order number is the row's record.
    expect(rows()[0].textContent).toBe(`${rowOf(1).ref}add VIP`)
    expect(sheetButtons()).toEqual(['Approve all 450', 'No'])
    expect(calls.tips).toEqual([450])
  })
  test('items that joined after it opened are counted, never listed, and its Approve still names what it opened on', async () => {
    serve(453)
    await show({ card: batch(453), opened: batch(450) })
    expect(rows()).toHaveLength(450)
    expect(sheet().querySelector('[data-more-arrived]')?.textContent).toBe('3 more arrived while you looked. They wait for their own OK.')
    expect(sheetButtons()).toEqual(['Approve all 450', 'No'])
    await click('Approve all 450')
    expect(calls.answers).toEqual(['Approve all 450'])
    expect(calls.tips).toEqual([453])
  })
  test('a search filters the rows on their own words, reading every page first', async () => {
    serve(450)
    await show({ card: batch(450) })
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!
    expect(input.getAttribute('aria-label')).toBe('Search orders')
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, '4350')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(rows().map(r => r.getAttribute('data-item'))).toEqual(['450'])
  })
  test('with an observer, it reads a page each time the list\'s end shows, and no more', async () => {
    const seen: ((e: { isIntersecting: boolean }[]) => void)[] = []
    class FakeObserver { constructor(cb: (e: { isIntersecting: boolean }[]) => void) { seen.push(cb) } observe() {} disconnect() {} }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    try {
      serve(450)
      await show({ card: batch(450) })
      expect(fake.actionItems).not.toHaveBeenCalled()
      const atEnd = async (on: boolean) => { await act(async () => { seen.at(-1)!([{ isIntersecting: on }]) }); await flush() }
      await atEnd(true)
      await atEnd(false)
      expect(fake.actionItems.mock.calls.map(c => c[1])).toEqual([0])
      expect(rows()).toHaveLength(100)
      await atEnd(true)
      await atEnd(false)
      expect(fake.actionItems.mock.calls.map(c => c[1])).toEqual([0, 100])
      expect(rows()).toHaveLength(200)
    } finally { vi.unstubAllGlobals() }
  })
  test('issue 579: settling an item reads the rows again in place, so the list keeps its rows (and its scroll)', async () => {
    serve(3, 'needs_check', { result: 'It isn’t clear whether this went out.' })
    const unclear = batch(3, { state: 'needs_check', can: { ...NONE, resolve: true } })
    await show({ card: unclear })
    expect(rows()).toHaveLength(3)
    let seen = -1
    fake.actionItems.mockImplementationOnce(async () => { seen = rows().length; return { items: [{ n: 1, line: lineOf(1), row: rowOf(1), state: 'failed' }, { n: 2, line: lineOf(2), row: rowOf(2), state: 'needs_check' }, { n: 3, line: lineOf(3), row: rowOf(3), state: 'needs_check' }] } })
    await act(async () => root.render(createElement(TooltipProvider, null, createElement(BatchSheet, {
      card: { ...unclear, rev: 2 }, opened: unclear, whose: null, busy: false, refusal: null, onClose: () => {}, onSawTip: () => {}, onAnswer: () => {}, onResolve: () => {},
    }))))
    await flush()
    // The rows stayed while the page was read again, and the settled one shows its outcome.
    expect(seen).toBe(3)
    expect(rows().map(r => r.getAttribute('data-item-state'))).toEqual(['failed', 'needs_check', 'needs_check'])
  })
  test('its title is the card it opened on, and once that card moves on it follows the live one', async () => {
    serve(453)
    await show({ card: batch(453), opened: batch(450) })
    expect(document.querySelector('[data-batch-sheet] h2')?.textContent).toBe('Tag 450 orders')
    expect(sheet().querySelector('[data-more-arrived]')).not.toBeNull()
    // Answered elsewhere and sent: the outcomes load, "more arrived" goes, and so do the answers.
    serve(450, 'sent', { result: 'Sent.' })
    await act(async () => root.render(createElement(TooltipProvider, null, createElement(BatchSheet, {
      card: batch(450, { rev: 3, state: 'sent', can: NONE }), opened: batch(450), whose: null, busy: false, refusal: null,
      onClose: () => {}, onSawTip: () => {}, onAnswer: () => {}, onResolve: () => {},
    }))))
    await flush()
    expect(sheet().querySelector('[data-more-arrived]')).toBeNull()
    expect(sheetButtons()).toEqual([])
    expect(new Set(rows().map(r => r.getAttribute('data-item-state')))).toEqual(new Set(['sent']))
  })
  test('Try again reads the failed page under an observer too', async () => {
    const seen: ((e: { isIntersecting: boolean }[]) => void)[] = []
    class FakeObserver { constructor(cb: (e: { isIntersecting: boolean }[]) => void) { seen.push(cb) } observe() {} disconnect() {} }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    try {
      serve(5)
      fake.actionItems.mockRejectedValueOnce(new AgentError('unavailable', 'Inhouse is busy. Try again.'))
      await show({ card: batch(5) })
      await act(async () => { seen.at(-1)!([{ isIntersecting: true }]) })
      await flush()
      await act(async () => { seen.at(-1)!([{ isIntersecting: false }]) })
      await flush()
      expect(sheet().textContent).toContain('Inhouse is busy. Try again.')
      await click('Try again')
      expect(rows()).toHaveLength(5)
    } finally { vi.unstubAllGlobals() }
  })
  test('a table says its total once, in the footer; the header names the tool alone', async () => {
    serve(12)
    const table = batch(12, { batch: { itemCount: 12, firstLines: [], firstRows: [], heads: { ref: 'Item', change: 'Where and why', amount: 'Stock' }, totals: { records: 12, units: 900, unitsLabel: 'stock units' } } })
    await show({ card: table })
    expect(sheet().querySelector('h2 + p')?.textContent).toBe('Shopify')
    expect(sheet().querySelector('[data-sheet-totals]')?.textContent).toBe('12 changes · 900 stock units')
  })
  test('a card that moves on while a page is on its way: the dropped read starts over without waiting for a scroll', async () => {
    const seen: ((e: { isIntersecting: boolean }[]) => void)[] = []
    class FakeObserver { constructor(cb: (e: { isIntersecting: boolean }[]) => void) { seen.push(cb) } observe() {} disconnect() {} }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    try {
      let release: (() => void) | null = null
      fake.actionItems.mockImplementationOnce(() => new Promise(res => { release = () => res({ items: [], next: undefined }) }))
      serve(3, 'needs_check')
      const unclear = batch(3, { state: 'needs_check', can: { ...NONE, resolve: true } })
      await show({ card: unclear })
      await act(async () => { seen.at(-1)!([{ isIntersecting: true }]) })
      await flush()
      expect(fake.actionItems).toHaveBeenCalledTimes(1)
      const watchers = seen.length
      // The card moves on before that page answers: its answer is dropped, and the end is watched afresh.
      await act(async () => root.render(createElement(TooltipProvider, null, createElement(BatchSheet, {
        card: { ...unclear, rev: 2 }, opened: unclear, whose: null, busy: false, refusal: null, onClose: () => {}, onSawTip: () => {}, onAnswer: () => {}, onResolve: () => {},
      }))))
      await flush()
      expect(seen.length).toBeGreaterThan(watchers)
      await act(async () => { release!() })
      await act(async () => { seen.at(-1)!([{ isIntersecting: true }]) })
      await flush()
      expect(rows()).toHaveLength(3)
    } finally { vi.unstubAllGlobals() }
  })
  test('once the card stops waiting, its answers go', async () => {
    serve(12)
    await show({ card: batch(12, { rev: 2, state: 'denied', can: NONE }), opened: batch(12) })
    expect(sheetButtons()).toEqual([])
  })
  test('an unclear item is settled on its own, by its position', async () => {
    serve(3, 'needs_check', { result: 'It isn’t clear whether this went out.' })
    await show({ card: batch(3, { state: 'needs_check', can: { ...NONE, resolve: true } }) })
    expect(rows()[1].textContent).toContain('Needs a check')
    await click(`It didn't go out: ${rowOf(2).ref}`)
    expect(calls.resolves).toEqual([['failed', 2]])
  })
  test('a page that fails says so and can be tried again', async () => {
    serve(5)
    fake.actionItems.mockRejectedValueOnce(new AgentError('unavailable', 'Inhouse is busy. Try again.'))
    await show({ card: batch(5) })
    expect(sheet().textContent).toContain('Inhouse is busy. Try again.')
    await click('Try again')
    expect(rows()).toHaveLength(5)
  })
  test('reads again when the card moves on, never for items joining a waiting one', async () => {
    serve(12)
    await show({ card: batch(12) })
    const reads = fake.actionItems.mock.calls.length
    await show({ card: batch(14), opened: batch(12) })
    expect(fake.actionItems.mock.calls.length).toBe(reads)
  })
})
