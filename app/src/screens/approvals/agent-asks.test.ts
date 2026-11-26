// @vitest-environment jsdom
// Approvals' questions and actions, and the permissions screens (Stage 1 M2-H), rendered against a fake client. Ways
// they could break, written first:
//  - the demo (empty lists) shows a heading, an empty state or anything else on Approvals or Activity;
//  - a question's answer isn't the option's text, or someone else's answer, an expiry or a lost delivery says nothing
//    (and the lost delivery can't be sent again);
//  - Remove shows on a permission whose `can.remove` is false, removes without asking, or sends another rev;
//  - Activity offers "Stop allowing this" with no permission behind it, or removes one that doesn't cover the action;
//  - a failed read says nothing.
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ActionCard, Permission, Question } from '../../agent/types'
import { AgentError } from '../../agent/types'

const fake = vi.hoisted(() => ({
  actions: vi.fn(), questions: vi.fn(), answerQuestion: vi.fn(), permissions: vi.fn(), removePermission: vi.fn(),
  toasts: [] as string[], opened: [] as string[], settings: [] as string[],
}))
vi.mock('../../agent', () => ({
  agent: {
    actions: fake.actions, questions: fake.questions, answerQuestion: fake.answerQuestion, permissions: fake.permissions, removePermission: fake.removePermission,
    action: vi.fn(), answerAction: vi.fn(), undoAction: vi.fn(), resolveAction: vi.fn(), onActionUpdated: () => () => undefined,
    me: () => ({ memberId: 'm_Admin' }),
  },
}))
const badge = vi.hoisted(() => ({ reads: 0, published: [] as number[][] }))
vi.mock('../../shell/asks-count', () => ({
  readAsks: async () => { badge.reads++ },
  publishAsks: (a: unknown[], q: unknown[]) => { badge.published.push([a.length, q.length]) },
}))
vi.mock('../../state/store', () => {
  const ui = {
    showToast: (t: string) => { fake.toasts.push(t) }, openChat: (id: string) => { fake.opened.push(id) }, openSettings: (t: string) => { fake.settings.push(t) },
  }
  return {
    useUi: (pick: (s: typeof ui) => unknown) => pick(ui),
    useCtx: () => ({ data: { people: { members: [{ id: 'm_Dana', name: 'Dana Kim' }] } } }),
  }
})

// The app's clock is set by the agent's entry, which this test fakes: set it here.
const { setNow } = await import('../../state/display')
setNow(() => 5000)
const { AgentAsks } = await import('./AgentAsks')
const { Permissions } = await import('../settings/Permissions')
const { ActionRows } = await import('../activity/ActionRows')

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const NONE = { allowOnce: false, alwaysAllow: false, approve: false, deny: false, undo: false, resolve: false }
const card = (o: Partial<ActionCard> = {}): ActionCard => ({
  id: 'ac_AAAAAAAAAAAAAAAAAAAAAA', rev: 1, kind: 'ask', state: 'waiting', title: 'Add a tag to order 9001', lines: ['Tag: vip'],
  tool: { accountId: 'shopify:store', label: 'Shopify' }, records: 1, reachesCustomer: false, reversible: true,
  chatId: null, askedBy: 'm_Admin', askedAt: instant(1000), serverNow: instant(2000), can: { ...NONE, allowOnce: true, alwaysAllow: true, deny: true }, nudgeAlways: false, ...o,
})
const question = (o: Partial<Question> = {}): Question => ({
  id: 'q_CCCCCCCCCCCCCCCCCCCCCC', state: 'open', question: 'Which box size?', options: ['Small', 'Large'], chatId: 'c_EEEEEEEEEEEEEEEEEEEEEE',
  askedAt: instant(1000), expiresAt: instant(9000), answer: null, answeredBy: null, answeredAt: null, ...o,
})
const permission = (o: Partial<Permission> = {}): Permission => ({
  id: 'pg_BBBBBBBBBBBBBBBBBBBBBB', rev: 4, holder: { kind: 'member', memberId: 'm_Admin' }, operation: 'shopify.order.tag_add', title: 'Add tags to orders',
  tool: { accountId: 'shopify:store', label: 'Shopify' }, scope: 'Store A', perDay: 50, grantedBy: 'm_Admin', grantedAt: instant(1000), can: { remove: true }, ...o,
})

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  for (const f of [fake.actions, fake.questions, fake.answerQuestion, fake.permissions, fake.removePermission]) f.mockReset()
  fake.toasts = []; fake.opened = []; fake.settings = []; badge.reads = 0; badge.published = []
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = '' })

const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })
const show = async (el: Parameters<typeof root.render>[0]) => { await act(async () => root.render(el)); await flush() }
const label = (b: HTMLButtonElement) => b.getAttribute('aria-label') ?? [...b.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('')
const buttons = (within: ParentNode = host) => [...within.querySelectorAll('button')].map(label)
const press = async (name: string, within: ParentNode = document.body) => {
  const b = [...within.querySelectorAll('button')].find(x => label(x) === name || x.textContent === name)
  if (!b) throw new Error(`no button ${name}: ${buttons(within).join(', ')}`)
  await act(async () => { b.click() })
  await flush()
}

describe('the demo looks as before', () => {
  test('with no actions or questions, Approvals adds nothing', async () => {
    fake.actions.mockResolvedValue([]); fake.questions.mockResolvedValue([])
    await show(createElement(AgentAsks))
    expect(host.innerHTML).toBe('')
    expect(fake.actions).toHaveBeenCalledWith({ states: ['waiting', 'approved', 'sending', 'needs_check'] })
  })
  test('with no actions, Activity adds nothing', async () => {
    fake.actions.mockResolvedValue([]); fake.permissions.mockResolvedValue([])
    await show(createElement(ActionRows, { needle: '' }))
    expect(host.innerHTML).toBe('')
  })
})

describe('Approvals: questions and actions', () => {
  test('both sections show with their counts; a failed read says so and reads again', async () => {
    fake.actions.mockResolvedValue([card()]); fake.questions.mockResolvedValue([question()])
    await show(createElement(AgentAsks))
    expect(host.querySelector('#agent-questions')?.textContent).toContain('Questions for you')
    expect(host.querySelector('#agent-actions')?.textContent).toContain('Actions for you')
    // What Approvals read goes to the sidebar's badge too.
    expect(badge.published.at(-1)).toEqual([1, 1])
    expect(host.querySelectorAll('[data-question]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-action-card]')).toHaveLength(1)
    act(() => root.unmount()); root = createRoot(host)
    fake.questions.mockRejectedValueOnce(new AgentError('unavailable', 'x'))
    await show(createElement(AgentAsks))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load what your Inhouse agent asked you.")
    await press('Retry', host)
    expect(host.querySelectorAll('[data-question]')).toHaveLength(1)
  })
  test('an answer is the option itself; the card then says what was answered', async () => {
    fake.actions.mockResolvedValue([]); fake.questions.mockResolvedValue([question()])
    fake.answerQuestion.mockResolvedValue(question({ state: 'answered', answer: 'Large', answeredBy: 'm_Admin', answeredAt: instant(3000) }))
    await show(createElement(AgentAsks))
    expect(buttons()).toEqual(['Open the chat: Which box size?', 'Small', 'Large'])
    await press('Large', host)
    expect(fake.answerQuestion).toHaveBeenCalledWith('q_CCCCCCCCCCCCCCCCCCCCCC', 'Large')
    expect(host.textContent).toContain('You answered: Large')
    expect(badge.reads).toBeGreaterThan(0)
    expect(buttons()).toEqual(['Open the chat: Which box size?'])
    await press('Open the chat: Which box size?', host)
    expect(fake.opened).toEqual(['c_EEEEEEEEEEEEEEEEEEEEEE'])
  })
  test('answered first by someone else, or expired: the card says so', async () => {
    fake.actions.mockResolvedValue([]); fake.questions.mockResolvedValue([question()])
    fake.answerQuestion.mockRejectedValueOnce(new AgentError('conflict', 'x', { current: question({ state: 'answered', answer: 'Small', answeredBy: 'm_Dana', answeredAt: instant(3000) }) as unknown as Record<string, unknown> }))
    await show(createElement(AgentAsks))
    await press('Large', host)
    expect(host.textContent).toContain('Someone answered first: Small')
  })
  test('kept but not delivered: the same answer can be sent again', async () => {
    fake.actions.mockResolvedValue([]); fake.questions.mockResolvedValue([question()])
    fake.answerQuestion.mockRejectedValueOnce(new AgentError('unavailable', 'x')).mockResolvedValueOnce(question({ state: 'answered', answer: 'Small', answeredBy: 'm_Admin', answeredAt: instant(3000) }))
    await show(createElement(AgentAsks))
    await press('Small', host)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Your answer is saved, but the chat couldn't be reached.")
    await press('Try again', host)
    expect(fake.answerQuestion.mock.calls).toEqual([['q_CCCCCCCCCCCCCCCCCCCCCC', 'Small'], ['q_CCCCCCCCCCCCCCCCCCCCCC', 'Small']])
    expect(host.textContent).toContain('You answered: Small')
  })
})

describe('Settings: Always allowed', () => {
  test('each permission with whose it is; Remove only where allowed, after asking, at the rev read', async () => {
    fake.permissions.mockResolvedValue([permission(), permission({ id: 'pg_DDDDDDDDDDDDDDDDDDDDDD', holder: { kind: 'member', memberId: 'm_Dana' }, title: 'Post in a channel', can: { remove: false } })])
    fake.removePermission.mockResolvedValue([permission({ id: 'pg_DDDDDDDDDDDDDDDDDDDDDD', holder: { kind: 'member', memberId: 'm_Dana' }, title: 'Post in a channel', can: { remove: false } })])
    await show(createElement(Permissions))
    expect(host.textContent).toContain('Shopify · Store A · Up to 50 a day')
    expect(host.textContent).toContain('For Dana Kim')
    expect(buttons()).toEqual(['Remove: Add tags to orders'])
    await press('Remove: Add tags to orders', host)
    expect(fake.removePermission).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Your Inhouse agent will ask before it does this again.')
    await press('Remove', document.body.querySelector('[role="alertdialog"], [role="dialog"]') ?? document.body)
    expect(fake.removePermission).toHaveBeenCalledWith('pg_BBBBBBBBBBBBBBBBBBBBBB', 4)
    expect(host.textContent).not.toContain('Add tags to orders')
    expect(fake.toasts).toEqual(['Removed. Your Inhouse agent will ask first from now on.'])
  })
  test('none yet: an empty line; a stale Remove says so and reads again', async () => {
    fake.permissions.mockResolvedValueOnce([]).mockResolvedValueOnce([permission()]).mockResolvedValueOnce([permission({ rev: 5 })])
    await show(createElement(Permissions))
    expect(host.textContent).toContain('Nothing yet. When you choose Always allow on an action, it shows here.')
    act(() => root.unmount()); root = createRoot(host)
    fake.removePermission.mockRejectedValueOnce(new AgentError('conflict', 'x'))
    await show(createElement(Permissions))
    await press('Remove: Add tags to orders', host)
    await press('Remove', document.body.querySelector('[role="alertdialog"], [role="dialog"]') ?? document.body)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('This permission changed first. Here it is now.')
    expect(fake.permissions).toHaveBeenCalledTimes(3)
  })
})

describe('Activity: Stop allowing this', () => {
  test('offered where one removable permission covers the action, removing that one; elsewhere not', async () => {
    fake.actions.mockResolvedValue([card({ state: 'sent', result: 'Sent.', can: NONE }), card({ id: 'ac_FFFFFFFFFFFFFFFFFFFFFF', state: 'denied', title: 'Post in #ops', tool: { accountId: 'slack:workspace', label: 'Slack' }, can: NONE })])
    fake.permissions.mockResolvedValue([permission()])
    fake.removePermission.mockResolvedValue([])
    await show(createElement(ActionRows, { needle: '' }))
    expect(host.textContent).toContain('Add a tag to order 9001. Sent.')
    expect(host.textContent).toContain('Post in #ops. You said no. Nothing went out.')
    expect(buttons()).toEqual(['Stop allowing this: Add a tag to order 9001'])
    await press('Stop allowing this: Add a tag to order 9001', host)
    expect(document.body.textContent).toContain('Add tags to orders. Your Inhouse agent will ask before it does this again.')
    await press('Remove', document.body.querySelector('[role="alertdialog"], [role="dialog"]') ?? document.body)
    expect(fake.removePermission).toHaveBeenCalledWith('pg_BBBBBBBBBBBBBBBBBBBBBB', 4)
    expect(buttons()).toEqual([])
  })
  test('two permissions on the tool: the row points to Settings instead; the search narrows the rows', async () => {
    fake.actions.mockResolvedValue([card({ state: 'sent', result: 'Sent.', can: NONE })])
    fake.permissions.mockResolvedValue([permission(), permission({ id: 'pg_DDDDDDDDDDDDDDDDDDDDDD', title: 'Cancel orders' })])
    await show(createElement(ActionRows, { needle: '' }))
    await press('Stop allowing this: Add a tag to order 9001', host)
    expect(fake.settings).toEqual(['you-permissions'])
    expect(fake.removePermission).not.toHaveBeenCalled()
    await show(createElement(ActionRows, { needle: 'nothing like it' }))
    expect(host.innerHTML).toBe('')
  })
})
