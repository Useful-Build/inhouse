// The Slack notices page's store (notify-channels.ts) against a fake agent. Ways it can fail, written down first:
//  1. a stale save keeps the old list (or loses the current one the answer carried, or doesn't re-read without one);
//  2. a refusal's toast is generic, or names the wrong channel;
//  3. the picker error is mapped wrong (Slack not connected must point to the Tools page, anything else is "unavailable");
//  4. removing the alerts channel keeps its alerts mark, or the add drops it;
//  5. a second save while one is in flight sends a second request (the busy guard);
//  6. the picker reads past its page limit, or doesn't say it stopped there;
//  7. answers for a closed page land.
import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { createNotifyStore, SAVE_REFUSED, STALE_TEXT, SAVE_FAILED } = await import('./notify-store')
const { AgentError } = await import('../../agent/types')
type Agent = Parameters<typeof createNotifyStore>[0]['agent']
type List = Awaited<ReturnType<Agent['listNotifyChannels']>>
type Save = Parameters<Agent['saveNotifyChannels']>[0]

const LIST: List = { rev: 2, channels: [{ channelId: 'C0TEST0001', name: 'ops-alerts', alerts: true }, { channelId: 'C0TEST0002', name: 'general', alerts: false }] }
const PAGE = { channels: [{ channelId: 'C0TEST0005', name: 'warehouse' }, { channelId: 'C0TEST0003', name: 'partner', disabled: 'shared_channel' as const }], nextCursor: null }

function fake(over: Partial<Agent> = {}) {
  const saves: Save[] = []
  const toasts: string[] = []
  const agent: Agent = {
    listNotifyChannels: async () => LIST,
    availableNotifyChannels: async () => PAGE,
    saveNotifyChannels: async input => {
      saves.push(input)
      return { rev: input.ifRev + 1, channels: input.channelIds.map(id => ({ channelId: id, name: id, alerts: id === input.alertsChannelId })) }
    },
    ...over,
  }
  const store = createNotifyStore({ agent, toast: t => toasts.push(t), maxPages: 3 })
  return { store, saves, toasts }
}
const settle = () => new Promise(r => setTimeout(r, 0))

describe('the Slack notices store', () => {
  it('reads the list and the picker when opened by an editor; a Member reads the list only', async () => {
    const a = fake()
    a.store.open(true)
    expect(a.store.getSnapshot()).toMatchObject({ status: 'loading', pickerLoading: true })
    await a.store.retry()
    expect(a.store.getSnapshot()).toMatchObject({ status: 'ready', list: LIST, available: PAGE.channels, pickerLoading: false, truncated: false })
    let pickerReads = 0
    const m = fake({ availableNotifyChannels: async () => { pickerReads++; return PAGE } })
    m.store.open(false)
    await m.store.retry()
    expect([m.store.getSnapshot().status, m.store.getSnapshot().available, pickerReads]).toEqual(['ready', null, 0])
  })

  it('a stale save shows the current list the answer carried, and says so', async () => {
    const current: List = { rev: 9, channels: [{ channelId: 'C0TEST0009', name: 'newer', alerts: false }] }
    const f = fake({ saveNotifyChannels: async () => { throw new AgentError('conflict', 'x', { current }) } })
    f.store.open(true)
    await f.store.retry()
    await f.store.add('C0TEST0005')
    expect(f.store.getSnapshot().list).toEqual(current)
    expect(f.toasts).toEqual([STALE_TEXT])
  })

  it('a stale save without a usable current list reads the list again', async () => {
    let reads = 0
    const f = fake({
      listNotifyChannels: async () => { reads++; return LIST },
      saveNotifyChannels: async () => { throw new AgentError('conflict', 'x') },
    })
    f.store.open(false)
    await f.store.retry()
    const before = reads
    await f.store.setAlerts(null)
    await settle()
    expect([reads - before, f.toasts]).toEqual([1, [STALE_TEXT]])
  })

  it.each([
    ['shared_channel', { channelId: 'C0TEST0003' }, '#partner is shared with another company, so it can\'t be listed.'],
    ['archived', { channelId: 'C0TEST0001' }, '#ops-alerts is archived, so it can\'t be listed.'],
    ['not_public', { channelId: 'C0TEST0005' }, "#warehouse isn't public. Only public channels can be listed."],
    ['not_member', { channelId: 'C0TEST0005' }, "The connected Slack account isn't in #warehouse. Add it in Slack first."],
    ['not_found', { channelId: 'C9UNKNOWN0' }, "That channel isn't in Slack any more."],
    ['name_taken', { channelId: 'C0TEST0002' }, '#general has the same name as another listed channel.'],
    ['slack_not_connected', undefined, "Slack isn't connected, or it's paused or needs a reconnect. Check it on the Tools page."],
  ] as const)('a %s refusal says so, naming the channel', async (reason, current, text) => {
    const f = fake({ saveNotifyChannels: async () => { throw new AgentError(reason === 'slack_not_connected' ? 'unavailable' : 'conflict', 'x', { reason, ...(current ? { current } : {}) }) } })
    f.store.open(true)
    await f.store.retry()
    await f.store.add('C0TEST0005')
    expect(f.toasts).toEqual([text])
    expect(f.store.getSnapshot().list).toEqual(LIST)
  })

  it('every refusal reason has its own text (none falls back to the generic line)', () => {
    for (const r of ['shared_channel', 'archived', 'not_public', 'not_member', 'not_found', 'name_taken', 'slack_not_connected']) {
      expect(Object.hasOwn(SAVE_REFUSED, r), r).toBe(true)
      expect(SAVE_REFUSED[r as keyof typeof SAVE_REFUSED]('#x')).not.toBe(SAVE_FAILED)
    }
  })

  it('maps the picker error: Slack not connected is "disconnected", anything else "unavailable"', async () => {
    const a = fake({ availableNotifyChannels: async () => { throw new AgentError('unavailable', 'x', { reason: 'slack_not_connected' }) } })
    a.store.open(true)
    await a.store.retry()
    expect(a.store.getSnapshot()).toMatchObject({ pickerError: 'disconnected', pickerLoading: false })
    const b = fake({ availableNotifyChannels: async () => { throw new AgentError('unavailable', 'x') } })
    b.store.open(true)
    await b.store.retry()
    expect(b.store.getSnapshot().pickerError).toBe('unavailable')
    const c = fake({ availableNotifyChannels: async () => { throw new Error('network') } })
    c.store.open(true)
    await c.store.retry()
    expect(c.store.getSnapshot().pickerError).toBe('unavailable')
  })

  it('removing the alerts channel clears the mark; adding and removing another keeps it', async () => {
    const f = fake()
    f.store.open(true)
    await f.store.retry()
    await f.store.remove('C0TEST0002')
    expect(f.saves.at(-1)).toEqual({ channelIds: ['C0TEST0001'], alertsChannelId: 'C0TEST0001', ifRev: 2 })
    const g = fake()
    g.store.open(true)
    await g.store.retry()
    await g.store.remove('C0TEST0001')
    expect(g.saves.at(-1)).toEqual({ channelIds: ['C0TEST0002'], alertsChannelId: null, ifRev: 2 })
    const h = fake()
    h.store.open(true)
    await h.store.retry()
    await h.store.add('C0TEST0005')
    expect(h.saves.at(-1)).toEqual({ channelIds: ['C0TEST0001', 'C0TEST0002', 'C0TEST0005'], alertsChannelId: 'C0TEST0001', ifRev: 2 })
  })

  it('a second save while one is in flight sends nothing (the busy guard)', async () => {
    let release!: () => void
    const f = fake()
    const slow = fake({ saveNotifyChannels: input => new Promise(r => { f.saves.push(input); release = () => r({ ...LIST, rev: 3 }) }) })
    slow.store.open(true)
    await slow.store.retry()
    const first = slow.store.add('C0TEST0005')
    expect(slow.store.getSnapshot().busy).toBe(true)
    const second = slow.store.remove('C0TEST0002')
    // Checked before awaiting: a regression would send (and wait on) a second save.
    expect(f.saves.length).toBe(1)
    release()
    await Promise.all([first, second])
    expect(f.saves.length).toBe(1)
    expect(slow.store.getSnapshot().busy).toBe(false)
  })

  it('stops the picker at its page limit and says so', async () => {
    let pages = 0
    const f = fake({ availableNotifyChannels: async () => { pages++; return { channels: [{ channelId: `C1TEST${pages}000`, name: `c${pages}` }], nextCursor: 'more' } } })
    f.store.open(true)
    for (let i = 0; i < 20; i++) await settle()
    expect([pages, f.store.getSnapshot().truncated, f.store.getSnapshot().available?.length]).toEqual([3, true, 3])
  })

  it('drops answers that arrive after the page closed', async () => {
    let answer!: (l: List) => void
    const f = fake({ listNotifyChannels: () => new Promise(r => { answer = r }) })
    const close = f.store.open(false)
    close()
    answer(LIST)
    await settle()
    expect(f.store.getSnapshot().list).toBeNull()
  })

  it('a stale save without a current list after the page closed reads nothing', async () => {
    let reads = 0
    let reject!: (e: unknown) => void
    const f = fake({ listNotifyChannels: async () => { reads++; return LIST }, saveNotifyChannels: () => new Promise((_, r) => { reject = r }) })
    const close = f.store.open(false)
    await f.store.retry()
    const before = reads
    const saving = f.store.setAlerts(null)
    close()
    reject(new AgentError('conflict', 'x'))
    await saving
    await settle()
    expect(reads).toBe(before)
  })
})
