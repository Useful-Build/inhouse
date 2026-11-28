// The mock's actions and permissions as the screens reach them (the demo catch-up's PR 1). Ways it can fail, written first:
//  1. Settings > Always allowed or Activity reads no permission in the demo, or one in a scenario that shows no actions;
//  2. Always allow on a demo card leaves the permission list as it was, or Remove through the client leaves it;
//  3. a Pause during the hold leaves the card to go out, tells no open card (`onActionUpdated`), or puts no "Approval sent
//     back" in the bell; Reset demo keeps that notice;
//  4. the bell's approval notices show where the demo shows no actions;
//  5. the demo's data has a stage: a turn shows only in one.
// The Slack posts on Today (payout, stuck order) follow the product's post card (the review's High 2), written first:
//  6. a post is still offered once #ops-alerts is unlisted, or goes out when it is unlisted in its hold;
//  7. a post is approved while the agent is paused, or a Pause in its hold leaves it to go out;
//  8. a post can be edited; 9. a post sent back says nothing of why, or never reaches the bell.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasDraft } from '../state/derive'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
const { MockAgent } = await import('./mock')
const fresh = () => { store.clear(); return new MockAgent() }
const WHOLESALE = 'ac_demoWholesaleTag000000'
const errorOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => e)
// The server's words (sample-data/actions.json; server/outbox/demo-parity.test.ts holds them equal).
const LAPSE = { paused: 'The agent was paused, so this needs your OK again.', channel: 'The channel isn’t listed any more, so this needs your OK again.' }
const POSTS = ['payout', 'stuck']
const post = (a: InstanceType<typeof MockAgent>, id: string) => a.read().problems.find(p => p.id === id)!
/** Slack notices with #ops-alerts taken off the list. */
const unlist = async (a: InstanceType<typeof MockAgent>) => { const l = await a.listNotifyChannels(); await a.saveNotifyChannels({ ifRev: l.rev, channelIds: [] }) }
afterEach(async () => { (await import('./mock-notify')).demoNotify.reset() })

describe('the mock: asking first and Always allow', () => {
  it('lists the seeded permissions in the Normal scenario only', async () => {
    const a = fresh()
    expect((await a.permissions()).map(p => p.title)).toEqual(['Post messages to a channel', 'Add stock'])
    a.setDemo({ scenario: 'Cap reached' })
    expect(await a.permissions()).toEqual([])
    expect(await a.actions()).toEqual([])
  })

  it('Always allow adds a permission; Remove through the client takes it away', async () => {
    const a = fresh()
    const card = await a.action(WHOLESALE)
    await a.answerAction(WHOLESALE, card.rev, 'always')
    const made = (await a.permissions()).find(p => p.title === 'Add tags to orders')!
    expect(made).toBeDefined()
    expect((await a.removePermission(made.id, made.rev)).some(p => p.id === made.id)).toBe(false)
    expect(await errorOf(a.removePermission(made.id, made.rev))).toMatchObject({ code: 'not_found' })
  })

  it('a Pause in the hold sends the card back, tells the open card and puts "Approval sent back" in the bell', async () => {
    vi.useFakeTimers()
    try {
      const a = fresh()
      const heard: { actionId: string; rev: number }[] = []
      const off = a.onActionUpdated(u => heard.push(u))
      const card = await a.action(WHOLESALE)
      const once = await a.answerAction(WHOLESALE, card.rev, 'once')
      vi.advanceTimersByTime(3_000)
      await a.pause()
      await vi.advanceTimersByTimeAsync(0)
      const back = await a.action(WHOLESALE)
      expect(back).toMatchObject({ state: 'waiting', rev: once.rev + 1, lapsed: 'The agent was paused, so this needs your OK again.' })
      expect(heard).toEqual([{ actionId: WHOLESALE, rev: back.rev }])
      const note = a.listNotifications()[0]!
      expect(note).toMatchObject({ text: 'Approval sent back', who: 'Inhouse', unread: true, waiting: true, link: { to: 'page', page: 'approvals' } })
      // Paused, no approval is taken; resumed, it is.
      expect(await errorOf(a.answerAction(WHOLESALE, back.rev, 'once'))).toMatchObject({ code: 'conflict', reason: 'paused' })
      await a.resume()
      expect((await a.answerAction(WHOLESALE, back.rev, 'once')).state).toBe('approved')
      // Read, it stays read; Reset demo drops it with the cards.
      await a.markNoticesRead([note.id])
      expect(a.listNotifications().find(n => n.id === note.id)?.unread).toBe(false)
      off()
      a.reset()
      await vi.advanceTimersByTimeAsync(0)
      expect(a.listNotifications().some(n => n.text === 'Approval sent back')).toBe(false)
      expect((await a.action(WHOLESALE)).state).toBe('waiting')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a Pause and then Reset demo in the same moment leave the fresh demo as it starts: no card sent back, no notice', async () => {
    vi.useFakeTimers()
    try {
      const a = fresh()
      const card = await a.action(WHOLESALE)
      await a.answerAction(WHOLESALE, card.rev, 'once')
      void a.pause()
      a.reset()
      await vi.advanceTimersByTimeAsync(0)
      expect(a.listNotifications().some(n => n.text === 'Approval sent back')).toBe(false)
      expect(await a.action(WHOLESALE)).toMatchObject({ state: 'waiting', rev: 1 })
      expect((await a.action(WHOLESALE)).lapsed).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("the bell's approval notices show only where the demo shows its actions", () => {
    const a = fresh()
    const approvals = () => a.listNotifications().filter(n => n.link.to === 'page' && n.link.page === 'approvals' && n.who === 'Inhouse').map(n => n.text)
    expect(approvals()).toEqual(['Approval waiting', 'A send needs a check', 'A question is waiting', 'An approval expired'])
    a.setDemo({ scenario: 'Tool disconnected' })
    expect(approvals()).toEqual([])
  })

  it('has no stage: no chat turn names one', () => {
    const a = fresh()
    for (const c of a.read().chat.chats) for (const t of c.turns) expect('stage' in t, c.id).toBe(false)
  })

  describe("the Slack posts on Today follow the product's post card", () => {
    it('are not offered once #ops-alerts is unlisted: findings with no draft, and approving one is refused with the server\'s words; listed again, they are posts again', async () => {
      const a = fresh()
      expect(POSTS.map(id => post(a, id).draft.kind)).toEqual(['Slack post', 'Slack post'])
      await unlist(a)
      for (const id of POSTS) {
        expect(hasDraft(post(a, id)), id).toBe(false)
        expect(post(a, id).draft.kind, id).toBeUndefined()
        expect(await errorOf(a.approve(id))).toMatchObject({ code: 'conflict', message: LAPSE.channel })
      }
      expect(a.getSnapshot().approved).toEqual({})
      const l = await a.listNotifyChannels()
      await a.saveNotifyChannels({ ifRev: l.rev, channelIds: ['C0DEMO0001'] })
      for (const id of POSTS) expect(hasDraft(post(a, id)), id).toBe(true)
    })

    it('are sent back, not sent, when #ops-alerts is unlisted in their hold: the server\'s words, a bell notice, and nothing goes out', async () => {
      vi.useFakeTimers()
      try {
        const a = fresh()
        await a.actions() // loads the actions module, so the lapse needs no more than a tick
        await a.approve('payout')
        vi.advanceTimersByTime(3_000)
        await unlist(a)
        await vi.advanceTimersByTimeAsync(0)
        expect(a.getSnapshot().approved.payout).toBeUndefined()
        expect(post(a, 'payout')).toMatchObject({ lapsed: LAPSE.channel })
        expect(hasDraft(post(a, 'payout'))).toBe(false)
        expect(a.listNotifications()[0]).toMatchObject({ text: 'Approval sent back', who: 'Inhouse', unread: true, waiting: true, link: { to: 'page', page: 'today' } })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(a.getSnapshot().sent.payout).toBeUndefined()
        // The post that was never approved says nothing of a lapse.
        expect(post(a, 'stuck').lapsed).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('are refused while the agent is paused, and Resume takes them again', async () => {
      const a = fresh()
      await a.pause()
      for (const id of POSTS) expect(await errorOf(a.approve(id))).toMatchObject({ code: 'conflict', reason: 'paused' })
      expect(a.getSnapshot().approved).toEqual({})
      await a.resume()
      expect(await errorOf(a.approve('payout'))).toBe('resolved')
    })

    it('are sent back by a Pause in their hold: the server\'s words, still a post, a bell notice, and nothing goes out', async () => {
      vi.useFakeTimers()
      try {
        const a = fresh()
        await a.actions()
        await a.approve('stuck')
        vi.advanceTimersByTime(3_000)
        await a.pause()
        await vi.advanceTimersByTimeAsync(0)
        expect(a.getSnapshot().approved.stuck).toBeUndefined()
        expect(post(a, 'stuck')).toMatchObject({ lapsed: LAPSE.paused })
        expect(post(a, 'stuck').draft.kind).toBe('Slack post')
        expect(a.listNotifications()[0]).toMatchObject({ text: 'Approval sent back', waiting: true, link: { to: 'page', page: 'approvals' } })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(a.getSnapshot().sent.stuck).toBeUndefined()
        // Approved again once it runs, the words go.
        await a.resume()
        await a.approve('stuck')
        expect(post(a, 'stuck').lapsed).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('cannot be edited: the product\'s card has no edit', async () => {
      const a = fresh()
      for (const id of POSTS) expect(await errorOf(a.editDraft(id, 'my own words'))).toMatchObject({ code: 'invalid' })
      expect(a.getSnapshot().edits).toEqual({})
      // A real draft still takes a note.
      expect(await errorOf(a.editDraft('returns', 'a note'))).toBe('resolved')
    })
  })
  describe('the chat a card came from is dated after its asks (issue 751)', () => {
    // This PR's chat only: the VIP and Ridge chats are older than their cards on main too (a separate follow-up).
    it('every ask card in the wholesale and gift tags chat was asked before that chat was last active', async () => {
      const a = fresh()
      const chats = new Map(a.read().chat.chats.map(c => [c.id, c.at.ms]))
      const cards = (await a.actions()).filter(c => c.chatId === 'order-tags')
      expect(cards.length).toBe(3)
      for (const c of cards) expect(c.askedAt.ms, `${c.title} in ${String(c.chatId)}`).toBeLessThanOrEqual(chats.get(c.chatId!)!)
    })
  })

  describe("what a finding opens", () => {
    it('its routine run, the morning check, not a drafted fix; a draft opens how it was made, and a post sent back to a finding opens the run too', async () => {
      const a = fresh()
      const steps = async (id: string) => (await a.getTrace(`draft:${id}`))!
      for (const id of ['stock', 'oversell', 'po']) {
        const t = await steps(id)
        expect(t.title, id).toBe('Morning check')
        expect(JSON.stringify(t.steps), id).not.toMatch(/Drafted it in your words|Sent to Approvals/)
      }
      expect((await steps('returns')).title).toBe('Drafted a fix for 11 returns are not restocked')
      expect((await steps('payout')).title).toBe('Drafted a fix for Amazon paid out $1,240 less than expected')
      await unlist(a)
      expect((await steps('payout')).title).toBe('Morning check')
    })
  })
})
