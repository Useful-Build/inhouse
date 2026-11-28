// Stage 1 M3-W (N32's first line), on the sandbox deploy with a real container and the scripted model (the
// `write-loop` scenario in test/scripted-model/scenarios/limits.ts): the agent itself makes 500 allowed `tag_add`
// calls of one order each, through the `actions` server, the egress's admission and the outbox's request; BrandAgent's
// own alarm sends through `HUB_WRITE` into the hub's fake Shopify write store, whose log the hook's `state` reads. The
// API twin of this proof, with a made-up run grant and no container, is e2e/api/batches.spec.ts. Oracles, the plan's
// words with N24's limits written out here:
//  - ceiling for tag_add on, per day max 200, largest call 100, bulk threshold 5, batch max 500; one permission held by
//    the member, per day 50, largest call 5 (the operation's defaults, made by "Always allow");
//  - the agent makes 500 calls of one order each: 50 run under the permission (each within every limit) and go out after
//    their holds; the calls past its day join one collecting batch; no other card;
//  - approved with `upTo = 200` and the totals the card showed: those 200 items go out, and the rest sit on a new
//    collecting card.
// Counted from the outbox's own states, never from the fake store's log: on the sandbox that log lives in one hub
// isolate's memory and can be lost or read from another (#619). So: single cards + collected items = 500;
// exactly 50 single cards hold a unit (sent, or a check); a send that fails definitely gives its unit back (N23), so the
// next call runs in its place: every extra single card is `failed`, and the spec logs why (the audit line's words for its
// code) so the cause is visible.
// The operation is turned on only through the test-fakes hook (N2, N19) and off again after, with the permission removed.
// #598: the loop takes about 25 minutes (500 calls, one at a time through the egress), so it runs ONLY when named, like
// job-soak.spec.ts: `gh workflow run sandbox-test-deploy ... -f full=true -f only="api/write-loop.spec.ts"`. It reads the workflow's
// `only` list (the step's ONLY environment) for its own name and skips everywhere else (the default agent set, a full run
// without `only`). The orchestrator names it when the outbox, the egress, permissions, the hub's writes, the actions
// server or the runner's proxy change.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { WRITE_LOOP_DONE } from '../../test/scripted-model/scenarios/limits.ts'
import { answerOf, createChat, send, textOf } from './chat-kit.ts'
import { hook, hubCall, requestAction, setCeiling } from './fakes-kit.ts'
import { actor, call, me } from './kit.ts'

const SELF = 'api/write-loop.spec.ts'
const asked = (process.env.ONLY ?? '').split(/\s+/).includes(SELF)
const dana = actor('memberA')
const TAG_ADD = 'shopify.order.tag_add'
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const LOOP_TAG = `wl-${run}`

const admin = actor('admin')

/** The newest audit line's id: the lines after it are this run's. */
const auditTop = async (request: APIRequestContext): Promise<number> => {
  const r = await call(request, admin, 'GET', '/api/audit?limit=1')
  expect(r.status, r.text).toBe(200)
  return (r.json.items as { id: number }[])[0]?.id ?? 0
}
/** The words of every "didn't go out" audit line after `since` (each the words for its failure code), newest first. */
const failuresSince = async (request: APIRequestContext, since: number): Promise<string[]> => {
  const out: string[] = []
  let cursor: string | null = null
  for (let pages = 0; pages < 200; pages++) {
    const r = await call(request, admin, 'GET', `/api/audit?limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`)
    expect(r.status, r.text).toBe(200)
    const items = r.json.items as { id: number; what: string; detail: string }[]
    for (const l of items) if (l.id > since && l.what === 'an action didn’t go out') out.push(l.detail)
    cursor = r.json.nextCursor
    if (cursor === null || items.some(l => l.id <= since)) break
  }
  return out
}

interface BatchCard {
  id: string; rev: number; state: string; kind: string; result?: string; lapsed?: string
  batch?: { itemCount: number; firstLines: string[]; totals: { records: number; units: number; unitsLabel: string } }
}
const cardsIn = async (request: APIRequestContext, chatId: string): Promise<BatchCard[]> => {
  const r = await call(request, dana, 'GET', `/api/actions?chatId=${encodeURIComponent(chatId)}`)
  expect(r.status, r.text).toBe(200)
  return r.json.items as BatchCard[]
}
/** A batch's whole list, through route 125 (100 a page). */
const itemsOf = async (request: APIRequestContext, id: string): Promise<{ n: number; state: string; result?: string }[]> => {
  const out: { n: number; state: string; result?: string }[] = []
  for (let after: number | undefined = 0; after !== undefined;) {
    const r = await call(request, dana, 'GET', `/api/actions/${id}/items?after=${after}`)
    expect(r.status, r.text).toBe(200)
    out.push(...(r.json.items as { n: number; state: string; result?: string }[]))
    after = r.json.next as number | undefined
  }
  return out
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
  if (!asked) return
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
  if (!asked) return
  await setCeiling(request, TAG_ADD, false)
  await removeTagPermissions(request)
})

test('the agent\'s loop of 500 allowed writes stops at the limit and becomes one card; approving 200 sends 200, the rest wait', async ({ request }) => {
  test.skip(!asked, `the 25-minute loop runs only when named: sandbox-test-deploy -f full=true -f only="${SELF}"`)
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
  const auditFrom = await auditTop(request)
  const chatId = await createChat(request, dana)
  const sent = await send(request, dana, chatId, `scenario:write-loop loop-tag:${LOOP_TAG} tag every order`)
  // 500 calls, one at a time through the egress: the turn takes a while. Its progress is logged as it runs, so a slow or
  // stuck loop shows how far it got.
  const progress = async () => {
    const cards = await cardsIn(request, chatId)
    const collected = cards.find(c => c.batch !== undefined && c.state === 'waiting')?.batch?.itemCount ?? 0
    const singles = cards.filter(c => c.batch === undefined)
    const by = (st: string) => singles.filter(c => c.state === st).length
    return `${singles.length} single cards (${by('sent')} sent, ${by('failed')} failed, ${by('needs_check')} checks), ${collected} collected`
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

  // The singles run under the permission go out after their holds: wait until none is still on its way.
  const final = ['sent', 'failed', 'needs_check']
  await expect.poll(async () => (await cardsIn(request, chatId)).filter(c => c.batch === undefined && !final.includes(c.state)).length,
    { timeout: 180_000, intervals: [2_000], message: 'every single card is final' }).toBe(0)
  const cards = await cardsIn(request, chatId)
  const singles = cards.filter(c => c.batch === undefined)
  const failed = singles.filter(c => c.state === 'failed')
  if (failed.length > 0) {
    // A send that failed definitely gave its unit back (N23), so a later call ran in its place. Say why it failed.
    console.log(`write-loop: ${failed.length} run(s) failed: ${JSON.stringify(failed.map(c => ({ id: c.id, result: c.result })))}; `
      + `the audit's words for their codes: ${JSON.stringify(await failuresSince(request, auditFrom))}`)
  }
  // Exactly 50 hold a unit (sent, or a check the person resolves); any more are failed, their units given back.
  expect(singles.filter(c => c.state === 'sent' || c.state === 'needs_check'), JSON.stringify(singles.map(c => c.state))).toHaveLength(50)
  expect(singles.every(c => final.includes(c.state))).toBe(true)

  // One card, and only one: the calls past the permission's day, collected. With the singles, every call is accounted for.
  const waiting = await waitingIn(request, chatId)
  expect(waiting, JSON.stringify(waiting.map(c => ({ id: c.id, kind: c.kind, batch: c.batch?.itemCount })))).toHaveLength(1)
  const batch = waiting[0]!
  const collected = 500 - singles.length
  expect(batch).toMatchObject({ kind: 'exact', state: 'waiting', batch: { itemCount: collected, totals: { records: collected, units: collected, unitsLabel: 'orders' } } })
  expect(cards.filter(c => c.batch !== undefined)).toHaveLength(1)

  // Approve what was seen, the first 200; the rest move to a new collecting card.
  const approved = await call(request, dana, 'POST', `/api/actions/${batch.id}/answer`, {
    json: { choice: 'approve', ifRev: batch.rev, upTo: 200, totals: { records: 200, units: 200 } },
  })
  expect(approved.status, approved.text).toBe(200)
  expect(approved.json).toMatchObject({ state: 'approved', batch: { itemCount: 200 } })
  const rest = await waitingIn(request, chatId)
  expect(rest).toHaveLength(1)
  expect(rest[0]).toMatchObject({ kind: 'exact', batch: { itemCount: collected - 200, totals: { records: collected - 200, units: collected - 200 } } })
  expect(rest[0]!.id).not.toBe(batch.id)

  // The 200 go out: the batch ends, and its list says each item went out (or why not).
  await expect.poll(async () => (await call(request, dana, 'GET', `/api/actions/${batch.id}`)).json.state, { timeout: 420_000, intervals: [2_000] }).toMatch(/^(sent|failed|needs_check)$/)
  const items = await itemsOf(request, batch.id)
  expect(items.map(i => i.n)).toEqual(Array.from({ length: 200 }, (_, k) => k + 1))
  const itemFailed = items.filter(i => i.state !== 'sent')
  if (itemFailed.length > 0) console.log(`write-loop: ${itemFailed.length} of the 200 items didn't go out: ${JSON.stringify(itemFailed.slice(0, 10))}`)
  expect(itemFailed, 'every approved item went out').toEqual([])
  expect((await call(request, dana, 'GET', `/api/actions/${batch.id}`)).json).toMatchObject({ state: 'sent', result: 'Sent. 200 of 200 went out' })
  // Nothing more went out: the rest wait, untouched, for their own answer, and a No ends them.
  expect((await itemsOf(request, rest[0]!.id)).every(i => i.state === 'pending')).toBe(true)
  const no = await call(request, dana, 'POST', `/api/actions/${rest[0]!.id}/answer`, {
    json: { choice: 'deny', ifRev: rest[0]!.rev, upTo: collected - 200, totals: { records: collected - 200, units: collected - 200 } },
  })
  expect(no.status, no.text).toBe(200)
  expect(no.json.state).toBe('denied')
})
