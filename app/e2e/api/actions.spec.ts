// The write-safety gate through the real routes (Stage 1 M2-S; N2, N11, N12, N15, N19; P6 acceptance 1, 2, 3, 6, 7, 8,
// 9). No container: an action is made by the test-fakes hook's `action` op (the outbox's own `request`, as an active
// member, with no tool call behind it); answers, Undo, resolve, Pause, Resume and removing a permission go through
// their routes; BrandAgent's own alarm runs the send through `HUB_WRITE` into the hub's fake Shopify write store; the
// effects are read from that store's log (the hook's `state`). Oracles, the plan's words written out here:
//  - with no operation on (the product's state: no ceiling row, or only turned-off ones) every request is refused
//    `over_ceiling`, nothing is written and nothing reaches the store;
//  - a card is its asker's to answer: another member can't see it (404), an admin sees it but can't answer it (403),
//    a stale `ifRev` is 409 with the card as it is;
//  - an approved action goes out once, after its hold, and only then; Undo before the claim sends nothing, Undo after
//    it is 409;
//  - a definite refusal is `failed`; an unclear answer is "Needs a check", resolved only by its approver or an admin,
//    audited, and counted by the health route while open;
//  - Pause sends every approved, unclaimed card back to waiting with its reason; nothing is approved while paused;
//    resuming sends nothing;
//  - "Always allow" makes a permission; the next request runs under it; removing it before the claim stops the send;
//  - an operation that isn't in the table can't be requested; the runner's hub route refuses a write.
// The ceiling is set only through the hook and turned off again after (and before, in case a killed run left it on).
// The brand's Shopify account row in D1 is the real path's (M2-D): each request reads the hub's accounts and copies the
// hub's connect date and write store into `connector_accounts`, and an action's generation is that row's (N9).
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { ToolsDataSchema } from '../../shared/contract/tools.ts'
import { actor, call, expectConflict, expectError, me, newIdentity, personActor } from './kit.ts'
import { Tab } from './chat-kit.ts'
import { auditMax, readSql } from './db.ts'
import { CHANNEL, ensureDisconnected, fakeState, freshConnect, hook, hubCall, inhouse, requestAction, setCeiling, setListedChannels, SHOPIFY_ACCOUNT, sourcesUnder } from './fakes-kit.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const monitor = actor('monitor')
test.describe.configure({ mode: 'serial' })

const TAG_ADD = 'shopify.order.tag_add'
const SHOP = 'example-write'
const run = Date.now().toString(36)
let n = 0
/** A tag no other request carries: the store's log names it, so each effect is traced to its action. */
const tag = () => `m2s-${run}-${++n}`
const tagArgs = (t: string) => ({ orderIds: ['gid://shopify/Order/9001'], tags: [t] })

let danaId = ''
let adminId = ''

interface StoreWrite { operation: string; variables: { id0?: string; tags?: string[] }; outcome: string }
const storeWrites = async (request: APIRequestContext): Promise<StoreWrite[]> => {
  const r = await hook(request, { op: 'state' })
  expect(r.status, r.text).toBe(200)
  return (r.json.shopifyWrite as { writes: StoreWrite[] }).writes
}
const writesOf = async (request: APIRequestContext, t: string) => (await storeWrites(request)).filter(w => w.variables.tags?.includes(t))
const setFault = async (request: APIRequestContext, fault: 'succeed' | 'refuse' | 'timeout' | 'broken_body') => {
  const r = await hook(request, { op: 'set', shopifyWrite: { faults: { [TAG_ADD]: fault } } })
  expect(r.status, r.text).toBe(200)
}

const card = async (request: APIRequestContext, id: string, who = dana) => {
  const r = await call(request, who, 'GET', `/api/actions/${id}`)
  expect(r.status, r.text).toBe(200)
  return r.json as { id: string; rev: number; state: string; kind: string; lapsed?: string; result?: string; sendAt?: { ms: number }; serverNow: { ms: number } }
}
const answer = (request: APIRequestContext, who: typeof dana, id: string, choice: 'once' | 'always' | 'approve' | 'deny', ifRev: number) =>
  call(request, who, 'POST', `/api/actions/${id}/answer`, { json: { choice, ifRev } })
/** Polls the card until it reaches `state` (BrandAgent's alarm runs the send after the 10 s hold). */
const until = async (request: APIRequestContext, id: string, state: string) =>
  expect.poll(async () => (await card(request, id)).state, { timeout: 45_000, intervals: [500] }).toBe(state)

/** A new card for Dana (a waiting `ask` card), its id. */
async function ask(request: APIRequestContext, t: string): Promise<string> {
  const r = await requestAction(request, { memberId: danaId }, TAG_ADD, tagArgs(t))
  expect(r.outcome, JSON.stringify(r)).toBe('waiting')
  expect(r.action).toMatchObject({ state: 'waiting', verdict: 'ask', asked_by: danaId, approver: danaId })
  return r.action.id as string
}
/** Dana allows it once; the card is approved with its hold. */
async function allowOnce(request: APIRequestContext, id: string): Promise<{ rev: number; sendAtMs: number }> {
  const r = await answer(request, dana, id, 'once', (await card(request, id)).rev)
  expect(r.status, r.text).toBe(200)
  expect(r.json.state).toBe('approved')
  expect(r.json.sendAt.ms - r.json.serverNow.ms).toBe(10_000)
  return { rev: r.json.rev, sendAtMs: r.json.sendAt.ms }
}

const needsCheckDetail = async (request: APIRequestContext): Promise<string | undefined> => {
  const r = await call(request, monitor, 'GET', '/api/health')
  const s = (r.json.signals as { name: string; detail?: string }[]).find(x => x.name === 'outbox_needs_check')
  expect(s, 'the health route names the outbox_needs_check signal').toBeDefined()
  return s?.detail
}

/**
 * A fresh member, signed in with a socket open, then removed: how the socket ends. BrandAgent closes it `4401` at once;
 * the local runtime finishes the close when the object next goes idle (it evicts an object after 10 s with nothing to
 * do), so the wait is the object's, not ours.
 */
async function removedMemberSocket(request: APIRequestContext): Promise<{ code: number | null }> {
  const who = newIdentity('actions-socket')
  const invited = await call(request, admin, 'POST', '/api/members/invites', { json: { name: who.name, email: who.email, role: 'member' } })
  expect(invited.status, invited.text).toBe(201)
  expect((await call(request, personActor(who), 'GET', '/api/me')).status).toBe(200)
  const tab = await Tab.open(personActor(who))
  let page = (await call(request, admin, 'GET', '/api/members?limit=100')).json as { items: { id: string; rev: number }[]; nextCursor: string | null }
  let rev: number | null = null
  for (let k = 0; k < 100 && rev === null; k++) {
    rev = page.items.find(m => m.id === invited.json.id)?.rev ?? null
    if (rev === null && page.nextCursor !== null) page = (await call(request, admin, 'GET', `/api/members?limit=100&cursor=${encodeURIComponent(page.nextCursor)}`)).json
    else if (rev === null) break
  }
  expect(rev, 'the invited member is listed').not.toBeNull()
  const removed = await call(request, admin, 'DELETE', `/api/members/${invited.json.id}?ifRev=${rev}`)
  expect(removed.status, removed.text).toBe(200)
  await tab.until(() => tab.closed !== null, 'the socket to close', 30_000)
  return { code: tab.closed?.code ?? null }
}

test.beforeAll(async ({ request }) => {
  danaId = (await me(request, dana)).memberId
  adminId = (await me(request, admin)).memberId
  // A run that was killed may have left the operation on: turn it off (through the hook, never by hand).
  if (readSql('SELECT 1 FROM permission_ceiling WHERE enabled = 1').length > 0) await setCeiling(request, TAG_ADD, false)
  // The hub's Shopify account answers a read (its client-credentials grant), and its connect date is the generation the
  // hub checks at send (`expect.connectedAtMs`); the first request copies it into D1 (M2-D's sync).
  expect((await hubCall(request, 'callTool', 'orders_search', { first: 1 })).ok).toBe(true)
  await setFault(request, 'succeed')
})

test.afterAll(async ({ request }) => {
  await setCeiling(request, TAG_ADD, false)
  await setFault(request, 'succeed')
  await call(request, admin, 'POST', '/api/resume', { json: {} })
})

test('the product\'s state (no operation on): every request is refused, nothing is written and nothing is sent', async ({ request }) => {
  // No seed and no route writes the ceiling (N2), so no operation is on. The table may hold a turned-off row (the hook's
  // `ceiling` off keeps the row, and another spec may have run first); `decide` treats it as it treats no row at all.
  expect(readSql('SELECT operation FROM permission_ceiling WHERE enabled = 1')).toEqual([])
  const rowsBefore = readSql<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_actions')[0].n
  const writesBefore = (await storeWrites(request)).length
  const t = tag()
  for (const who of [danaId, adminId]) {
    for (const mode of ['tool', 'ask_only'] as const) {
      const shop = await requestAction(request, { memberId: who }, TAG_ADD, tagArgs(t), { mode })
      expect(shop).toMatchObject({ outcome: 'refused', reason: 'over_ceiling' })
      // Slack may be refused sooner (not connected, or the channel not listed): refused either way, nothing written.
      const slack = await requestAction(request, { memberId: who }, 'slack.channel.post', { channel: '#ops', text: t }, { mode })
      expect(slack.outcome).toBe('refused')
      expect(['over_ceiling', 'account_unavailable', 'not_listed']).toContain(slack.reason)
    }
  }
  expect(readSql<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_actions')[0].n).toBe(rowsBefore)
  expect((await storeWrites(request)).length).toBe(writesBefore)
})

test('M2-D: a request copies the hub\'s connect date and write store into D1, and the card waits on that generation', async ({ request }) => {
  await setCeiling(request, TAG_ADD, true)
  const id = await ask(request, tag())
  const since = ToolsDataSchema.parse((await call(request, inhouse, 'GET', '/api/tools')).json).details.shopify?.since?.ms
  expect(since, 'the hub gives the Shopify account a connect date').toBeDefined()
  expect(readSql('SELECT last_state, connected_at_ms, shop FROM connector_accounts WHERE account_id = ?', SHOPIFY_ACCOUNT))
    .toEqual([{ last_state: 'connected', connected_at_ms: since, shop: SHOP }])
  expect(readSql('SELECT account_gen, scope_json, tool_use_id IS NOT NULL AS invoked FROM outbox_actions WHERE id = ?', id))
    .toEqual([{ account_gen: since, scope_json: JSON.stringify({ shop: SHOP }), invoked: 1 }])
  await setCeiling(request, TAG_ADD, false)
})

test('an operation that isn\'t in the table can\'t be requested; the runner\'s hub route refuses a write', async ({ request }) => {
  const writesBefore = (await storeWrites(request)).length
  const r = await hook(request, { op: 'action', as: { memberId: danaId }, operation: 'shopify.order.refund', args: {} })
  expect(r.status, r.text).toBe(400)
  expect(r.json.error.code).toBe('invalid')
  // The agent's hub route (the egress `/hub/` handler with a run's scope) never runs a write, by any name.
  for (const name of ['shopify_order_tag_add', TAG_ADD, 'orders_update']) expect((await hubCall(request, 'callTool', name, tagArgs(tag()))).ok).toBe(false)
  // STATIC: the runner's routes and the egress never name the write binding or its entrypoint; only the dispatcher does
  // (server/outbox/boundary.test.ts checks the rest of server/).
  for (const [file, text] of [...sourcesUnder('server/egress'), ...sourcesUnder('server/mcp'), ...sourcesUnder('runner/src')]) {
    expect(text, `${file} names no write binding`).not.toMatch(/HUB_WRITE|WriteGateway/)
  }
  expect((await storeWrites(request)).length).toBe(writesBefore)
})

test('a card is its asker\'s: another member can\'t see it, an admin can\'t answer it, a stale ifRev is 409', async ({ request }) => {
  await setCeiling(request, TAG_ADD, true)
  const id = await ask(request, tag())
  expectError(await call(request, leo, 'GET', `/api/actions/${id}`), 404, 'not_found')
  expectError(await answer(request, leo, id, 'once', 1), 404, 'not_found')
  expect((await card(request, id, admin)).state).toBe('waiting')
  expectError(await answer(request, admin, id, 'once', 1), 403, 'forbidden', 'not_owner')
  expect(expectConflict(await answer(request, dana, id, 'once', 7))).toMatchObject({ id, rev: 1, state: 'waiting' })
  // "Approve" is for an exact card; this one asks.
  expectError(await answer(request, dana, id, 'approve', 1), 400, 'invalid')
  const denied = await answer(request, dana, id, 'deny', 1)
  expect(denied.status, denied.text).toBe(200)
  expect(denied.json.state).toBe('denied')
})

test('Undo before the claim sends nothing; an approved action goes out once, after its hold; Undo after it is 409', async ({ request }) => {
  test.setTimeout(120_000)
  const undoneTag = tag()
  const undone = await ask(request, undoneTag)
  const held = await allowOnce(request, undone)
  const u = await call(request, dana, 'POST', `/api/actions/${undone}/undo`, { json: { ifRev: held.rev } })
  expect(u.status, u.text).toBe(200)
  expect(u.json.state).toBe('undone')

  const sentTag = tag()
  const sent = await ask(request, sentTag)
  const approved = await allowOnce(request, sent)
  expect(approved.sendAtMs).toBeGreaterThan(held.sendAtMs)
  // Before the hold ends nothing has reached the store.
  expect(await writesOf(request, sentTag)).toEqual([])
  await until(request, sent, 'sent')
  const after = await card(request, sent)
  expect(after.serverNow.ms).toBeGreaterThanOrEqual(approved.sendAtMs)
  expect(after.result).toBeTruthy()
  expect(await writesOf(request, sentTag)).toEqual([{ operation: TAG_ADD, variables: { tags: [sentTag], id0: 'gid://shopify/Order/9001' }, outcome: 'succeed' }])
  // The undone action's task came due first, and it sent nothing.
  expect(await writesOf(request, undoneTag)).toEqual([])
  expect((await card(request, undone)).state).toBe('undone')
  // Undo or another answer after the send: 409 with the card as it is; still one write.
  expect(expectConflict(await call(request, dana, 'POST', `/api/actions/${sent}/undo`, { json: { ifRev: after.rev } }))).toMatchObject({ state: 'sent' })
  expect(expectConflict(await answer(request, dana, sent, 'once', after.rev))).toMatchObject({ state: 'sent' })
  expect(await writesOf(request, sentTag)).toHaveLength(1)
})

test('Pause sends an approved card back to waiting; nothing is approved while paused; resuming sends nothing', async ({ request }) => {
  test.setTimeout(120_000)
  const pausedTag = tag()
  const id = await ask(request, pausedTag)
  await allowOnce(request, id)
  const p = await call(request, admin, 'POST', '/api/pause', { json: {} })
  expect(p.status, p.text).toBe(200)
  await until(request, id, 'waiting')
  expect((await card(request, id)).lapsed).toBe('The agent was paused, so this needs your OK again.')
  const whilePaused = await answer(request, dana, id, 'once', (await card(request, id)).rev)
  expect(whilePaused.status, whilePaused.text).toBe(409)
  expect(whilePaused.json.error).toMatchObject({ code: 'conflict', reason: 'paused' })
  const r = await call(request, admin, 'POST', '/api/resume', { json: {} })
  expect(r.status, r.text).toBe(200)
  // Resuming sends nothing: a later approval goes out, and the paused one is still waiting with nothing at the store.
  const laterTag = tag()
  const later = await ask(request, laterTag)
  await allowOnce(request, later)
  await until(request, later, 'sent')
  expect((await card(request, id)).state).toBe('waiting')
  expect(await writesOf(request, pausedTag)).toEqual([])
  expect(await writesOf(request, laterTag)).toHaveLength(1)
})

test('a definite refusal is failed; an unclear answer needs a check, resolved by an admin, audited and counted', async ({ request }) => {
  test.setTimeout(150_000)
  await setFault(request, 'refuse')
  const refusedTag = tag()
  const refused = await ask(request, refusedTag)
  await allowOnce(request, refused)
  await until(request, refused, 'failed')
  expect(await writesOf(request, refusedTag)).toEqual([expect.objectContaining({ outcome: 'refuse' })])

  await setFault(request, 'broken_body')
  const unclearTag = tag()
  const unclear = await ask(request, unclearTag)
  await allowOnce(request, unclear)
  await until(request, unclear, 'needs_check')
  await setFault(request, 'succeed')
  expect(await writesOf(request, unclearTag)).toHaveLength(1)
  const openDetail = await needsCheckDetail(request)
  expect(openDetail).toMatch(/^\d+ need a check$/)
  const open = Number(openDetail?.split(' ')[0])
  const c = await card(request, unclear)
  // Another member can't see it; the admin resolves it, with one audit line, and the signal counts one fewer.
  expectError(await call(request, leo, 'POST', `/api/actions/${unclear}/resolve`, { json: { outcome: 'failed', ifRev: c.rev } }), 404, 'not_found')
  const mark = auditMax()
  const done = await call(request, admin, 'POST', `/api/actions/${unclear}/resolve`, { json: { outcome: 'failed', ifRev: c.rev } })
  expect(done.status, done.text).toBe(200)
  expect(done.json.state).toBe('failed')
  const lines = readSql<{ action: string; actor_id: string; args_json: string }>(
    "SELECT action, actor_id, args_json FROM audit_log WHERE id > ? AND target_kind = 'action' AND target_id = ? ORDER BY id", mark, unclear)
  expect(lines.map(l => [l.action, l.actor_id])).toEqual([['action.resolved', adminId]])
  expect(JSON.parse(lines[0].args_json)).toMatchObject({ actionId: unclear, outcome: 'failed' })
  expect(await needsCheckDetail(request)).toBe(open === 1 ? undefined : `${open - 1} need a check`)
  expect(expectConflict(await call(request, admin, 'POST', `/api/actions/${unclear}/resolve`, { json: { outcome: 'sent', ifRev: c.rev } }))).toMatchObject({ state: 'failed' })
  // Nothing was sent again by the system.
  expect(await writesOf(request, unclearTag)).toHaveLength(1)
})

test('"Always allow" makes a permission and the next request runs under it; removing it before the claim stops the send', async ({ request }) => {
  test.setTimeout(150_000)
  const firstTag = tag()
  const first = await ask(request, firstTag)
  const a = await answer(request, dana, first, 'always', 1)
  expect(a.status, a.text).toBe(200)
  expect(a.json.state).toBe('approved')
  await until(request, first, 'sent')
  const perms = await call(request, dana, 'GET', '/api/permissions')
  expect(perms.status, perms.text).toBe(200)
  const grant = (perms.json.items as { id: string; rev: number; operation: string; holder: { memberId?: string } }[]).find(g => g.operation === TAG_ADD && g.holder.memberId === danaId)
  expect(grant, 'Always allow made Dana a permission').toBeDefined()

  // The next request under it is approved at once (no card), and goes out only after the hold.
  const runTag = tag()
  const r = await requestAction(request, { memberId: danaId }, TAG_ADD, tagArgs(runTag))
  expect(r.outcome).toBe('approved')
  expect(r.action).toMatchObject({ verdict: 'run', grant_id: grant!.id, state: 'approved' })
  // Removed during the hold: the claim finds no live permission, nothing is sent, and the card asks again.
  const removed = await call(request, dana, 'POST', `/api/permissions/${grant!.id}/remove`, { json: { ifRev: grant!.rev } })
  expect(removed.status, removed.text).toBe(200)
  await until(request, r.action.id, 'waiting')
  expect((await card(request, r.action.id)).lapsed).toBe('The permission was removed, so this needs your OK again.')
  expect(await writesOf(request, runTag)).toEqual([])
  // And the next request asks.
  const next = await requestAction(request, { memberId: danaId }, TAG_ADD, tagArgs(tag()))
  expect(next).toMatchObject({ outcome: 'waiting', action: { verdict: 'ask' } })
})

test('turning the operation off refuses the next request and lapses an approval before its claim', async ({ request }) => {
  test.setTimeout(120_000)
  const offTag = tag()
  const id = await ask(request, offTag)
  await allowOnce(request, id)
  await setCeiling(request, TAG_ADD, false)
  await until(request, id, 'waiting')
  expect((await card(request, id)).lapsed).toBe('This kind of action was turned off, so this needs your OK again.')
  expect(await requestAction(request, { memberId: danaId }, TAG_ADD, tagArgs(tag()))).toMatchObject({ outcome: 'refused', reason: 'over_ceiling' })
  expect(await writesOf(request, offTag)).toEqual([])
})

// M2-D's done-when, the Slack half: a post to a listed channel goes end to end through the egress handler and the
// outbox into the fake Slack, once. The product dates Slack's connect by its own clock; the request copies the hub's date
// in (N9), so the hub's `expect.connectedAtMs` check passes instead of refusing every send as stale.
test('M2-D: a Slack post to a listed channel, asked through the egress, answered, sent once to the fake Slack', async ({ request }) => {
  test.setTimeout(120_000)
  await freshConnect(request)
  await setListedChannels(request, [CHANNEL.opsAlerts])
  const name = readSql<{ name: string }>('SELECT name FROM notify_channels WHERE channel_id = ? AND removed_at_ms IS NULL', CHANNEL.opsAlerts)[0]!.name
  await setCeiling(request, 'slack.channel.post', true)
  try {
    const token = `m2d-${run}-slack`
    const before = (await fakeState(request)).web.posts.length
    const r = await requestAction(request, { memberId: danaId }, 'slack.channel.post', { channel: `#${name}`, text: `Restock note ${token}` })
    expect(r.outcome, JSON.stringify(r)).toBe('waiting')
    expect(JSON.parse(r.action.scope_json)).toEqual({ channelId: CHANNEL.opsAlerts })
    const hubGen = readSql<{ connected_at_ms: number }>("SELECT connected_at_ms FROM connector_accounts WHERE account_id = 'slack:workspace'")[0]!.connected_at_ms
    expect(r.action.account_gen).toBe(hubGen)
    await allowOnce(request, r.action.id)
    await until(request, r.action.id, 'sent')
    const posts = (await fakeState(request)).web.posts.slice(before).filter(p => (p.text ?? '').includes(token))
    expect(posts.map(p => p.channel)).toEqual([CHANNEL.opsAlerts])
  } finally {
    await setCeiling(request, 'slack.channel.post', false)
    await setListedChannels(request, [])
    await ensureDisconnected(request)
  }
})

// The dispatcher once kept every write binding's answer, and Workers RPC keeps a call's context open until its answer is
// released, so after the first send BrandAgent never went idle again and a removed member's socket never finished closing
// (socket.spec.ts's removal test, which runs after this spec). After the sends above it still closes.
test('after real sends, removing a member still closes their socket with 4401', async ({ request }) => {
  test.setTimeout(90_000)
  expect(await removedMemberSocket(request)).toEqual({ code: 4401 })
})
