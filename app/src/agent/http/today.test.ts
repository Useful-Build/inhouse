// Today over a fake `fetch` (P4 W3, routes 57 and 58). Ways it could show a person the wrong thing, written down first:
//  - a card set aside that stays on screen, or leaves and doesn't come back on a refusal, or an Undo that doesn't bring it back
//    where it was;
//  - a write that sends a rev it doesn't hold (the first sends 0, the next the record's rev, even before the first answers);
//  - a conflict that loses the server's record, or a stale card that stays after the server says it's hidden;
//  - `declined` (P6's) or a card the client doesn't hold sent to the server;
//  - the Inhouse team asked on start (a grant logs every read);
//  - the hidden cards' records not in `state.setAside`, or a card whose snooze ended counted as hidden.
import { describe, expect, test } from 'vitest'
import { HttpAgent } from './client'
import { iso, me, reads, refusal, server } from './testing/fake-server'
import type { Routes } from './testing/fake-server'

const card = (id: string, title = id) => ({
  id: `p_${id.padEnd(22, 'x')}`, sev: 'red', area: 'Orders', title, sub: 's', logos: ['shopify'], cost: { minor: 0, currency: 'USD' }, costNote: '', next: 'n', doneText: 'Nothing done yet',
  found: [], sources: [], draft: { title: 'n', lines: [], cta: 'Approve' }, draftedAt: iso(1000),
})
const ID = (k: string) => card(k).id
const rec = (reason: 'snoozed' | 'dismissed' | null, rev: number) => ({ reason, at: iso(2000), by: 'm_me', loggedAt: iso(2000), rev })
async function loaded(routes: Routes) {
  const s = server(routes)
  const agent = new HttpAgent({ fetch: s.fetch, now: () => 10_000 })
  await agent.whenLoaded()
  return { agent, ...s }
}
const puts = (calls: { method: string; path: string; body?: string }[], id: string) => calls.filter(c => c.method === 'PUT' && c.path === `/api/today/${id}/aside`).map(c => JSON.parse(c.body ?? '{}'))
const ids = (agent: HttpAgent) => agent.read().problems.map(p => p.id)

describe('reading Today', () => {
  test('the cards in the server\'s order; the records of the hidden ones are state.setAside; a snooze that ended is not hidden', async () => {
    const { agent } = await loaded(reads({ today: { items: [card('a'), card('b')], aside: { [ID('gone')]: rec('dismissed', 2), [ID('a')]: rec('snoozed', 1) } } }))
    expect(ids(agent)).toEqual([ID('a'), ID('b')])
    expect(agent.read().resources.problems).toEqual({ status: 'ready' })
    // `a` is listed, so its old snooze doesn't hide it; `gone` is not listed, so its record does.
    expect(Object.keys(agent.getSnapshot().setAside)).toEqual([ID('gone')])
    expect(agent.getSnapshot().setAside[ID('gone')]).toMatchObject({ reason: 'dismissed', by: 'm_me' })
  })
  test('the Inhouse team is asked only once its page does', async () => {
    const staff = await loaded({ ...reads({ today: { items: [card('a')], aside: {} } }), 'GET /api/me': { body: me({ role: 'inhouse' }) } })
    expect(staff.calls.map(c => c.path)).not.toContain('/api/today')
    await staff.agent.retry('problems')
    expect(ids(staff.agent)).toEqual([ID('a')])
  })
  test('a failed read is told by its resource, and retry reads again', async () => {
    let n = 0
    const { agent } = await loaded({ ...reads(), 'GET /api/today': () => (++n === 1 ? refusal(503, 'unavailable') : { body: { items: [card('a')], aside: {} } }) })
    expect(agent.read().resources.problems).toMatchObject({ status: 'error', error: 'unavailable' })
    await agent.retry('problems')
    expect(ids(agent)).toEqual([ID('a')])
  })
})

describe('setting a card aside', () => {
  const start = (extra: Routes = {}) => loaded({ ...reads({ today: { items: [card('a'), card('b'), card('c')], aside: {} } }), ...extra })

  test('a snooze leaves at once, sends rev 0, and keeps the record the server answered', async () => {
    const { agent, calls } = await start({ [`PUT /api/today/${ID('b')}/aside`]: { body: rec('snoozed', 1) } })
    const done = agent.setAside(ID('b'), 'snoozed')
    expect(ids(agent)).toEqual([ID('a'), ID('c')])
    expect(agent.getSnapshot().setAside[ID('b')]).toMatchObject({ reason: 'snoozed' })
    await done
    expect(puts(calls, ID('b'))).toEqual([{ reason: 'snoozed', ifRev: 0 }])
    expect(agent.getSnapshot().setAside[ID('b')]).toMatchObject({ reason: 'snoozed', by: 'm_me' })
  })

  test('an Undo before the first write answered waits, sends the rev the answer gave, and puts the card back where it was', async () => {
    const { agent, calls } = await start({ [`PUT /api/today/${ID('b')}/aside`]: (req: { body?: string }) => ({ body: JSON.parse(req.body ?? '{}').reason === null ? rec(null, 2) : rec('dismissed', 1) }) })
    const first = agent.setAside(ID('b'), 'dismissed')
    const back = agent.setAside(ID('b'), null)
    expect(ids(agent)).toEqual([ID('a'), ID('b'), ID('c')])
    await Promise.all([first, back])
    expect(puts(calls, ID('b'))).toEqual([{ reason: 'dismissed', ifRev: 0 }, { reason: null, ifRev: 1 }])
    expect(ids(agent)).toEqual([ID('a'), ID('b'), ID('c')])
    expect(agent.getSnapshot().setAside).toEqual({})
  })

  test('a refusal puts the card back; a conflict takes the server\'s record and reads Today again', async () => {
    const refused = await start({ [`PUT /api/today/${ID('a')}/aside`]: refusal(503, 'unavailable') })
    await expect(refused.agent.setAside(ID('a'), 'dismissed')).rejects.toMatchObject({ code: 'unavailable' })
    expect(ids(refused.agent)).toEqual([ID('a'), ID('b'), ID('c')])
    expect(refused.agent.getSnapshot().setAside).toEqual({})

    let reads2 = 0
    const conflict = await loaded({
      ...reads(),
      'GET /api/today': () => ({ body: ++reads2 === 1 ? { items: [card('a'), card('b')], aside: {} } : { items: [card('b')], aside: { [ID('a')]: rec('dismissed', 4) } } }),
      [`PUT /api/today/${ID('a')}/aside`]: refusal(409, 'conflict', { current: rec('dismissed', 4) }),
    })
    await expect(conflict.agent.setAside(ID('a'), 'snoozed')).rejects.toMatchObject({ code: 'conflict' })
    await new Promise<void>(done => { const off = conflict.agent.subscribe(() => { if (ids(conflict.agent).length === 1) { off(); done() } }) })
    expect(ids(conflict.agent)).toEqual([ID('b')])
    expect(conflict.agent.getSnapshot().setAside[ID('a')]).toMatchObject({ reason: 'dismissed' })
  })

  test('the next write on a card carries the rev the server last gave', async () => {
    const { agent, calls } = await loaded({
      ...reads({ today: { items: [card('a')], aside: { [ID('a')]: rec(null, 7) } } }),
      [`PUT /api/today/${ID('a')}/aside`]: { body: rec('dismissed', 8) },
    })
    await agent.setAside(ID('a'), 'dismissed')
    expect(puts(calls, ID('a'))).toEqual([{ reason: 'dismissed', ifRev: 7 }])
  })

  test('declined is refused without a request, and a card the client doesn\'t hold is not found', async () => {
    const { agent, calls } = await start()
    await expect(agent.setAside(ID('a'), 'declined')).rejects.toBeDefined()
    await expect(agent.setAside('p_nobodyxxxxxxxxxxxxxxxx', 'snoozed')).rejects.toMatchObject({ code: 'not_found' })
    expect(calls.filter(c => c.method === 'PUT')).toEqual([])
    expect(ids(agent)).toEqual([ID('a'), ID('b'), ID('c')])
  })

  test('an Undo of a card set aside before a reload (not held) reads Today again to bring it back', async () => {
    let reads2 = 0
    const { agent, calls } = await loaded({
      ...reads(),
      'GET /api/today': () => ({ body: ++reads2 === 1 ? { items: [card('b')], aside: { [ID('a')]: rec('dismissed', 3) } } : { items: [card('a'), card('b')], aside: { [ID('a')]: rec(null, 4) } } }),
      [`PUT /api/today/${ID('a')}/aside`]: { body: rec(null, 4) },
    })
    expect(ids(agent)).toEqual([ID('b')])
    await agent.setAside(ID('a'), null)
    expect(puts(calls, ID('a'))).toEqual([{ reason: null, ifRev: 3 }])
    expect(ids(agent)).toEqual([ID('a'), ID('b')])
    expect(agent.getSnapshot().setAside).toEqual({})
  })
})
