// Activity and the bell over a fake `fetch` (P4 W4). Ways they could show a person the wrong thing, written down first:
//  - a line dated just after local midnight in the brand's zone listed under today (or just before it, not under earlier);
//    the split reading the device's zone instead of `g:tz`;
//  - the bell's read state lost on a reload, or kept on screen after the server refused it, or a refusal putting back a
//    notice a later read made unread again;
//  - the Inhouse team asked for the bell (it has none) or for Activity on start (a grant would log every read);
//  - a page that repeats or drops a line when the next is read with its cursor.
import { describe, expect, test } from 'vitest'
import { HttpAgent } from './client'
import { splitActivity, readActivityPage } from './activity'
import { Transport } from './transport'
import { iso, me, reads, record, refusal, server } from './testing/fake-server'
import type { Routes } from './testing/fake-server'

const NY = { timeZone: 'America/New_York', locale: 'en-US' }
const line = (ms: number, text = `line ${ms}`) => ({
  at: { iso: new Date(ms).toISOString(), ms }, kind: 'read', text, who: 'Your Inhouse agent', why: 'Its time came', result: 'It finished',
  by: { text: 'Your Inhouse agent, at {at:time}', times: { at: { iso: new Date(ms).toISOString(), ms } } },
})
// 2026-11-21 00:00 in New York is 05:00 UTC (EST, UTC-5).
const MIDNIGHT = Date.UTC(2026, 10, 21, 5, 0, 0)
const MINUTE = 60_000

describe('splitActivity across a local midnight in New York (the oracle is the literal times)', () => {
  test('a line one minute after midnight is today, one minute before is earlier, whatever the device zone', () => {
    const now = MIDNIGHT + 9 * 60 * MINUTE
    const lines = [line(MIDNIGHT + 30 * MINUTE, 'after'), line(MIDNIGHT + MINUTE, 'just after'), line(MIDNIGHT - MINUTE, 'just before'), line(MIDNIGHT - 20 * 60 * MINUTE, 'yesterday')]
    const { today, earlier } = splitActivity(lines as never, now, NY)
    expect(today.map(l => l.text)).toEqual(['after', 'just after'])
    expect(earlier.map(l => l.text)).toEqual(['just before', 'yesterday'])
    // Tokyo is already on the 21st at 05:00 UTC minus a day: the same instants split differently, so the zone is what decides.
    const tokyo = splitActivity(lines as never, now, { timeZone: 'Asia/Tokyo', locale: 'en-US' })
    expect(tokyo.today.map(l => l.text)).not.toEqual(today.map(l => l.text))
  })
  test('daylight saving: the day the clocks go back is 25 hours long, so a line 24 hours before is still today', () => {
    // 2026-11-01 05:00 UTC is 01:00 EDT; the clocks go back at 06:00 UTC (02:00 EDT to 01:00 EST).
    const start = Date.UTC(2026, 10, 1, 4, 0, 0) // 00:00 EDT, 1 Nov
    const now = start + 24 * 60 * MINUTE
    expect(splitActivity([line(start + MINUTE, 'early')] as never, now, NY).today).toHaveLength(1)
  })
  test('order is kept and a line dated after now counts as today', () => {
    const now = MIDNIGHT + 60 * MINUTE
    const { today } = splitActivity([line(now + 5 * MINUTE, 'later'), line(now, 'now')] as never, now, NY)
    expect(today.map(l => l.text)).toEqual(['later', 'now'])
  })
})

describe('reading a page', () => {
  test('sends limit and cursor; the next page continues where the last stopped', async () => {
    const s = server({ 'GET /api/activity?limit=2': { body: { items: [line(3), line(2)], nextCursor: 'c1' } }, 'GET /api/activity?limit=2&cursor=c1': { body: { items: [line(1)], nextCursor: null } } })
    const http = new Transport({ fetch: s.fetch })
    const a = await readActivityPage(http, { limit: 2 })
    const b = await readActivityPage(http, { limit: 2, cursor: a.nextCursor! })
    expect([...a.items, ...b.items].map(l => l.at.ms)).toEqual([3, 2, 1])
    expect(b.nextCursor).toBeNull()
  })
})

const notice = (id: string, unread: boolean, o: Record<string, unknown> = {}) => ({ id, icon: 'notifications', text: `Notice ${id}`, who: 'Your Inhouse agent', at: iso(1000), unread, link: { to: 'page', page: 'today' }, ...o })
async function loaded(routes: Routes) {
  const s = server(routes)
  const agent = new HttpAgent({ fetch: s.fetch, now: () => MIDNIGHT + 60 * MINUTE })
  await agent.whenLoaded()
  return { agent, ...s }
}

describe('the client: Activity', () => {
  test('boots with the lines split by the brand zone (g:tz) and the data carries them', async () => {
    const { agent } = await loaded({ ...reads({ activity: [line(MIDNIGHT + 10 * MINUTE, 'new day'), line(MIDNIGHT - 10 * MINUTE, 'old day')] }), 'GET /api/settings/brand': { body: { items: [record('g:tz', 'America/New_York', 1)] } } })
    expect(agent.read().activity.today.map(l => l.text)).toEqual(['new day'])
    expect(agent.read().activity.earlier.map(l => l.text)).toEqual(['old day'])
    expect(agent.read().resources.activity).toEqual({ status: 'ready' })
  })
  test('the Inhouse team is not asked on start; asked once its page does; a 403 is nothing to show', async () => {
    const staff = await loaded({ ...reads({ activity: [line(MIDNIGHT)] }), 'GET /api/me': { body: me({ role: 'inhouse' }) } })
    expect(staff.calls.map(c => c.path)).not.toContain('/api/activity?limit=100')
    expect(staff.calls.map(c => c.path)).not.toContain('/api/notifications')
    await staff.agent.retry('activity')
    expect(staff.agent.read().activity.today.length + staff.agent.read().activity.earlier.length).toBe(1)
    const refused = await loaded({ ...reads(), 'GET /api/activity?limit=100': refusal(403, 'forbidden', { reason: 'grant_required' }) })
    expect(refused.agent.read().resources.activity).toEqual({ status: 'ready' })
  })
})

describe('the client: the bell', () => {
  test('lists what the server sent, the same array until something changes', async () => {
    const { agent } = await loaded(reads({ notifications: [notice('n1', true), notice('n2', false)] }))
    expect(agent.listNotifications().map(n => [n.id, n.unread])).toEqual([['n1', true], ['n2', false]])
    expect(agent.listNotifications()).toBe(agent.listNotifications())
  })
  test('marking read shows at once, sends only the unread ones asked for, and survives a reload', async () => {
    let server1 = [notice('n1', true), notice('n2', true), notice('n3', false)]
    const routes: Routes = { ...reads(), 'GET /api/notifications': () => ({ body: { items: server1 } }),
      'POST /api/notifications/read': r => { const ids = JSON.parse(r.body!).ids as string[]; server1 = server1.map(n => (ids.includes(n.id) ? { ...n, unread: false } : n)); return { body: { ok: true } } } }
    const { agent, calls } = await loaded(routes)
    const done = agent.markNoticesRead(['n1', 'n3', 'nope'])
    expect(agent.listNotifications().map(n => n.unread)).toEqual([false, true, false])
    await done
    expect(JSON.parse(calls.find(c => c.path === '/api/notifications/read')!.body!)).toEqual({ ids: ['n1'] })
    // A fresh client (a reload) reads the server's state: n1 stays read.
    const again = await loaded({ ...reads(), 'GET /api/notifications': () => ({ body: { items: server1 } }) })
    expect(again.agent.listNotifications().map(n => [n.id, n.unread])).toEqual([['n1', false], ['n2', true], ['n3', false]])
  })
  test('nothing unread to mark sends nothing', async () => {
    const { agent, calls } = await loaded(reads({ notifications: [notice('n1', false)] }))
    await agent.markNoticesRead(['n1'])
    expect(calls.some(c => c.path === '/api/notifications/read')).toBe(false)
  })
  test('a refused mark puts the dot back and rejects', async () => {
    const { agent } = await loaded({ ...reads({ notifications: [notice('n1', true)] }), 'POST /api/notifications/read': refusal(503, 'unavailable') })
    const result = agent.markNoticesRead(['n1']).then(() => 'ok', (e: unknown) => e)
    expect(agent.listNotifications()[0].unread).toBe(false)
    expect(await result).toMatchObject({ code: 'unavailable' })
    expect(agent.listNotifications()[0].unread).toBe(true)
  })
  test('the Inhouse team is never asked for the bell, whatever its page does', async () => {
    const staff = await loaded({ ...reads(), 'GET /api/me': { body: me({ role: 'inhouse' }) } })
    await staff.agent.retry('notifications')
    expect(staff.calls.some(c => c.path === '/api/notifications')).toBe(false)
    expect(staff.agent.listNotifications()).toEqual([])
  })
})
