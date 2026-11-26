// @vitest-environment jsdom
// The sidebar's Approvals badge, its Stage 1 M2-H part. Ways it could break, written first:
//  - it counts a card the viewer can't act on (an admin's view of a member's card), one in its hold or settled, or a
//    question that is no longer open; or it misses a waiting card or a "Needs a check" its viewer may resolve;
//  - it reads for the Inhouse team (routes 120 and 140 refuse them) or before `me()` is in;
//  - a failed read of one list zeroes the other's number;
//  - an `action.updated`, a focus or an answer doesn't read again;
//  - an answer that lands while a read is out is counted from that older read (the badge keeps the old number);
//  - a question that arrives (a new notice in the bell's list, after a run) isn't counted until the next focus;
//  - a socket that comes back live, or a tab shown again, doesn't read again.
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ActionCard, Question } from '../agent/types'

const fake = vi.hoisted(() => ({
  actions: vi.fn(), questions: vi.fn(), role: 'admin' as string | null, notifications: [] as unknown[],
  meListeners: new Set<() => void>(), actionListeners: new Set<(u: { actionId: string; rev: number }) => void>(),
  linkListeners: new Set<(s: string) => void>(),
}))
vi.mock('../agent', () => ({
  agent: {
    actions: fake.actions, questions: fake.questions,
    me: () => (fake.role ? { role: fake.role } : null),
    listNotifications: () => fake.notifications,
    subscribe: (l: () => void) => { fake.meListeners.add(l); return () => fake.meListeners.delete(l) },
    onActionUpdated: (l: (u: { actionId: string; rev: number }) => void) => { fake.actionListeners.add(l); return () => fake.actionListeners.delete(l) },
    onLink: (l: (s: string) => void) => { fake.linkListeners.add(l); return () => fake.linkListeners.delete(l) },
  },
}))

const { countAsks, publishAsks, readAsks, useAsksCount } = await import('./asks-count')

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const NONE = { allowOnce: false, alwaysAllow: false, approve: false, deny: false, undo: false, resolve: false }
let n = 0
const card = (o: Partial<ActionCard> = {}): ActionCard => ({
  id: `ac_${String(++n).padStart(22, 'A')}`, rev: 1, kind: 'ask', state: 'waiting', title: 'Add a tag', lines: [],
  tool: { accountId: 'shopify:store', label: 'Shopify' }, records: 1, reachesCustomer: false, reversible: true, chatId: null,
  askedBy: 'm_A', askedAt: instant(1), serverNow: instant(2), can: { ...NONE, allowOnce: true, alwaysAllow: true, deny: true }, nudgeAlways: false, ...o,
})
const question = (o: Partial<Question> = {}): Question => ({
  id: `q_${String(++n).padStart(22, 'C')}`, state: 'open', question: 'Which?', options: ['A', 'B'], chatId: null, askedAt: instant(1), expiresAt: instant(9),
  answer: null, answeredBy: null, answeredAt: null, ...o,
})

describe('what counts', () => {
  test('a card the viewer can answer or resolve, and an open question; nothing else', () => {
    expect(countAsks([
      card(),
      card({ kind: 'exact', can: { ...NONE, approve: true, deny: true } }),
      card({ state: 'needs_check', can: { ...NONE, resolve: true } }),
      // An admin's view of a member's card, a card in its hold, a settled one, a check someone else resolves.
      card({ can: NONE }), card({ state: 'approved', can: { ...NONE, undo: true } }), card({ state: 'sent', can: NONE }), card({ state: 'needs_check', can: NONE }),
    ], [question(), question({ state: 'answered', answer: 'A' }), question({ state: 'expired' })])).toBe(4)
  })
})

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let shown: number[] = []
function Badge() { shown.push(useAsksCount()); return null }
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve() })

beforeEach(async () => {
  fake.actions.mockReset(); fake.questions.mockReset(); fake.role = 'admin'; fake.meListeners.clear(); fake.actionListeners.clear(); fake.linkListeners.clear(); fake.notifications = []
  shown = []
  // Each case starts from an empty badge.
  publishAsks([], [])
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('the badge', () => {
  test('reads both lists for a brand person, and reads again on action.updated and on focus', async () => {
    fake.actions.mockResolvedValue([card(), card({ can: NONE })]); fake.questions.mockResolvedValue([question()])
    await act(async () => root.render(createElement(Badge)))
    await flush()
    expect(shown.at(-1)).toBe(2)
    expect(fake.actions).toHaveBeenCalledWith({ states: ['waiting', 'needs_check'] })
    fake.actions.mockResolvedValue([])
    await act(async () => { for (const l of fake.actionListeners) l({ actionId: 'ac_X', rev: 2 }) })
    await flush()
    expect(shown.at(-1)).toBe(1)
    fake.questions.mockResolvedValue([])
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(shown.at(-1)).toBe(0)
  })
  test('reads again when the socket is live again and when the tab is shown; not on a link that isn\'t live, nor when hidden', async () => {
    fake.actions.mockResolvedValue([]); fake.questions.mockResolvedValue([])
    await act(async () => root.render(createElement(Badge)))
    await flush()
    const reads = () => fake.questions.mock.calls.length
    const start = reads()
    await act(async () => { for (const l of fake.linkListeners) l('held') })
    await flush()
    expect(reads()).toBe(start)
    await act(async () => { for (const l of fake.linkListeners) l('live') })
    await flush()
    expect(reads()).toBe(start + 1)
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(reads()).toBe(start + 1)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(reads()).toBe(start + 2)
    visibility.mockRestore()
  })
  test('one list failing keeps the other\'s number and its own last one', async () => {
    fake.actions.mockResolvedValue([card()]); fake.questions.mockResolvedValue([question(), question()])
    await act(async () => root.render(createElement(Badge)))
    await flush()
    expect(shown.at(-1)).toBe(3)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.questions.mockRejectedValue(new Error('route 140 is not there'))
    fake.actions.mockResolvedValue([card(), card()])
    await act(async () => { await readAsks() })
    expect(shown.at(-1)).toBe(4)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
  test('an answer while a read is out: one more read runs after it (shared by every ask meanwhile), so the badge ends at the new number', async () => {
    let release: (v: ActionCard[]) => void = () => {}
    fake.actions.mockReturnValueOnce(new Promise<ActionCard[]>(r => { release = r }))
    fake.questions.mockResolvedValue([])
    const first = readAsks()
    // The answer lands on the server, then two asks to read again come while the first read is out.
    fake.actions.mockResolvedValue([])
    const second = readAsks()
    expect(readAsks()).toBe(second)
    expect(fake.actions).toHaveBeenCalledTimes(1)
    release([card()])
    await act(async () => { await first; await second })
    expect(fake.actions).toHaveBeenCalledTimes(2)
    await act(async () => root.render(createElement(Badge)))
    await flush()
    expect(shown.at(-1)).toBe(0)
  })
  test("an older read still out when Approvals publishes its own doesn't overwrite it", async () => {
    fake.actions.mockResolvedValue([]); fake.questions.mockResolvedValue([])
    await act(async () => root.render(createElement(Badge)))
    await flush()
    expect(shown.at(-1)).toBe(0)
    let release: (v: ActionCard[]) => void = () => {}
    fake.actions.mockReturnValueOnce(new Promise<ActionCard[]>(r => { release = r }))
    const old = readAsks()
    // Approvals' newer read: one card waits.
    await act(async () => { publishAsks([card()], []) })
    expect(shown.at(-1)).toBe(1)
    await act(async () => { release([card(), card(), card()]); await old })
    await flush()
    expect(shown.at(-1)).toBe(1)
  })
  test('a change in the bell\'s list (a new notice, such as a question waiting) reads again; the same list does not', async () => {
    fake.actions.mockResolvedValue([]); fake.questions.mockResolvedValue([])
    await act(async () => root.render(createElement(Badge)))
    await flush()
    expect(shown.at(-1)).toBe(0)
    const reads = fake.questions.mock.calls.length
    // Another change in the client's state, the bell's list the same: no read.
    await act(async () => { for (const l of fake.meListeners) l() })
    await flush()
    expect(fake.questions).toHaveBeenCalledTimes(reads)
    fake.questions.mockResolvedValue([question()])
    fake.notifications = [{ id: 'qw_q_1' }]
    await act(async () => { for (const l of fake.meListeners) l() })
    await flush()
    expect(fake.questions).toHaveBeenCalledTimes(reads + 1)
    expect(shown.at(-1)).toBe(1)
  })
  test('nothing is read, and nothing counts, for the Inhouse team or before me() is in', async () => {
    fake.actions.mockResolvedValue([card()]); fake.questions.mockResolvedValue([])
    fake.role = null
    await act(async () => root.render(createElement(Badge)))
    await flush()
    fake.role = 'inhouse'
    await act(async () => { for (const l of fake.meListeners) l() })
    await flush()
    expect(fake.actions).not.toHaveBeenCalled()
    expect(shown.every(x => x === 0)).toBe(true)
    fake.role = 'member'
    await act(async () => { for (const l of fake.meListeners) l() })
    await flush()
    expect(shown.at(-1)).toBe(1)
  })
})
