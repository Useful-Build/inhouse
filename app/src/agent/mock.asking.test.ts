// The mock's actions and permissions as the screens reach them (the demo catch-up's PR 1). Ways it can fail, written first:
//  1. Settings > Always allowed or Activity reads no permission in the demo, or one in a scenario that shows no actions;
//  2. Always allow on a demo card leaves the permission list as it was, or Remove through the client leaves it;
//  3. a Pause during the hold leaves the card to go out, tells no open card (`onActionUpdated`), or puts no "Approval sent
//     back" in the bell; Reset demo keeps that notice;
//  4. the bell's approval notices show where the demo shows no actions;
//  5. the demo's data has a stage: a turn shows only in one.
import { describe, expect, it, vi } from 'vitest'

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
    expect(approvals()).toEqual(['Approval waiting', 'A send needs a check', 'An approval expired'])
    a.setDemo({ scenario: 'Tool disconnected' })
    expect(approvals()).toEqual([])
  })

  it('has no stage: no chat turn names one', () => {
    const a = fresh()
    for (const c of a.read().chat.chats) for (const t of c.turns) expect('stage' in t, c.id).toBe(false)
  })
})
