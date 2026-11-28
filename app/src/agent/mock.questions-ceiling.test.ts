// The demo catch-up's PR 3 through the client the screens use: the agent's questions, the follow-up it adds once a card is
// settled (the late answer), a batch that partly went out, the "View as" switch, What the agent can do, the alerts channel's
// standing permission and the seeded chats for the other write cards. Ways it can fail, written first:
//  1. a question isn't listed oldest first, is listed where the scenario shows no actions, takes an answer that isn't one of
//     its options, takes a second answer, or comes back after Reset demo; the bell says nothing of it;
//  2. answering a card (or a question) leaves its chat as it was: no follow-up line, a follow-up before the card went out, the
//     wrong words for a card that was said no to, a note on a question's follow-up (a question's resume shows none), a
//     position that repeats or goes back;
//  3. the batch that partly went out lists every item as sent, or hides the failed ones from the full list, or says another count;
//  4. as a member the person sees a teammate's card, can answer the admins card they asked, or can't take it back; as an
//     admin the refund isn't a teammate's, theirs to answer; a member reads the ceiling or others' permissions;
//  5. What the agent can do is editable in the demo, lists fewer than the seven operations, or a change goes through;
//  6. an admin's alerts mark gives no standing permission (or the Inhouse team's/a member's does), moving it leaves the old one,
//     or Always allowed doesn't list it for the whole team;
//  7. a seeded chat's card, step or refusal names something the demo doesn't have.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatPageSchema } from '../../shared/contract/chats'
import { CeilingListSchema } from '../../shared/contract/ceiling'
import { QuestionSchema } from '../../shared/contract/questions'
import { AgentError } from './types'
import type { StoredMessage } from './types'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
const { MockAgent } = await import('./mock')
type Agent = InstanceType<typeof MockAgent>
const fresh = () => { store.clear(); return new MockAgent() }
const errorOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => e)
afterEach(async () => { vi.useRealTimers(); (await import('./mock-notify')).demoNotify.reset() })

const WHOLESALE = 'ac_demoWholesaleTag000000'
const POST = 'ac_demoOpsAlertsPost00000'
const REFUND = 'ac_demoDanaRefund00000000'
const MEMBER_REFUND = 'ac_demoSamRefund000000000'
const LOYALTY = 'ac_demoLoyaltyBatch000000'
const CHAT_Q = 'q_demoWholesaleHeadsUp00'
const ROUTINE_Q = 'q_demoMorningStuckOrders'
// The server's words (server/outbox/words.ts, shared/server-turn-text.ts; server/outbox/demo-parity.test.ts holds the data equal).
const FAILED_TEXT = 'It didn’t go out.'
const ACTION_CARRIED_ON_TEXT = 'Your Inhouse agent went on once the action was settled.'

const textOf = (m: StoredMessage) => (m.role === 'agent' && m.part.type === 'text' ? m.part.text : m.role === 'event' ? m.text : '')
const lines = async (a: Agent, chat = 'order-tags') => (await a.getChat(chat)).messages.slice().reverse()
const lastTwo = (m: StoredMessage[]) => m.slice(-2).map(x => [x.role, textOf(x)])

describe('the agent\'s questions (A6)', () => {
  it('two are open, oldest first: one in a chat, one a routine asked its creator (no chat for an admin); each parses', async () => {
    const a = fresh()
    const qs = await a.questions()
    expect(qs.map(q => [q.id, q.chatId, q.state])).toEqual([[CHAT_Q, 'order-tags', 'open'], [ROUTINE_Q, null, 'open']])
    for (const q of qs) { QuestionSchema.parse(q); expect(q.options.length).toBeGreaterThanOrEqual(2); expect(q.expiresAt.ms - q.askedAt.ms).toBe(7 * 86_400_000) }
    expect(qs[0]!.askedAt.ms).toBeLessThan(qs[1]!.askedAt.ms)
  })

  it('no question where the scenario shows no actions', async () => {
    const a = fresh()
    a.setDemo({ scenario: 'Cap reached' })
    expect(await a.questions()).toEqual([])
    expect(await errorOf(a.answerQuestion(CHAT_Q, 'Every wholesale order'))).toMatchObject({ code: 'not_found' })
  })

  it('an answer is one of the options exactly; it closes the question; a second answer is a conflict with the question as it is now', async () => {
    const a = fresh()
    expect(await errorOf(a.answerQuestion(CHAT_Q, 'Maybe'))).toMatchObject({ code: 'invalid' })
    expect(await errorOf(a.answerQuestion('q_AAAAAAAAAAAAAAAAAAAAAA', 'Yes'))).toMatchObject({ code: 'not_found' })
    const done = await a.answerQuestion(CHAT_Q, 'Only over $1,000')
    expect(done).toMatchObject({ state: 'answered', answer: 'Only over $1,000', answeredBy: 'm_sam' })
    QuestionSchema.parse(done)
    const again = await errorOf(a.answerQuestion(CHAT_Q, 'Every wholesale order'))
    expect(again).toBeInstanceOf(AgentError)
    expect(again).toMatchObject({ code: 'conflict', current: { id: CHAT_Q, state: 'answered', answer: 'Only over $1,000' } })
    expect((await a.questions()).map(q => q.id)).toEqual([ROUTINE_Q])
    a.reset()
    expect((await a.questions()).map(q => q.id)).toEqual([CHAT_Q, ROUTINE_Q])
  })

  it('the bell says "A question is waiting", unread and waiting on this person, opening Approvals, in the Normal scenario only', () => {
    const a = fresh()
    expect(a.listNotifications().find(n => n.text === 'A question is waiting')).toMatchObject({ unread: true, waiting: true, who: 'Inhouse', link: { to: 'page', page: 'approvals' } })
    a.setDemo({ scenario: 'Tool disconnected' })
    expect(a.listNotifications().some(n => n.text === 'A question is waiting')).toBe(false)
  })
})

describe('the late answer: the agent picks the chat up again (A5)', () => {
  it('the chat the agent keeps shows its three cards and the question; no follow-up before a card is settled', async () => {
    const a = fresh()
    const page = await a.getChat('order-tags')
    ChatPageSchema.parse(page)
    const all = page.messages.slice().reverse()
    expect(all.map(m => m.pos)).toEqual(all.map((_, i) => i))
    expect(all.filter(m => m.role === 'agent' && m.part.type === 'ask').map(m => m.role === 'agent' && m.part.type === 'ask' ? m.part.actionId : '')).toEqual(['ac_demoGiftTagCheck000000', WHOLESALE, POST])
    expect(all.some(m => textOf(m).startsWith('Done.'))).toBe(false)
  })

  it('Allow once, then the hold: "Done. Order 4512 has the Wholesale tag." joins the chat after the note that the agent went on', async () => {
    vi.useFakeTimers()
    const a = fresh()
    const card = await a.action(WHOLESALE)
    await a.answerAction(WHOLESALE, card.rev, 'once')
    // In its hold the card hasn't gone out, so the agent has nothing to add.
    vi.advanceTimersByTime(9_000)
    expect((await lines(a)).some(m => textOf(m).startsWith('Done.'))).toBe(false)
    vi.advanceTimersByTime(5_000)
    const all = await lines(a)
    expect(lastTwo(all)).toEqual([['event', ACTION_CARRIED_ON_TEXT], ['agent', 'Done. Order 4512 has the Wholesale tag.']])
    expect(all.map(m => m.pos)).toEqual(all.map((_, i) => i))
    ChatPageSchema.parse(await a.getChat('order-tags'))
    // The follow-up has its own turn and run, and is a model's answer with a trace.
    const done = all.at(-1)!
    expect(done).toMatchObject({ role: 'agent', turnId: 't_demoOrderTags000000004', runId: 'r_demoOrderTags000000004', trace: 'order-tags-resume' })
    expect((await a.getTrace('order-tags-resume'))?.steps.length).toBeGreaterThan(1)
  })

  it('No says so in the words of a card said no to; Reset demo takes the follow-up away', async () => {
    const a = fresh()
    const card = await a.action(POST)
    await a.answerAction(POST, card.rev, 'deny')
    expect(lastTwo(await lines(a))).toEqual([['event', ACTION_CARRIED_ON_TEXT], ['agent', 'Understood. I won’t post to #ops-alerts.']])
    a.reset()
    expect((await lines(a)).some(m => textOf(m).startsWith('Understood.'))).toBe(false)
  })

  it('answering the chat\'s question adds the agent\'s next line for that option, with no note (a question\'s resume shows none)', async () => {
    const a = fresh()
    await a.answerQuestion(CHAT_Q, 'Every wholesale order')
    const all = await lines(a)
    expect(lastTwo(all).map(x => x[0])).not.toContain('event')
    expect(all.at(-1)).toMatchObject({ role: 'agent', turnId: 't_demoOrderTags000000006' })
    expect(textOf(all.at(-1)!)).toBe('Got it. I’ll post the heads-up for every wholesale order.')
    // The routine's question belongs to no chat an admin may open: its answer adds nothing anywhere.
    const before = (await lines(a)).length
    await a.answerQuestion(ROUTINE_Q, 'Yes, flag them')
    expect((await lines(a)).length).toBe(before)
  })

  it('a follow-up joins in the order things happened: the card went out first, then the answer to the question', async () => {
    vi.useFakeTimers()
    const a = fresh()
    const card = await a.action(WHOLESALE)
    await a.answerAction(WHOLESALE, card.rev, 'once')
    vi.advanceTimersByTime(20_000)
    await a.answerQuestion(CHAT_Q, 'Only over $1,000')
    const texts = (await lines(a)).slice(-3).map(textOf)
    expect(texts).toEqual([ACTION_CARRIED_ON_TEXT, 'Done. Order 4512 has the Wholesale tag.', 'Got it. I’ll post the heads-up only for wholesale orders over $1,000.'])
  })

  it('a chat sent a message keeps its history and the follow-up in one order', async () => {
    const a = fresh()
    await a.answerQuestion(CHAT_Q, 'Every wholesale order')
    const s = await a.send('order-tags', { clientTurnKey: 'late-turn-01', text: 'Thanks', model: 'sonnet' })
    expect(s.turnId).toBeTruthy()
    const pos = (await lines(a)).map(m => m.pos)
    expect(pos).toEqual(pos.map((_, i) => i))
  })
})

describe('a batch that partly went out (B4)', () => {
  it('says how many of how many went out, with the items that didn\'t marked in the full list', async () => {
    const a = fresh()
    const card = await a.action(LOYALTY)
    expect(card).toMatchObject({ state: 'sent', result: 'Sent. 447 of 450 went out', can: { approve: false, deny: false, undo: false }, chatId: 'loyalty-tags' })
    const failed: number[] = []
    let sent = 0
    for (let after = 0; ;) {
      const p = await a.actionItems(LOYALTY, after)
      for (const i of p.items) { if (i.state === 'failed') { failed.push(i.n); expect(i.result).toBe(FAILED_TEXT) } else { sent++; expect(i).toMatchObject({ state: 'sent', result: 'Sent.' }) } }
      if (p.next === undefined) break
      after = p.next
    }
    expect([sent, failed]).toEqual([447, [6, 52, 211]])
  })

  it('appears in Activity\'s cards, and in no open list', async () => {
    const a = fresh()
    expect((await a.actions()).some(c => c.id === LOYALTY)).toBe(true)
    expect((await a.actions({ states: ['waiting', 'approved', 'sending', 'needs_check'] })).some(c => c.id === LOYALTY)).toBe(false)
  })
})

describe('View as: Admin and Member (B6)', () => {
  it('an admin sees a teammate\'s refund as theirs to answer and has no way to withdraw it', async () => {
    const a = fresh()
    const refund = await a.action(REFUND)
    expect(refund).toMatchObject({ askedBy: 'm_dana', approverKind: 'admins', can: { approve: true, deny: true, withdraw: false } })
    expect(await errorOf(a.withdrawAction(REFUND, refund.rev))).toMatchObject({ code: 'forbidden' })
    expect(await errorOf(a.action(MEMBER_REFUND))).toMatchObject({ code: 'not_found' })
  })

  it('as a member: only their own cards; the refund is theirs, waits for an admin and can be withdrawn; they can\'t approve it', async () => {
    const a = fresh()
    a.setDemo({ scenario: 'Normal', viewAs: 'member' })
    expect(a.me()?.role).toBe('member')
    expect(a.read().people.members.find(m => m.id === 'm_sam')?.role).toBe('member')
    const cards = await a.actions()
    expect(cards.every(c => c.askedBy === 'm_sam')).toBe(true)
    expect(cards.map(c => c.title)).not.toContain('Remove a tag from order 4470')
    const refund = cards.find(c => c.id === MEMBER_REFUND)!
    expect(refund).toMatchObject({ state: 'waiting', approverKind: 'admins', waitingFor: 'an admin', can: { approve: false, deny: false, withdraw: true, allowOnce: false } })
    expect(await errorOf(a.answerAction(MEMBER_REFUND, refund.rev, 'approve'))).toMatchObject({ code: 'forbidden' })
    const taken = await a.withdrawAction(MEMBER_REFUND, refund.rev)
    expect(taken).toMatchObject({ state: 'withdrawn', can: { withdraw: false } })
    expect(await errorOf(a.withdrawAction(MEMBER_REFUND, refund.rev))).toMatchObject({ code: 'conflict' })
    // Back as an admin the refund is still the teammate's, waiting: the two views are two cards.
    a.setDemo({ scenario: 'Normal', viewAs: 'admin' })
    expect(await a.action(REFUND)).toMatchObject({ state: 'waiting', can: { approve: true } })
  })

  it('as a member: only their own permissions, none of the brand\'s; no ceiling', async () => {
    const a = fresh()
    a.setDemo({ scenario: 'Normal', viewAs: 'member' })
    expect((await a.permissions()).map(p => p.title)).toEqual(['Add stock'])
    expect(await errorOf(a.ceiling())).toMatchObject({ code: 'forbidden' })
    a.setDemo({ scenario: 'Normal', viewAs: 'admin' })
    expect((await a.permissions()).map(p => p.title)).toEqual(['Post messages to a channel', 'Add stock'])
    expect((await a.ceiling()).items).toHaveLength(7)
  })

  it('a member\'s questions are still theirs; Reset demo goes back to an admin\'s view only through the switch', async () => {
    const a = fresh()
    a.setDemo({ scenario: 'Normal', viewAs: 'member' })
    expect((await a.questions()).length).toBe(2)
    a.setDemo({ scenario: 'Normal' })
    expect(a.me()?.role).toBe('admin')
  })
})

describe('What the agent can do (B9)', () => {
  it('lists all seven operations on, read-only: no edit, and the page says editing is off', async () => {
    const a = fresh()
    const list = await a.ceiling()
    CeilingListSchema.parse(list)
    expect(list).toMatchObject({ can: { edit: false }, writesOff: true })
    expect(list.items.map(r => [r.title, r.enabled, r.approverKind])).toEqual([
      ['Add tags to orders', true, 'person'], ['Post messages to a channel', true, 'person'], ['Remove tags from orders', true, 'person'], ['Create draft orders', true, 'person'],
      ['Add stock', true, 'person'], ['Remove stock', true, 'person'], ['Refund orders', true, 'admins'],
    ])
    expect(list.items.find(r => r.operation === 'shopify.refund.create')).toMatchObject({ guardrails: ['money', 'customer'], measure: { kind: 'money', currency: 'USD' } })
    expect(list.items.find(r => r.operation === 'shopify.inventory.reduce')).toMatchObject({ guardrails: ['destructive'], applies: { perDay: false, batch: false } })
  })

  it('a change is refused as a deployable build refuses it: switched off, nothing changed', async () => {
    const a = fresh()
    const e = await errorOf(a.setCeiling('shopify.order.tag_add', { enabled: false, perDayMax: 200, unitsMax: 100, bulkThreshold: 5, batchMax: 500, ifRev: 1 }))
    expect(e).toBeInstanceOf(AgentError)
    expect(e).toMatchObject({ code: 'forbidden', reason: 'writes_off' })
    expect((await a.ceiling()).items.every(r => r.enabled)).toBe(true)
  })

  it('shows in every scenario: it is the Inhouse team\'s, not a tool\'s', async () => {
    const a = fresh()
    a.setDemo({ scenario: 'First day' })
    expect((await a.ceiling()).items).toHaveLength(7)
  })
})

describe('the alerts channel\'s standing permission (B10)', () => {
  const alerts = async (a: Agent) => (await a.listNotifyChannels()).channels.find(c => c.alerts)
  it('an admin\'s mark gives it, for the whole team, at the posting limit; Always allowed lists it; removing it there takes it off the channel', async () => {
    const a = fresh()
    const start = await a.listNotifyChannels()
    expect(start.posting).toEqual({ on: true, perDay: 50 })
    expect(start.channels.every(c => c.permission === undefined)).toBe(true)
    await a.saveNotifyChannels({ channelIds: ['C0DEMO0001'], alertsChannelId: 'C0DEMO0001', ifRev: start.rev })
    const marked = (await alerts(a))!
    expect(marked.permission).toMatchObject({ scope: '#ops-alerts', perDay: 50 })
    const held = (await a.permissions()).find(p => p.id === marked.permission!.id)!
    expect(held).toMatchObject({ title: 'Post messages to a channel', holder: { kind: 'brand' }, scope: '#ops-alerts', limits: { effectivePerDay: 50 }, can: { remove: true } })
    await a.removePermission(held.id, held.rev)
    expect((await alerts(a))!.permission).toBeUndefined()
  })

  it('moving the mark takes the permission from the old channel and gives it to the new one; unmarking takes it away', async () => {
    const a = fresh()
    const l0 = await a.listNotifyChannels()
    const l1 = await a.saveNotifyChannels({ channelIds: ['C0DEMO0001', 'C0DEMO0002'], alertsChannelId: 'C0DEMO0001', ifRev: l0.rev })
    const l2 = await a.saveNotifyChannels({ channelIds: ['C0DEMO0001', 'C0DEMO0002'], alertsChannelId: 'C0DEMO0002', ifRev: l1.rev })
    expect(l2.channels.map(c => [c.name, c.permission?.scope ?? null])).toEqual([['ops-alerts', null], ['warehouse', '#warehouse']])
    expect((await a.permissions()).filter(p => p.holder.kind === 'brand')).toHaveLength(1)
    const l3 = await a.saveNotifyChannels({ channelIds: ['C0DEMO0001', 'C0DEMO0002'], alertsChannelId: null, ifRev: l2.rev })
    expect(l3.channels.every(c => c.permission === undefined)).toBe(true)
    expect((await a.permissions()).filter(p => p.holder.kind === 'brand')).toHaveLength(0)
  })

  it('saving the list again without moving the mark makes no second permission; taking the channel off the list takes it away', async () => {
    const a = fresh()
    const l0 = await a.listNotifyChannels()
    const l1 = await a.saveNotifyChannels({ channelIds: ['C0DEMO0001'], alertsChannelId: 'C0DEMO0001', ifRev: l0.rev })
    const l2 = await a.saveNotifyChannels({ channelIds: ['C0DEMO0001', 'C0DEMO0002'], alertsChannelId: 'C0DEMO0001', ifRev: l1.rev })
    expect(l2.channels[0]!.permission!.id).toBe(l1.channels[0]!.permission!.id)
    await a.saveNotifyChannels({ channelIds: ['C0DEMO0002'], ifRev: l2.rev })
    expect((await a.permissions()).filter(p => p.holder.kind === 'brand')).toHaveLength(0)
  })

  it('a member\'s view gives none (a member can\'t mark), and a Reset takes it away', async () => {
    const a = fresh()
    a.setDemo({ scenario: 'Normal', viewAs: 'member' })
    const l0 = await a.listNotifyChannels()
    await a.saveNotifyChannels({ channelIds: ['C0DEMO0001'], alertsChannelId: 'C0DEMO0001', ifRev: l0.rev })
    expect((await alerts(a))!.permission).toBeUndefined()
    a.setDemo({ scenario: 'Normal', viewAs: 'admin' })
    const l1 = await a.listNotifyChannels()
    await a.saveNotifyChannels({ channelIds: ['C0DEMO0001'], alertsChannelId: null, ifRev: l1.rev })
    await a.saveNotifyChannels({ channelIds: ['C0DEMO0001'], alertsChannelId: 'C0DEMO0001', ifRev: l1.rev + 1 })
    expect((await alerts(a))!.permission).toBeDefined()
    a.reset()
    expect((await a.permissions()).some(p => p.holder.kind === 'brand')).toBe(false)
  })
})

describe('the seeded chats for the other write cards (B7, B8, B11, B12)', () => {
  const chat = (a: Agent, id: string) => a.read().chat.chats.find(c => c.id === id)!
  const askIds = (a: Agent, id: string) => chat(a, id).turns.flatMap(t => (t.role === 'agent' ? t.parts : [])).filter(p => p.type === 'ask').map(p => (p.type === 'ask' ? p.actionId : ''))

  it('every card a chat shows is a card the demo has, in its own chat', async () => {
    const a = fresh()
    const cards = new Map((await a.actions()).map(c => [c.id, c.chatId]))
    for (const c of a.read().chat.chats) for (const id of askIds(a, c.id)) expect(cards.get(id), `${c.id} names ${id}`).toBe(c.id)
    const kept = (await a.getChat('order-tags')).messages
    for (const m of kept) if (m.role === 'agent' && m.part.type === 'ask') expect(cards.get(m.part.actionId)).toBe('order-tags')
  })

  it('the draft order went out in its chat, with the products and SKUs the store gave; finding the teammate is a step of its trace', async () => {
    const a = fresh()
    const draft = await a.action('ac_demoDraftOrder00000000')
    expect(draft).toMatchObject({ state: 'sent', chatId: 'draft-orders', title: 'Create a draft order of 12 items', result: 'Sent.', reversible: true })
    expect(draft.detail?.rows.map(r => [r.product, r.sku, r.quantity])).toEqual([['Cairn Insulated Bottle 750 ml, Olive', 'CB-750-OLV', 8], ['Cairn Insulated Bottle 750 ml, Black', 'CB-750-BLK', 4]])
    expect(askIds(a, 'draft-orders')).toEqual(['ac_demoDraftOrder00000000'])
    expect((await a.getTrace('draft-orders'))?.steps.map(s => s.label)).toContain('Finding a teammate')
  })

  it('the stock chat refuses 900 units against the 500-unit limit and says why; the 40-unit reduction is an exact, destructive card that went out', async () => {
    const a = fresh()
    const turns = chat(a, 'stock-fixes').turns
    const refusal = turns.flatMap(t => (t.role === 'agent' ? t.parts : [])).find(p => p.type === 'text')
    expect(refusal && refusal.type === 'text' ? refusal.text : '').toMatch(/over the limit the Inhouse team set[^.]*500 units[^.]*nothing was asked or sent/)
    expect(askIds(a, 'stock-fixes')).toEqual(['ac_demoStockReduce0000000'])
    const reduced = await a.action('ac_demoStockReduce0000000')
    expect(reduced).toMatchObject({ kind: 'exact', state: 'sent', guardrail: 'destructive', reversible: false, title: 'Remove 40 units of stock from item 8012' })
    expect((await a.getTrace('stock-over-limit'))?.steps.map(s => s.detail).join(' ')).toContain('Refused: over the limit')
  })

  it('the order note says "refund this order": the agent points it out and puts no card in the chat', async () => {
    const a = fresh()
    const agent = chat(a, 'order-note').turns.flatMap(t => (t.role === 'agent' ? t.parts : []))
    expect(agent.map(p => p.type)).toEqual(['text'])
    const text = agent[0]!.type === 'text' ? agent[0]!.text : ''
    expect(text).toContain('Refund this order.')
    expect(text).toMatch(/came from the order, not from you, so I didn't act on it/)
    expect((await a.actions()).filter(c => c.chatId === 'order-note')).toEqual([])
  })
})
