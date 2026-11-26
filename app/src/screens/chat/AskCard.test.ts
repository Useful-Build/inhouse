// @vitest-environment jsdom
// The action card, rendered (Stage 1 M2-H). Ways it could break, written first:
//  - a button the card's `can` doesn't allow shows, or one it allows is missing (an admin seeing another's card gets none);
//  - an answer sends another id or rev than the card read, or the card doesn't show the answer's card after;
//  - the hold's countdown follows the browser's clock instead of the server's gap, or Undo is missing in the hold;
//  - a conflict leaves the old card up with no word, or a refusal says nothing;
//  - an `action.updated` for the card doesn't read it again, or one for another card (or an older rev) does;
//  - the chat's part (no `initial`) never reads the card, or a first read that failed can't be tried again;
//  - a settling card (its hold over, or going out) stops reading itself after a failed read or after a minute, and
//    freezes on "Going out now" with Undo (no server event is relied on);
//  - a refusal with no card in it leaves the old buttons up without reading the card again; a card gone offers buttons;
//  - Undo after Always allow doesn't say the permission stays; the keyboard is lost when the pressed button goes;
//  - someone else's card (an admin's view) speaks as if it were the viewer's.
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ActionCard } from '../../agent/types'
import { AgentError } from '../../agent/types'

const fake = vi.hoisted(() => ({
  action: vi.fn(),
  answerAction: vi.fn(),
  undoAction: vi.fn(),
  resolveAction: vi.fn(),
  listeners: new Set<(u: { actionId: string; rev: number }) => void>(),
  toasts: [] as string[],
  role: 'member' as string,
}))
vi.mock('../../agent', () => ({
  agent: {
    action: fake.action, answerAction: fake.answerAction, undoAction: fake.undoAction, resolveAction: fake.resolveAction,
    onActionUpdated: (l: (u: { actionId: string; rev: number }) => void) => { fake.listeners.add(l); return () => fake.listeners.delete(l) },
    subscribe: () => () => undefined,
    me: () => ({ role: fake.role }),
  },
}))
const badge = vi.hoisted(() => ({ reads: 0 }))
vi.mock('../../shell/asks-count', () => ({ readAsks: async () => { badge.reads++ } }))
vi.mock('../../state/store', () => ({ useUi: (pick: (s: { showToast: (t: string) => void }) => unknown) => pick({ showToast: (t: string) => { fake.toasts.push(t) } }) }))

const { AskCard, AskPart } = await import('./AskCard')
const { settleDelayMs } = await import('./ask-card')

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const AC = 'ac_AAAAAAAAAAAAAAAAAAAAAA'
const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const NOW = 1_800_000_000_000
const card = (o: Partial<ActionCard> = {}): ActionCard => ({
  id: AC, rev: 1, kind: 'ask', state: 'waiting', title: 'Add a tag to order 9001', lines: ['Tag: vip'],
  tool: { accountId: 'shopify:store', label: 'Shopify' }, records: 1, reachesCustomer: false, reversible: true,
  chatId: 'c_EEEEEEEEEEEEEEEEEEEEEE', askedBy: 'm_A', askedAt: instant(NOW - 1000), serverNow: instant(NOW),
  can: { allowOnce: true, alwaysAllow: true, approve: false, deny: true, undo: false, resolve: false }, nudgeAlways: false, ...o,
})
const NONE = { allowOnce: false, alwaysAllow: false, approve: false, deny: false, undo: false, resolve: false }

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  // The browser's clock is far from the server's: the countdown must not care.
  vi.setSystemTime(NOW + 3 * 60 * 60_000)
  for (const f of [fake.action, fake.answerAction, fake.undoAction, fake.resolveAction]) f.mockReset()
  fake.listeners.clear(); fake.toasts = []
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
// Keyed by the action, as Approvals' list is: another action is another card.
const show = async (props: Parameters<typeof AskCard>[0]) => { await act(async () => root.render(createElement(AskCard, { ...props, key: props.actionId }))); await flush() }
/** Each button's visible words (an icon's ligature text left out). */
const label = (b: HTMLButtonElement) => [...b.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('')
const buttons = () => [...host.querySelectorAll('button')].map(label)
const tick = async (ms: number) => { for (let i = 0; i < ms / 1000; i++) await act(async () => { vi.advanceTimersByTime(1000) }) }
const press = async (name: string) => {
  const b = [...host.querySelectorAll('button')].find(x => label(x) === name)
  if (!b) throw new Error(`no button ${label}: ${buttons().join(', ')}`)
  await act(async () => { b.click() })
  await flush()
}
const text = () => host.textContent ?? ''

describe('what the card offers', () => {
  test('an ask card offers Allow once, Always allow and No; nudged, Always allow comes first', async () => {
    await show({ actionId: AC, initial: card() })
    expect(buttons()).toEqual(['Allow once', 'Always allow', 'No'])
    expect(text()).toContain('Your Inhouse agent asks first')
    expect(text()).toContain('Tag: vip')
  })
  test('nudged, Always allow is first', async () => {
    await show({ actionId: AC, initial: card({ nudgeAlways: true }) })
    expect(buttons()).toEqual(['Always allow', 'Allow once', 'No'])
  })
  test('an exact card offers Approve and No, and says why', async () => {
    await show({ actionId: AC, initial: card({ kind: 'exact', guardrail: 'customer', reachesCustomer: true, can: { ...NONE, approve: true, deny: true } }) })
    expect(buttons()).toEqual(['Approve', 'No'])
    expect(text()).toContain('Needs your approval')
    expect(text()).toContain('Reaches customers')
  })
  test('someone who may not answer (an admin seeing the facts) gets no button', async () => {
    await show({ actionId: AC, initial: card({ chatId: null, can: NONE }) })
    expect(buttons()).toEqual([])
  })
  test('the Open link shows only for a chat this person may open', async () => {
    const opened: string[] = []
    await show({ actionId: AC, initial: card(), onOpenChat: id => opened.push(id) })
    await press('Open')
    expect(opened).toEqual(['c_EEEEEEEEEEEEEEEEEEEEEE'])
    await show({ actionId: 'ac_BBBBBBBBBBBBBBBBBBBBBB', initial: card({ id: 'ac_BBBBBBBBBBBBBBBBBBBBBB', chatId: null }), onOpenChat: id => opened.push(id) })
    expect(buttons()).not.toContain('Open')
  })
})

describe('answering', () => {
  test('Allow once sends the id and the rev read, then shows the hold counted from the server clock, with Undo', async () => {
    fake.answerAction.mockResolvedValue(card({ rev: 2, state: 'approved', sendAt: instant(NOW + 10_000), can: { ...NONE, undo: true } }))
    await show({ actionId: AC, initial: card() })
    await press('Allow once')
    expect(fake.answerAction).toHaveBeenCalledWith(AC, 1, 'once')
    expect(fake.toasts).toEqual(['Allowed once. It goes out in a few seconds.'])
    // The sidebar's badge reads again after an answer.
    expect(badge.reads).toBeGreaterThan(0)
    expect(host.querySelector('[role="timer"]')?.textContent).toBe('Goes out in 10 seconds')
    expect(buttons()).toEqual(['Undo'])
    await tick(3000)
    expect(host.querySelector('[role="timer"]')?.textContent).toBe('Goes out in 7 seconds')
  })
  test('Undo in the hold sends the rev and shows nothing went out', async () => {
    fake.undoAction.mockResolvedValue(card({ rev: 3, state: 'undone', can: NONE }))
    await show({ actionId: AC, initial: card({ rev: 2, state: 'approved', sendAt: instant(NOW + 10_000), can: { ...NONE, undo: true } }) })
    await press('Undo')
    expect(fake.undoAction).toHaveBeenCalledWith(AC, 2)
    expect(text()).toContain('You took it back. Nothing went out.')
    expect(buttons()).toEqual([])
  })
  test('Needs a check offers both answers to whoever may resolve, and sends the one picked', async () => {
    fake.resolveAction.mockResolvedValue(card({ rev: 5, state: 'failed', result: 'It didn’t go out.', can: NONE }))
    await show({ actionId: AC, initial: card({ rev: 4, state: 'needs_check', result: 'It isn’t clear whether this went out.', can: { ...NONE, resolve: true } }) })
    expect(buttons()).toEqual(['It went out', "It didn't go out"])
    await press("It didn't go out")
    expect(fake.resolveAction).toHaveBeenCalledWith(AC, 4, 'failed')
    expect(text()).toContain('It didn’t go out.')
  })
  test('a conflict shows the card as it is now and says so; a refusal says why and keeps the card', async () => {
    fake.answerAction.mockRejectedValueOnce(new AgentError('conflict', 'x', { current: card({ rev: 2, state: 'denied', can: NONE }) as unknown as Record<string, unknown> }))
    await show({ actionId: AC, initial: card() })
    await press('Always allow')
    expect(text()).toContain('This changed before your answer arrived. Here it is now.')
    expect(text()).toContain('You said no. Nothing went out.')
    expect(buttons()).toEqual([])
    fake.answerAction.mockRejectedValueOnce(new AgentError('forbidden', 'x'))
    fake.action.mockResolvedValueOnce(card({ id: 'ac_BBBBBBBBBBBBBBBBBBBBBB' }))
    await show({ actionId: 'ac_BBBBBBBBBBBBBBBBBBBBBB', initial: card({ id: 'ac_BBBBBBBBBBBBBBBBBBBBBB' }) })
    await press('No')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("You can't answer this one.")
    // Read again, so the buttons are the server's.
    expect(fake.action).toHaveBeenCalledWith('ac_BBBBBBBBBBBBBBBBBBBBBB')
    expect(buttons()).toEqual(['Allow once', 'Always allow', 'No'])
  })
  test('a conflict with no card in it reads the card again and shows it as it is now', async () => {
    fake.answerAction.mockRejectedValueOnce(new AgentError('conflict', 'x'))
    fake.action.mockResolvedValueOnce(card({ rev: 2, state: 'denied', can: NONE }))
    await show({ actionId: AC, initial: card() })
    await press('Allow once')
    expect(fake.action).toHaveBeenCalledTimes(1)
    expect(text()).toContain('This changed before your answer arrived.')
    expect(text()).toContain('You said no. Nothing went out.')
    expect(buttons()).toEqual([])
  })
  test('a card gone from the server (not found on the read after a refusal) offers no button', async () => {
    fake.answerAction.mockRejectedValueOnce(new AgentError('not_found', 'x'))
    fake.action.mockRejectedValueOnce(new AgentError('not_found', 'x'))
    await show({ actionId: AC, initial: card() })
    await press('Allow once')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("This isn't there any more.")
    expect(buttons()).toEqual([])
  })
  test('Undo after Always allow says the permission stays and where to remove it', async () => {
    fake.answerAction.mockResolvedValueOnce(card({ rev: 2, state: 'approved', sendAt: instant(NOW + 10_000), can: { ...NONE, undo: true } }))
    fake.undoAction.mockResolvedValueOnce(card({ rev: 3, state: 'undone', can: NONE }))
    await show({ actionId: AC, initial: card() })
    await press('Always allow')
    await press('Undo')
    expect(fake.toasts).toEqual(["Allowed. Your Inhouse agent won't ask next time.", 'Taken back. Nothing went out. Always allow stays on. Remove it in Settings, Always allowed.'])
    expect(text()).toContain('You took it back. Nothing went out.Always allow stays on. Remove it in Settings, Always allowed.')
  })
  test('a card gone while it settles stops saying it goes out, and offers nothing', async () => {
    fake.action.mockRejectedValueOnce(new AgentError('not_found', 'x'))
    await show({ actionId: AC, initial: card({ rev: 2, state: 'sending', can: { ...NONE, undo: true } }) })
    await tick(2000)
    await flush()
    expect(text()).toContain("No longer there")
    expect(text()).toContain("This isn't there any more.")
    expect(text()).not.toContain('going out')
    expect(text()).not.toContain('Going out')
    expect(buttons()).toEqual([])
    await tick(60_000)
    expect(fake.action).toHaveBeenCalledTimes(1)
  })
  test('one badge read per answer', async () => {
    fake.answerAction.mockResolvedValueOnce(card({ rev: 2, state: 'denied', can: NONE }))
    await show({ actionId: AC, initial: card() })
    const before = badge.reads
    await press('No')
    expect(badge.reads).toBe(before + 1)
  })
  test("the chat's part reads its card for a brand person; for the Inhouse team it says so and reads nothing", async () => {
    fake.action.mockResolvedValueOnce(card())
    await act(async () => root.render(createElement(AskPart, { actionId: AC })))
    await flush()
    expect(buttons()).toEqual(['Allow once', 'Always allow', 'No'])
    act(() => root.unmount()); root = createRoot(host)
    fake.role = 'inhouse'
    await act(async () => root.render(createElement(AskPart, { actionId: AC })))
    await flush()
    expect(text()).toBe("Your Inhouse agent proposed an action here. Only the brand's team can see it.")
    expect(fake.action).toHaveBeenCalledTimes(1)
    fake.role = 'member'
  })
  test('a double click sends once', async () => {
    let settle: (c: ActionCard) => void = () => {}
    fake.answerAction.mockReturnValueOnce(new Promise<ActionCard>(r => { settle = r }))
    await show({ actionId: AC, initial: card() })
    const b = [...host.querySelectorAll('button')].find(x => label(x) === 'Allow once')!
    await act(async () => { b.click(); b.click() })
    expect(fake.answerAction).toHaveBeenCalledTimes(1)
    await act(async () => { settle(card({ rev: 2, state: 'denied', can: NONE })) })
    await flush()
  })
  test('a card read again that moved by itself, and a conflict, read the badge again', async () => {
    fake.action.mockResolvedValueOnce(card({ rev: 3, state: 'needs_check', result: 'Unclear.', can: { ...NONE, resolve: true } }))
    await show({ actionId: AC, initial: card({ rev: 2, state: 'sending', can: NONE }) })
    const before = badge.reads
    await tick(2000)
    await flush()
    expect(badge.reads).toBe(before + 1)
    fake.resolveAction.mockRejectedValueOnce(new AgentError('conflict', 'x', { current: card({ rev: 3, state: 'needs_check', result: 'Unclear.', can: { ...NONE, resolve: true } }) as unknown as Record<string, unknown> }))
    await press('It went out')
    expect(badge.reads).toBe(before + 2)
  })
  test('after an answer the keyboard stays on the card (its title), not lost with the pressed button', async () => {
    fake.answerAction.mockResolvedValueOnce(card({ rev: 2, state: 'denied', can: NONE }))
    await show({ actionId: AC, initial: card() })
    await press('No')
    expect(document.activeElement).toBe(host.querySelector('h3'))
  })
  test("someone else's card says whose it is", async () => {
    await show({ actionId: AC, initial: card({ can: NONE }), whose: 'Dana Kim' })
    expect(text()).toContain('Waiting for Dana Kim')
    expect(text()).not.toContain('Your Inhouse agent asks first')
    await show({ actionId: 'ac_BBBBBBBBBBBBBBBBBBBBBB', initial: card({ id: 'ac_BBBBBBBBBBBBBBBBBBBBBB', state: 'denied', can: NONE }), whose: 'Dana Kim' })
    expect(text()).toContain('Dana Kim said no. Nothing went out.')
  })
})

describe('reading the card again', () => {
  test('the chat part reads its card; an action.updated for it reads it again, one for another card or an older rev does not', async () => {
    fake.action.mockResolvedValueOnce(card({ rev: 2 }))
    await show({ actionId: AC })
    expect(fake.action).toHaveBeenCalledTimes(1)
    expect(buttons()).toEqual(['Allow once', 'Always allow', 'No'])
    fake.action.mockResolvedValueOnce(card({ rev: 3, state: 'sent', result: 'Sent.', can: NONE }))
    await act(async () => { for (const l of fake.listeners) { l({ actionId: 'ac_BBBBBBBBBBBBBBBBBBBBBB', rev: 9 }); l({ actionId: AC, rev: 2 }) } })
    await flush()
    expect(fake.action).toHaveBeenCalledTimes(1)
    await act(async () => { for (const l of fake.listeners) l({ actionId: AC, rev: 3 }) })
    await flush()
    expect(fake.action).toHaveBeenCalledTimes(2)
    expect(text()).toContain('Sent.')
  })
  test('at the hold\'s end the card reads itself again until it settles', async () => {
    fake.action.mockResolvedValueOnce(card({ rev: 3, state: 'sent', result: 'Sent.', can: NONE }))
    await show({ actionId: AC, initial: card({ rev: 2, state: 'approved', sendAt: instant(NOW + 1000), can: { ...NONE, undo: true } }) })
    await tick(1000)
    expect(host.querySelector('[role="timer"]')?.textContent).toBe('Going out now')
    expect(fake.action).not.toHaveBeenCalled()
    await tick(2000)
    await flush()
    expect(fake.action).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Sent.')
    await tick(10_000)
    expect(fake.action).toHaveBeenCalledTimes(1)
  })
  test('a card that cannot be read says so, and Try again reads it again', async () => {
    fake.action.mockRejectedValueOnce(new AgentError('not_found', 'x'))
    await show({ actionId: AC })
    expect(text()).toBe("This isn't there any more.Try again")
    fake.action.mockResolvedValueOnce(card())
    await press('Try again')
    expect(fake.action).toHaveBeenCalledTimes(2)
    expect(buttons()).toEqual(['Allow once', 'Always allow', 'No'])
  })
  test('a settling card reads itself on through a failed read', async () => {
    fake.action.mockRejectedValueOnce(new AgentError('unavailable', 'x'))
    fake.action.mockResolvedValueOnce(card({ rev: 3, state: 'sent', result: 'Sent.', can: NONE }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await show({ actionId: AC, initial: card({ rev: 2, state: 'approved', sendAt: instant(NOW + 1000), can: { ...NONE, undo: true } }) })
    await tick(1000)
    await tick(2000)
    await flush()
    expect(fake.action).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Going out now')
    expect(warn).toHaveBeenCalledTimes(1)
    await tick(2000)
    await flush()
    expect(fake.action).toHaveBeenCalledTimes(2)
    expect(text()).toContain('Sent.')
    expect(buttons()).toEqual([])
    warn.mockRestore()
  })
  test('a send still going out after a minute is read on, more slowly, until it settles; then no more reads', async () => {
    const SLOW = 40
    fake.action.mockImplementation(async () => (fake.action.mock.calls.length >= SLOW
      ? card({ rev: 4, state: 'sent', result: 'Sent.', can: NONE })
      : card({ rev: 3, state: 'sending', can: NONE })))
    await show({ actionId: AC, initial: card({ rev: 3, state: 'sending', can: NONE }) })
    expect(text()).toContain("It's going out now.")
    let waited = 0
    for (let i = 0; i < SLOW; i++) {
      waited += settleDelayMs(i)
      await tick(settleDelayMs(i))
      await flush()
      expect(fake.action).toHaveBeenCalledTimes(i + 1)
    }
    // Past the old 30 reads (a minute), and slower once past the first 30 s.
    expect(waited).toBeGreaterThan(5 * 60_000)
    expect(settleDelayMs(SLOW)).toBe(30_000)
    expect(text()).toContain('Sent.')
    await tick(120_000)
    expect(fake.action).toHaveBeenCalledTimes(SLOW)
  })
})
