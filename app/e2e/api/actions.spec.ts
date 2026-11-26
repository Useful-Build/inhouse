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
// The brand's Shopify account row in D1 is written here at the hub's own connect date: the product records no
// `connected_at_ms` for the client-credentials Shopify account, and an action's generation is that row's (N9).
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { ToolsDataSchema } from '../../shared/contract/tools.ts'
import { actor, call, expectConflict, expectError, me, newIdentity, personActor } from './kit.ts'
import { Tab } from './chat-kit.ts'
import { auditMax, readSql, writeSql } from './db.ts'
import { hook, hubCall, inhouse, requestAction, setCeiling, SHOPIFY_ACCOUNT, sourcesUnder } from './fakes-kit.ts'

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
const tagArgs = (t: string) => ({ orderId: 'gid://shopify/Order/9001', tags: [t] })

let danaId = ''
let adminId = ''
let priorAccount: Record<string, unknown> | undefined

interface StoreWrite { operation: string; variables: { id?: string; tags?: string[] }; outcome: string }
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
  const r = await requestAction(request, { memberId: danaId }, TAG_ADD, tagArgs(t), { shop: SHOP })
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

// DIAGNOSTIC (temporary, M2-S review round 2): after each test, how long a removed member's socket takes to close.
async function socketProbe(request: APIRequestContext, label: string): Promise<void> {
  const who = newIdentity('ws-probe')
  const invited = await call(request, admin, 'POST', '/api/members/invites', { json: { name: who.name, email: who.email, role: 'member' } })
  await call(request, personActor(who), 'GET', '/api/me')
  const tab = await Tab.open(personActor(who))
  const list = await call(request, admin, 'GET', '/api/members?limit=200')
  const rev = (list.json.items as { id: string; rev: number }[]).find(m => m.id === invited.json.id)?.rev ?? 0
  const t0 = Date.now()
  const del = await call(request, admin, 'DELETE', `/api/members/${invited.json.id}?ifRev=${rev}`)
  try {
    await tab.until(() => tab.closed !== null, 'close', 25_000)
    console.log(`PROBE ${label}: delete ${del.status}, closed ${tab.closed?.code} after ${Date.now() - t0} ms`)
  } catch {
    console.log(`PROBE ${label}: delete ${del.status}, NOT closed after ${Date.now() - t0} ms`)
    tab.close()
  }
}
test.afterEach(async ({ request }, info) => { test.setTimeout(info.timeout + 40_000); await socketProbe(request, info.title.slice(0, 40)) })

test.beforeAll(async ({ request }) => {
  await socketProbe(request, 'before the spec')
  danaId = (await me(request, dana)).memberId
  adminId = (await me(request, admin)).memberId
  // A run that was killed may have left the operation on: turn it off (through the hook, never by hand).
  if (readSql('SELECT 1 FROM permission_ceiling WHERE enabled = 1').length > 0) await setCeiling(request, TAG_ADD, false)
  // The hub's Shopify account answers a read (its client-credentials grant), and its connect date is the generation the
  // hub checks at send (`expect.connectedAtMs`).
  expect((await hubCall(request, 'callTool', 'orders_search', { first: 1 })).ok).toBe(true)
  const tools = ToolsDataSchema.parse((await call(request, inhouse, 'GET', '/api/tools')).json)
  const since = tools.details.shopify?.since?.ms
  expect(since, 'the hub gives the Shopify account a connect date').toBeDefined()
  priorAccount = readSql('SELECT * FROM connector_accounts WHERE account_id = ?', SHOPIFY_ACCOUNT)[0]
  writeSql(
    `INSERT INTO connector_accounts (account_id, connector, last_state, last_state_at_ms, connected_at_ms) VALUES (?, 'shopify', 'connected', ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET last_state = 'connected', connected_at_ms = excluded.connected_at_ms, disconnected_at_ms = NULL`,
    SHOPIFY_ACCOUNT, since as number, since as number,
  )
  await setFault(request, 'succeed')
})

test.afterAll(async ({ request }) => {
  await setCeiling(request, TAG_ADD, false)
  await setFault(request, 'succeed')
  await call(request, admin, 'POST', '/api/resume', { json: {} })
  if (priorAccount === undefined) writeSql('DELETE FROM connector_accounts WHERE account_id = ?', SHOPIFY_ACCOUNT)
  else {
    writeSql('UPDATE connector_accounts SET last_state = ?, connected_at_ms = ?, disconnected_at_ms = ? WHERE account_id = ?',
      priorAccount.last_state as string, priorAccount.connected_at_ms as number | null, priorAccount.disconnected_at_ms as number | null, SHOPIFY_ACCOUNT)
  }
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
      const shop = await requestAction(request, { memberId: who }, TAG_ADD, tagArgs(t), { mode, shop: SHOP })
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
  expect(await writesOf(request, sentTag)).toEqual([{ operation: TAG_ADD, variables: { id: 'gid://shopify/Order/9001', tags: [sentTag] }, outcome: 'succeed' }])
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
  const r = await requestAction(request, { memberId: danaId }, TAG_ADD, tagArgs(runTag), { shop: SHOP })
  expect(r.outcome).toBe('approved')
  expect(r.action).toMatchObject({ verdict: 'run', grant_id: grant!.id, state: 'approved' })
  // Removed during the hold: the claim finds no live permission, nothing is sent, and the card asks again.
  const removed = await call(request, dana, 'POST', `/api/permissions/${grant!.id}/remove`, { json: { ifRev: grant!.rev } })
  expect(removed.status, removed.text).toBe(200)
  await until(request, r.action.id, 'waiting')
  expect((await card(request, r.action.id)).lapsed).toBe('The permission was removed, so this needs your OK again.')
  expect(await writesOf(request, runTag)).toEqual([])
  // And the next request asks.
  const next = await requestAction(request, { memberId: danaId }, TAG_ADD, tagArgs(tag()), { shop: SHOP })
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
  expect(await requestAction(request, { memberId: danaId }, TAG_ADD, tagArgs(tag()), { shop: SHOP })).toMatchObject({ outcome: 'refused', reason: 'over_ceiling' })
  expect(await writesOf(request, offTag)).toEqual([])
})
