// Asks in the agent's flow with a real container (Stage 1 M2-D, N14; the scripted scenarios in
// test/scripted-model/scenarios/actions.ts). Needs a container (`needsContainer()`): it runs on the sandbox deploy only.
//  - `action-tag-add`: the agent calls the `actions` server's `shopify_order_tag_add`; the runner's audit hook records the
//    call, the egress admits it, makes the card (or, under an earlier "Always allow", approves it) and waits; the person
//    allows it once through the real route; the egress's wait returns the result inline; the scenario's next turn checks
//    that result names the action. The fake write store gets the tag once, and the turn's stored messages carry its `ask`
//    part.
//  - `action-approval-request`: `approval_request` through the `inhouse` server makes a card and doesn't wait.
// The operation is turned on only through the test-fakes hook (N2, N19) and off again after.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { ACTION_DONE, ACTION_TAG, APPROVAL_ASKED } from '../../test/scripted-model/scenarios/actions.ts'
import { answerOf, createChat, needsContainer, send, textOf } from './chat-kit.ts'
import { hook, hubCall, setCeiling } from './fakes-kit.ts'
import { actor, call } from './kit.ts'

const dana = actor('memberA')
const TAG_ADD = 'shopify.order.tag_add'
test.describe.configure({ mode: 'serial' })

interface Card { id: string; rev: number; state: string; kind: string }
const cardsOf = async (request: APIRequestContext, chatId: string): Promise<Card[]> => {
  const r = await call(request, dana, 'GET', `/api/actions?chatId=${encodeURIComponent(chatId)}`)
  expect(r.status, r.text).toBe(200)
  return r.json.items as Card[]
}
const tagWrites = async (request: APIRequestContext): Promise<number> => {
  const r = await hook(request, { op: 'state' })
  expect(r.status, r.text).toBe(200)
  return (r.json.shopifyWrite as { writes: { variables: { tags?: string[] } }[] }).writes.filter(w => w.variables.tags?.includes(ACTION_TAG)).length
}

test.beforeAll(async ({ request }) => {
  if (!process.env.E2E_TEST_BUILD_REMOTE) return
  // The Shopify account answers a read (its grant), so the hub calls it active and the write path can use it.
  expect((await hubCall(request, 'callTool', 'orders_search', { first: 1 })).ok).toBe(true)
  await setCeiling(request, TAG_ADD, true)
})

test.afterAll(async ({ request }) => {
  if (!process.env.E2E_TEST_BUILD_REMOTE) return
  await setCeiling(request, TAG_ADD, false)
})

test('M2-D: the agent\'s write tool waits for the person\'s OK, and the sent result comes back inline in the same turn', async ({ request }) => {
  needsContainer()
  test.setTimeout(300_000)
  const before = await tagWrites(request)
  const chat = await createChat(request, dana)
  const sent = await send(request, dana, chat, 'scenario:action-tag-add tag order 9001')
  // The card appears while the tool call waits; allow it once (an earlier "Always allow" may have approved it already).
  let card: Card | undefined
  await expect.poll(async () => (card = (await cardsOf(request, chat))[0]) !== undefined, { timeout: 120_000, intervals: [1_000], message: 'the card appears' }).toBe(true)
  if (card!.state === 'waiting') {
    const r = await call(request, dana, 'POST', `/api/actions/${card!.id}/answer`, { json: { choice: card!.kind === 'exact' ? 'approve' : 'once', ifRev: card!.rev } })
    expect(r.status, r.text).toBe(200)
  }
  const answer = await answerOf(request, dana, chat, sent.turnId, 180_000)
  expect(textOf(answer)).toBe(ACTION_DONE)
  expect((await cardsOf(request, chat)).map(c => [c.id, c.state])).toEqual([[card!.id, 'sent']])
  expect(await tagWrites(request)).toBe(before + 1)
  // The turn's stored messages carry the card's `ask` part.
  const stored = (await call(request, dana, 'GET', `/api/chats/${chat}`)).json.messages as { turnId: string; part?: { type: string; actionId?: string } }[]
  expect(stored.filter(m => m.turnId === sent.turnId && m.part?.type === 'ask').map(m => m.part!.actionId)).toEqual([card!.id])
})

test('M2-D: approval_request from the agent makes a card for the person and doesn\'t wait', async ({ request }) => {
  needsContainer()
  test.setTimeout(240_000)
  const chat = await createChat(request, dana)
  const sent = await send(request, dana, chat, 'scenario:action-approval-request ask before tagging order 9001')
  const answer = await answerOf(request, dana, chat, sent.turnId, 180_000)
  expect(textOf(answer)).toBe(APPROVAL_ASKED)
  const cards = await cardsOf(request, chat)
  expect(cards.map(c => c.state)).toEqual(['waiting'])
  // Cleaned up: the person says no.
  const r = await call(request, dana, 'POST', `/api/actions/${cards[0]!.id}/answer`, { json: { choice: 'deny', ifRev: cards[0]!.rev } })
  expect(r.status, r.text).toBe(200)
})
