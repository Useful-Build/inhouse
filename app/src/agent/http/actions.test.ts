// Stage 1 M2-H: the real client's actions, permissions and questions (routes 110, 111, 120 to 124, 140 and 141) over a
// fake `fetch`, and `action.updated` reaching `onActionUpdated` through the socket. Ways they could break, written first:
//  - a call to the wrong route, or with a body the server refuses (no `ifRev`, the wrong field names);
//  - route 120's filter dropped or sent in another shape (`states` comma-joined, `chatId`);
//  - an answer taken unparsed (a card with an unknown state, a permission with no `can`);
//  - a conflict that loses the record as it is now, or keeps one that doesn't parse as the record (shown as if it did);
//  - a 401 that leaves the client signed in;
//  - an `action.updated` that doesn't reach the listeners, reaches one that unsubscribed, or eats the frame the app gets.
// Wire paths and bodies are literals, never built from the code under test.
import { describe, expect, test } from 'vitest'
import type { ActionCard, Permission, Question, RunFrame } from '../types'
import { AgentError } from '../types'
import { HttpAgent } from './client'
import type { SocketLike } from './stream/socket'
import { chatRow, iso, reads, refusal, server } from './testing/fake-server'
import type { Routes } from './testing/fake-server'

const AC = 'ac_AAAAAAAAAAAAAAAAAAAAAA'
const PG = 'pg_BBBBBBBBBBBBBBBBBBBBBB'
const Q = 'q_CCCCCCCCCCCCCCCCCCCCCC'
const MEMBER = 'm_DDDDDDDDDDDDDDDDDDDDDD'

const card = (o: Partial<ActionCard> = {}): ActionCard => ({
  id: AC, rev: 1, kind: 'ask', state: 'waiting', title: 'Add a tag to order 9001', lines: ['Tag: vip'],
  tool: { accountId: 'shopify:store', label: 'Shopify' }, records: 1, reachesCustomer: false, reversible: true,
  chatId: 'c_EEEEEEEEEEEEEEEEEEEEEE', askedBy: MEMBER, askedAt: iso(1000), serverNow: iso(2000),
  can: { allowOnce: true, alwaysAllow: true, approve: false, deny: true, undo: false, resolve: false, withdraw: false }, nudgeAlways: false, approverKind: 'person', ...o,
})
const permission = (o: Partial<Permission> = {}): Permission => ({
  id: PG, rev: 1, holder: { kind: 'member', memberId: MEMBER }, operation: 'shopify.order.tag_add', title: 'Add tags to orders',
  tool: { accountId: 'shopify:store', label: 'Shopify' }, scope: 'example-write.myshopify.com', perDay: 50, limits: { perDay: 50, unitsMax: 1, unitsLabel: 'orders', effectivePerDay: 50 }, grantedBy: MEMBER, grantedAt: iso(1000),
  can: { remove: true }, ...o,
})
const question = (o: Partial<Question> = {}): Question => ({
  id: Q, state: 'open', question: 'Which box size?', options: ['Small', 'Large'], chatId: null, askedAt: iso(1000), expiresAt: iso(9000),
  answer: null, answeredBy: null, answeredAt: null, ...o,
})

const client = (routes: Routes) => {
  const s = server(routes)
  return { agent: new HttpAgent({ fetch: s.fetch, now: () => 5000 }), calls: s.calls }
}
const body = (r: { body: string | undefined }) => (r.body === undefined ? undefined : JSON.parse(r.body))
const refused = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a refusal') }, (e: unknown) => e as AgentError)

describe('actions (routes 120 to 124)', () => {
  test('the list with no filter, with states and with a chat; one card', async () => {
    const { agent, calls } = client({
      'GET /api/actions': { body: { items: [card()] } },
      'GET /api/actions?states=waiting%2Cneeds_check': { body: { items: [] } },
      'GET /api/actions?chatId=c_EEEEEEEEEEEEEEEEEEEEEE': { body: { items: [card()] } },
      [`GET /api/actions/${AC}`]: { body: card({ rev: 2 }) },
    })
    expect(await agent.actions()).toEqual([card()])
    expect(await agent.actions({ states: ['waiting', 'needs_check'] })).toEqual([])
    expect(await agent.actions({ chatId: 'c_EEEEEEEEEEEEEEEEEEEEEE' })).toEqual([card()])
    expect(await agent.action(AC)).toEqual(card({ rev: 2 }))
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'GET /api/actions', 'GET /api/actions?states=waiting%2Cneeds_check', 'GET /api/actions?chatId=c_EEEEEEEEEEEEEEEEEEEEEE', `GET /api/actions/${AC}`,
    ])
  })

  test('answer, Undo and resolve send the choice and the rev read, to their own routes, and answer the card', async () => {
    const { agent, calls } = client({
      [`POST /api/actions/${AC}/answer`]: r => ({ body: card({ rev: body(r).ifRev + 1, state: 'approved', sendAt: iso(12_000) }) }),
      [`POST /api/actions/${AC}/undo`]: r => ({ body: card({ rev: body(r).ifRev + 1, state: 'undone' }) }),
      [`POST /api/actions/${AC}/resolve`]: r => ({ body: card({ rev: body(r).ifRev + 1, state: body(r).outcome === 'sent' ? 'sent' : 'failed' }) }),
    })
    expect((await agent.answerAction(AC, 1, 'once')).state).toBe('approved')
    expect((await agent.undoAction(AC, 2)).state).toBe('undone')
    expect((await agent.resolveAction(AC, 5, 'sent')).state).toBe('sent')
    expect(calls.map(c => [c.path, body(c)])).toEqual([
      [`/api/actions/${AC}/answer`, { choice: 'once', ifRev: 1 }],
      [`/api/actions/${AC}/undo`, { ifRev: 2 }],
      [`/api/actions/${AC}/resolve`, { outcome: 'sent', ifRev: 5 }],
    ])
  })

  test('a card that does not parse rejects (unknown), never reaching the screen', async () => {
    const { agent } = client({ [`GET /api/actions/${AC}`]: { body: { ...card(), state: 'gone' } }, 'GET /api/actions': { body: { items: [{ ...card(), can: {} }] } } })
    expect(await refused(agent.action(AC))).toMatchObject({ code: 'unknown' })
    expect(await refused(agent.actions())).toMatchObject({ code: 'unknown' })
  })

  test('a conflict keeps the card as it is now when it parses, and leaves it out when it does not', async () => {
    const now = card({ rev: 3, state: 'approved', sendAt: iso(12_000) })
    const { agent } = client({
      [`POST /api/actions/${AC}/answer`]: refusal(409, 'conflict', { current: now }),
      [`POST /api/actions/${AC}/undo`]: refusal(409, 'conflict', { current: { id: AC, state: 'nope' } }),
    })
    const e = await refused(agent.answerAction(AC, 1, 'always'))
    expect(e).toBeInstanceOf(AgentError)
    expect(e).toMatchObject({ code: 'conflict', current: now })
    const bad = await refused(agent.undoAction(AC, 1))
    expect(bad.code).toBe('conflict')
    expect(bad.current).toBeUndefined()
  })

  test('a refusal comes back with its code; a 401 puts the client in the signed-out state', async () => {
    const { agent } = client({
      ...reads(),
      [`POST /api/actions/${AC}/answer`]: refusal(403, 'forbidden'),
      [`POST /api/actions/${AC}/resolve`]: refusal(401, 'unauthorized'),
    })
    await agent.whenLoaded()
    expect(await refused(agent.answerAction(AC, 1, 'approve'))).toMatchObject({ code: 'forbidden' })
    expect(agent.read().resources.meta.status).toBe('ready')
    expect(await refused(agent.resolveAction(AC, 1, 'failed'))).toMatchObject({ code: 'unauthorized' })
    expect(agent.read().resources.meta).toMatchObject({ status: 'error', error: 'unauthorized' })
  })
})

describe('permissions (routes 110 and 111)', () => {
  test('the list, and Remove with the rev read, answering the list after it', async () => {
    const { agent, calls } = client({
      'GET /api/permissions': { body: { items: [permission()] } },
      [`POST /api/permissions/${PG}/remove`]: { body: { items: [] } },
    })
    expect(await agent.permissions()).toEqual([permission()])
    expect(await agent.removePermission(PG, 1)).toEqual([])
    expect(calls.map(c => [c.method, c.path, body(c)])).toEqual([['GET', '/api/permissions', undefined], ['POST', `/api/permissions/${PG}/remove`, { ifRev: 1 }]])
  })
  test('a stale Remove rejects with the permission as it is now', async () => {
    const now = permission({ rev: 2, perDay: 10 })
    const { agent } = client({ [`POST /api/permissions/${PG}/remove`]: refusal(409, 'conflict', { current: now }) })
    expect(await refused(agent.removePermission(PG, 1))).toMatchObject({ code: 'conflict', current: now })
  })
})

describe('questions (routes 140 and 141)', () => {
  test('the open questions, and an answer with the option itself', async () => {
    const { agent, calls } = client({
      'GET /api/questions': { body: { items: [question()] } },
      [`POST /api/questions/${Q}/answer`]: r => ({ body: question({ state: 'answered', answer: body(r).choice, answeredBy: MEMBER, answeredAt: iso(3000) }) }),
    })
    expect(await agent.questions()).toEqual([question()])
    expect(await agent.answerQuestion(Q, 'Large')).toMatchObject({ state: 'answered', answer: 'Large' })
    expect(calls.map(c => [c.method, c.path, body(c)])).toEqual([['GET', '/api/questions', undefined], ['POST', `/api/questions/${Q}/answer`, { choice: 'Large' }]])
  })
  test('answered elsewhere: a conflict with the question as it is now; kept but not delivered: unavailable', async () => {
    const now = question({ state: 'answered', answer: 'Small', answeredBy: MEMBER, answeredAt: iso(3000) })
    const { agent } = client({ [`POST /api/questions/${Q}/answer`]: refusal(409, 'conflict', { current: now }) })
    expect(await refused(agent.answerQuestion(Q, 'Large'))).toMatchObject({ code: 'conflict', current: now })
    const down = client({ [`POST /api/questions/${Q}/answer`]: refusal(503, 'unavailable') })
    expect(await refused(down.agent.answerQuestion(Q, 'Large'))).toMatchObject({ code: 'unavailable' })
  })
})

class FakeSocket implements SocketLike {
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  send(d: string) { this.sent.push(JSON.parse(d)) }
  close() { /* the test never closes it */ }
  say(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
}
const RUN = 'r_AAAAAAAAAAAAAAAAAAAAAA'
const settle = () => new Promise<void>(r => setTimeout(r, 0))

test('an action.updated frame reaches the app and every action listener until it unsubscribes', async () => {
  const sockets: FakeSocket[] = []
  const s = server(reads({ chats: [chatRow('c1')] }))
  const agent = new HttpAgent({ fetch: s.fetch, now: () => 5000, origin: '', openSocket: () => { const w = new FakeSocket(); sockets.push(w); return w } })
  await agent.whenLoaded()
  const got: RunFrame[] = []
  agent.attach(RUN, f => got.push(f))
  await settle()
  sockets[0].onopen?.()
  const heard: unknown[] = []
  const off = agent.onActionUpdated(u => heard.push(u))
  const frame = (seq: number, rev: number) => ({ type: 'frame', frame: { v: 1, chatId: 'c1', runId: RUN, seq, at: iso(seq * 1000), event: { type: 'action.updated', actionId: AC, rev, state: 'approved' } } })
  sockets[0].say(frame(1, 2))
  await settle()
  off()
  sockets[0].say(frame(2, 3))
  await settle()
  expect(got.map(f => [f.seq, f.event.type])).toEqual([[1, 'action.updated'], [2, 'action.updated']])
  expect(heard).toEqual([{ actionId: AC, rev: 2 }])
})
