// Stage 1 M3-W (N32's first line), on the sandbox deploy with a real container and the scripted model (`needsContainer()`;
// the `write-loop` scenario in test/scripted-model/scenarios/limits.ts): the agent itself makes 500 allowed `tag_add`
// calls of one order each, through the `actions` server, the egress's admission and the outbox's request; BrandAgent's
// own alarm sends through `HUB_WRITE` into the hub's fake Shopify write store, whose log the hook's `state` reads. The
// API twin of this proof, with a made-up run grant and no container, is e2e/api/batches.spec.ts. Oracles, the plan's
// words with N24's limits written out here:
//  - ceiling for tag_add on, per day max 200, largest call 100, bulk threshold 5, batch max 500; one permission held by
//    the member, per day 50, largest call 5 (the operation's defaults, made by "Always allow");
//  - the agent makes 500 calls of one order each: 50 run (each within every limit) and go out after their holds; calls
//    51 to 500 join one collecting batch with 450 items; no other card; the store holds 50 of the loop's writes;
//  - approved with `upTo = 200` and the totals the card showed: 200 more writes, and the 250 left sit on a new
//    collecting card.
// The operation is turned on only through the test-fakes hook (N2, N19) and off again after, with the permission removed.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { WRITE_LOOP_DONE } from '../../test/scripted-model/scenarios/limits.ts'
import { answerOf, createChat, needsContainer, send, textOf } from './chat-kit.ts'
import { hook, hubCall, requestAction, setCeiling } from './fakes-kit.ts'
import { actor, call, me } from './kit.ts'

const dana = actor('memberA')
const TAG_ADD = 'shopify.order.tag_add'
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const LOOP_TAG = `wl-${run}`

const loopWrites = async (request: APIRequestContext): Promise<number> => {
  const r = await hook(request, { op: 'state' })
  expect(r.status, r.text).toBe(200)
  return (r.json.shopifyWrite as { writes: { variables: { tags?: string[] } }[] }).writes
    .filter(w => w.variables.tags?.some(t => t.startsWith(`${LOOP_TAG}-`))).length
}

interface BatchCard {
  id: string; rev: number; state: string; kind: string; result?: string
  batch?: { itemCount: number; firstLines: string[]; totals: { records: number; units: number; unitsLabel: string } }
}
const waitingIn = async (request: APIRequestContext, chatId: string): Promise<BatchCard[]> => {
  const r = await call(request, dana, 'GET', `/api/actions?states=waiting&chatId=${encodeURIComponent(chatId)}`)
  expect(r.status, r.text).toBe(200)
  return r.json.items as BatchCard[]
}

const removeTagPermissions = async (request: APIRequestContext) => {
  const perms = await call(request, dana, 'GET', '/api/permissions')
  expect(perms.status, perms.text).toBe(200)
  for (const p of perms.json.items as { id: string; rev: number; operation: string; can: { remove: boolean } }[]) {
    if (p.operation !== TAG_ADD || !p.can.remove) continue
    const r = await call(request, dana, 'POST', `/api/permissions/${p.id}/remove`, { json: { ifRev: p.rev } })
    expect(r.status, r.text).toBe(200)
  }
}

test.beforeAll(async ({ request }) => {
  if (!process.env.E2E_TEST_BUILD_REMOTE) return
  // The Shopify account answers a read (its grant), so the hub calls it active and the write path can use it.
  expect((await hubCall(request, 'callTool', 'orders_search', { first: 1 })).ok).toBe(true)
  // A killed run may have left a permission behind: the loop starts from the one it makes itself.
  await removeTagPermissions(request)
  const set = await hook(request, { op: 'set', shopifyWrite: { faults: { [TAG_ADD]: 'succeed' } } })
  expect(set.status, set.text).toBe(200)
  const r = await hook(request, { op: 'ceiling', operation: TAG_ADD, enabled: true, perDayMax: 200, unitsMax: 100, bulkThreshold: 5, batchMax: 500 })
  expect(r.status, r.text).toBe(200)
})

test.afterAll(async ({ request }) => {
  if (!process.env.E2E_TEST_BUILD_REMOTE) return
  await setCeiling(request, TAG_ADD, false)
  await removeTagPermissions(request)
})

test('the agent\'s loop of 500 allowed writes stops at the limit and becomes one card; approving 200 sends 200, the rest wait', async ({ request }) => {
  needsContainer()
  test.setTimeout(2_700_000)
  const danaId = (await me(request, dana)).memberId

  // "Always allow" on a first card (in another chat) makes the permission (per day 50, largest call 5); that card is
  // undone in its hold, so its unit goes back and the loop has the whole day.
  const other = await createChat(request, dana)
  const first = await requestAction(request, { memberId: danaId, chatId: other }, TAG_ADD, { orderIds: ['gid://shopify/Order/9001'], tags: [`first-${run}`] })
  expect(first.outcome, JSON.stringify(first)).toBe('waiting')
  const always = await call(request, dana, 'POST', `/api/actions/${first.action.id}/answer`, { json: { choice: 'always', ifRev: first.action.rev } })
  expect(always.status, always.text).toBe(200)
  const undone = await call(request, dana, 'POST', `/api/actions/${first.action.id}/undo`, { json: { ifRev: always.json.rev } })
  expect(undone.status, undone.text).toBe(200)
  const perm = (await call(request, dana, 'GET', '/api/permissions')).json.items.find((p: { operation: string }) => p.operation === TAG_ADD)
  expect(perm).toMatchObject({ limits: { perDay: 50, unitsMax: 5 } })

  // The agent's own loop.
  const chatId = await createChat(request, dana)
  const sent = await send(request, dana, chatId, `scenario:write-loop loop-tag:${LOOP_TAG} tag every order`)
  // 500 calls, one at a time through the egress: the turn takes a while. Its progress is logged as it runs, so a slow or
  // stuck loop shows how far it got.
  const progress = async () => {
    const cards = (await call(request, dana, 'GET', `/api/actions?chatId=${encodeURIComponent(chatId)}`)).json.items as BatchCard[]
    const collected = cards.find(c => c.batch !== undefined && c.state === 'waiting')?.batch?.itemCount ?? 0
    return `${cards.filter(c => c.batch === undefined).length} single cards, ${collected} collected, ${await loopWrites(request)} writes`
  }
  await expect.poll(async () => {
    const r = await call(request, dana, 'GET', `/api/chats/${chatId}`)
    expect(r.status, r.text).toBe(200)
    const ended = (r.json.messages as { role: string; turnId: string }[]).some(m => m.role === 'agent' && m.turnId === sent.turnId)
    if (!ended) console.log(`write-loop: ${await progress()}`)
    return ended
  }, { timeout: 1_800_000, intervals: [30_000], message: 'the loop turn ends' }).toBe(true)
  const answer = await answerOf(request, dana, chatId, sent.turnId)
  expect(textOf(answer)).toBe(WRITE_LOOP_DONE)

  // One card, and only one: the 450 calls past the permission's day, collected.
  const waiting = await waitingIn(request, chatId)
  expect(waiting, JSON.stringify(waiting.map(c => ({ id: c.id, kind: c.kind, batch: c.batch?.itemCount })))).toHaveLength(1)
  const batch = waiting[0]!
  expect(batch).toMatchObject({ kind: 'exact', state: 'waiting', batch: { itemCount: 450, totals: { records: 450, units: 450, unitsLabel: 'orders' } } })
  // The 50 runs go out after their holds; nothing else does.
  await expect.poll(() => loopWrites(request), { timeout: 180_000, intervals: [2_000] }).toBe(50)

  // Approve what was seen, the first 200; the 250 after move to a new collecting card.
  const approved = await call(request, dana, 'POST', `/api/actions/${batch.id}/answer`, {
    json: { choice: 'approve', ifRev: batch.rev, upTo: 200, totals: { records: 200, units: 200 } },
  })
  expect(approved.status, approved.text).toBe(200)
  expect(approved.json).toMatchObject({ state: 'approved', batch: { itemCount: 200 } })
  const rest = await waitingIn(request, chatId)
  expect(rest).toHaveLength(1)
  expect(rest[0]).toMatchObject({ kind: 'exact', batch: { itemCount: 250, totals: { records: 250, units: 250 } } })
  expect(rest[0]!.id).not.toBe(batch.id)

  await expect.poll(() => loopWrites(request), { timeout: 300_000, intervals: [2_000] }).toBe(250)
  await expect.poll(async () => (await call(request, dana, 'GET', `/api/actions/${batch.id}`)).json.state, { timeout: 60_000, intervals: [1_000] }).toBe('sent')
  // Nothing more went out: the rest wait for their own answer, and a No ends them.
  expect(await loopWrites(request)).toBe(250)
  const no = await call(request, dana, 'POST', `/api/actions/${rest[0]!.id}/answer`, {
    json: { choice: 'deny', ifRev: rest[0]!.rev, upTo: 250, totals: { records: 250, units: 250 } },
  })
  expect(no.status, no.text).toBe(200)
  expect(no.json.state).toBe('denied')
})
