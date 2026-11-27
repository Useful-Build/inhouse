// Stage 1 M3-X (N25): admin cards through the real routes, on the local test build (CI's `test-build`, no container). A
// member's refund (an operation only an admin may approve) is made by the test-fakes hook's `action` op (the egress's own
// `actions` handler with a made-up run grant, everything after it the real path); answers go through routes 122 to 126;
// BrandAgent's own alarm sends through `HUB_WRITE` into the hub's fake Shopify write store, whose log the hook's `state`
// reads. Oracles, the plan's words written out here:
//  - a member's refund is an exact `money` card any active admin answers (`approverKind: 'admins'`), never refused;
//  - its member asker sees it in their chat waiting for "an admin", may withdraw it and can't answer it; admins see its
//    facts in Approvals, never the chat, and neither can read the other's chat;
//  - two admins answering at once give one approval, and it goes out once;
//  - an admin demoted during the hold stops the claim: nothing goes out and the card waits for any admin's OK again;
//  - a Needs a check on it is listed for an admin with Resolve (the M2-H carry-over), and its asker can't resolve it.
// A second admin is invited for the spec and removed after; the refund's ceiling row is set only through the hook and
// turned off again after (and before, in case a killed run left it on).
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { createChat } from './chat-kit.ts'
import { hook, hubCall } from './fakes-kit.ts'
import { actor, allPages, call, expectError, me, newIdentity, personActor } from './kit.ts'
import type { Actor } from './kit.ts'

const dana = actor('memberA')
const admin = actor('admin')
test.describe.configure({ mode: 'serial' })

const REFUND = 'shopify.refund.create'
/** Order 9001's unfulfilled line in the fake: $5.00 a unit, three units. */
const refundArgs = () => ({
  orderId: 'gid://shopify/Order/9001', lines: [{ lineItemId: 'gid://shopify/LineItem/90012', quantity: 1 }], amount: { minor: 500, currency: 'USD' },
  restock: false, notifyCustomer: false,
})

interface Card {
  id: string; rev: number; state: string; kind: string; approverKind: string; waitingFor?: string; chatId: string | null; result?: string; lapsed?: string
  can: { approve: boolean; deny: boolean; undo: boolean; resolve: boolean; withdraw: boolean }
}

let danaId = ''
let kit: Actor = admin
let kitId = ''
let danaChat = ''

const ceiling = async (request: APIRequestContext, enabled: boolean) => {
  const r = await hook(request, { op: 'ceiling', operation: REFUND, enabled, perDayMax: 1000, unitsMax: 50_000 })
  expect(r.status, r.text).toBe(200)
}
const fault = async (request: APIRequestContext, f: 'succeed' | 'broken_body') => {
  const r = await hook(request, { op: 'set', shopifyWrite: { faults: { [REFUND]: f } } })
  expect(r.status, r.text).toBe(200)
}
const refunds = async (request: APIRequestContext, actionId: string): Promise<number> => {
  const r = await hook(request, { op: 'state' })
  expect(r.status, r.text).toBe(200)
  return (r.json.shopifyWrite as { writes: { operation: string; variables: { idempotencyKey?: string } }[] }).writes
    .filter(w => w.operation === REFUND && w.variables.idempotencyKey === `${actionId}:1`).length
}
/** A member's refund, as the agent asks for it in Dana's chat: a waiting admins card. */
const memberRefund = async (request: APIRequestContext): Promise<string> => {
  const r = await hook(request, { op: 'action', as: { memberId: danaId, chatId: danaChat }, operation: REFUND, args: refundArgs() })
  expect(r.status, r.text).toBe(200)
  expect(r.json.result).toMatchObject({ outcome: 'waiting', action: { verdict: 'exact', guardrail: 'money', approver_kind: 'admins', approver: 'role:admin', asked_by: danaId } })
  return r.json.result.action.id as string
}
const card = async (request: APIRequestContext, who: Actor, id: string): Promise<Card> => {
  const r = await call(request, who, 'GET', `/api/actions/${id}`)
  expect(r.status, r.text).toBe(200)
  return r.json as Card
}
const answer = (request: APIRequestContext, who: Actor, id: string, choice: 'approve' | 'deny', ifRev: number) =>
  call(request, who, 'POST', `/api/actions/${id}/answer`, { json: { choice, ifRev } })
const until = (request: APIRequestContext, id: string, state: string) =>
  expect.poll(async () => (await card(request, admin, id)).state, { timeout: 45_000, intervals: [500] }).toBe(state)
const memberRow = async (request: APIRequestContext, id: string) =>
  (await allPages<{ id: string; rev: number; role: string }>(request, admin, '/api/members', 100)).items.find(m => m.id === id)!
const setRole = async (request: APIRequestContext, id: string, role: 'member' | 'admin') => {
  const r = await call(request, admin, 'PUT', `/api/members/${id}/role`, { json: { role, ifRev: (await memberRow(request, id)).rev } })
  expect(r.status, r.text).toBe(200)
}

test.beforeAll(async ({ request }) => {
  danaId = (await me(request, dana)).memberId
  await ceiling(request, false)
  // The hub's Shopify account answers a read, so it has a connect date the first request copies into D1 (M2-D).
  expect((await hubCall(request, 'callTool', 'orders_search', { first: 1 })).ok).toBe(true)
  await fault(request, 'succeed')
  await ceiling(request, true)
  // A second admin for this spec.
  const who = newIdentity('m3x-admin')
  const invited = await call(request, admin, 'POST', '/api/members/invites', { json: { name: who.name, email: who.email, role: 'admin' } })
  expect(invited.status, invited.text).toBe(201)
  kit = personActor(who)
  kitId = (await me(request, kit)).memberId
  expect(kitId).toBe(invited.json.id)
  danaChat = await createChat(request, dana)
})

test.afterAll(async ({ request }) => {
  await ceiling(request, false)
  await fault(request, 'succeed')
  if (kitId) {
    const row = await memberRow(request, kitId)
    if (row) await call(request, admin, 'DELETE', `/api/members/${kitId}?ifRev=${row.rev}`)
  }
})

test('a member\'s refund is an admins card: waiting for an admin in their chat, its facts in Approvals, no chat for the admin', async ({ request }) => {
  const id = await memberRefund(request)
  const mine = await card(request, dana, id)
  expect(mine).toMatchObject({
    kind: 'exact', state: 'waiting', approverKind: 'admins', waitingFor: 'an admin', chatId: danaChat,
    can: { approve: false, deny: false, undo: false, resolve: false, withdraw: true },
  })
  for (const who of [admin, kit]) {
    const theirs = await card(request, who, id)
    expect(theirs).toMatchObject({ approverKind: 'admins', chatId: null, can: { approve: true, deny: true, withdraw: false } })
    expect(theirs.waitingFor).toBeUndefined()
    // In Approvals, among the waiting cards.
    const waiting = await call(request, who, 'GET', '/api/actions?states=waiting')
    expect((waiting.json.items as { id: string }[]).map(c => c.id)).toContain(id)
  }
  // Neither side sees the other's chat: the admin can't read Dana's chat or list its cards; Dana can't read the admin's.
  expectError(await call(request, admin, 'GET', `/api/chats/${danaChat}`), 404, 'not_found')
  expect((await call(request, admin, 'GET', `/api/actions?chatId=${danaChat}`)).json.items).toEqual([])
  const adminChat = await createChat(request, admin)
  expectError(await call(request, dana, 'GET', `/api/chats/${adminChat}`), 404, 'not_found')
  // Its asker can't answer it; she takes it back instead, and then no admin can approve it.
  expectError(await answer(request, dana, id, 'approve', mine.rev), 403, 'forbidden', 'not_owner')
  expectError(await call(request, admin, 'POST', `/api/actions/${id}/withdraw`, { json: { ifRev: mine.rev } }), 403, 'forbidden', 'not_owner')
  const back = await call(request, dana, 'POST', `/api/actions/${id}/withdraw`, { json: { ifRev: mine.rev } })
  expect(back.status, back.text).toBe(200)
  expect(back.json).toMatchObject({ id, state: 'withdrawn' })
  expect((await answer(request, admin, id, 'approve', back.json.rev)).status).toBe(409)
  expect(await refunds(request, id)).toBe(0)
})

test('two admins answering at once give one approval, and it goes out once', async ({ request }) => {
  test.setTimeout(90_000)
  const id = await memberRefund(request)
  const { rev } = await card(request, admin, id)
  const [a, b] = await Promise.all([answer(request, admin, id, 'approve', rev), answer(request, kit, id, 'approve', rev)])
  expect([a.status, b.status].sort()).toEqual([200, 409])
  const winner = a.status === 200 ? a : b
  expect(winner.json).toMatchObject({ state: 'approved', can: { undo: true } })
  // Only the admin who approved it may undo it.
  const other = a.status === 200 ? kit : admin
  expect((await card(request, other, id)).can.undo).toBe(false)
  await until(request, id, 'sent')
  expect(await refunds(request, id)).toBe(1)
})

test('an admin demoted during the hold stops the claim: nothing goes out, and it waits for any admin again', async ({ request }) => {
  test.setTimeout(90_000)
  const id = await memberRefund(request)
  const approved = await answer(request, kit, id, 'approve', (await card(request, kit, id)).rev)
  expect(approved.status, approved.text).toBe(200)
  await setRole(request, kitId, 'member')
  try {
    await expect.poll(async () => (await card(request, admin, id)).state, { timeout: 45_000, intervals: [500] }).toBe('waiting')
    const after = await card(request, admin, id)
    expect(after).toMatchObject({ state: 'waiting', lapsed: expect.any(String), can: { approve: true } })
    expect(await refunds(request, id)).toBe(0)
    // The demoted one is a member now: another person's card isn't theirs to see or answer. The other admin can.
    expectError(await answer(request, kit, id, 'approve', after.rev), 404, 'not_found')
    expect((await answer(request, admin, id, 'approve', after.rev)).status).toBe(200)
    await until(request, id, 'sent')
    expect(await refunds(request, id)).toBe(1)
  } finally {
    await setRole(request, kitId, 'admin')
  }
})

test('a Needs a check on it is listed for an admin with Resolve; its asker can\'t resolve it', async ({ request }) => {
  test.setTimeout(90_000)
  await fault(request, 'broken_body')
  try {
    const id = await memberRefund(request)
    expect((await answer(request, admin, id, 'approve', (await card(request, admin, id)).rev)).status).toBe(200)
    await until(request, id, 'needs_check')
    for (const who of [admin, kit]) {
      const checks = await call(request, who, 'GET', '/api/actions?states=needs_check')
      expect(checks.json.items).toEqual(expect.arrayContaining([expect.objectContaining({ id, chatId: null, can: expect.objectContaining({ resolve: true }) })]))
    }
    const mine = await card(request, dana, id)
    expect(mine.can.resolve).toBe(false)
    expectError(await call(request, dana, 'POST', `/api/actions/${id}/resolve`, { json: { outcome: 'sent', ifRev: mine.rev } }), 403, 'forbidden', 'not_owner')
    const done = await call(request, kit, 'POST', `/api/actions/${id}/resolve`, { json: { outcome: 'failed', ifRev: mine.rev } })
    expect(done.status, done.text).toBe(200)
    expect(done.json).toMatchObject({ state: 'failed' })
  } finally {
    await fault(request, 'succeed')
  }
})
