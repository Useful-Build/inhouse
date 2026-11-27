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
  id: AC, rev: 1, kind: 'exact', state: 'waiting', title: `${n} changes in Shopify (store-a)`, lines: [], tool: { accountId: 'shopify:store', label: 'Shopify' },
  records: n, reachesCustomer: false, reversible: true, guardrail: 'bulk', chatId: null, askedBy: 'm_A', askedAt: instant(1000), serverNow: instant(2000),
  can: { ...NONE, approve: true, deny: true }, nudgeAlways: false, approverKind: 'person',
  batch: {
    itemCount: n, firstLines: Array.from({ length: Math.min(10, n) }, (_, i) => lineOf(i + 1)), firstRows: Array.from({ length: Math.min(10, n) }, (_, i) => rowOf(i + 1)),
    heads: { ref: 'Order', change: 'Change', amount: 'Amount' }, totals: { records: n, units: n, unitsLabel: 'orders' },
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
    expect(sheet().querySelector('[data-sheet-totals]')?.textContent).toBe('450 orders')
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
