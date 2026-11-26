// Slack notices (P5 W5, acceptance 6; Stage 1 M2-N, Q3 = A), against the test build's fake Slack Web API. `notification_send`
// runs through the test-fakes hook's `notify` op (the tool handler with this run's ids and the egress's wiring, with the hook's
// stand-in admission, as the MCP route would call it) and the server's own `sendSystemNotice` through its `systemNotice` op.
// The fake's post log, the outbox's cards (GET /api/actions/:id), the channel list, the bell and the audit log (the local D1)
// are what the specs read. Expected values are literals. Ways it can fail, written first:
//  1. a post carries a fifth parameter, an unfurl, any URL (an outbox post carries no app link), a live mention or a doubled
//     escape;
//  2. the agent's post to a listed channel goes out without a live grant or an approval: with no grant it must wait for its
//     card; only the brand's grant (an admin marking the channel for alerts) sends it after the hold; with the operation off
//     (the product's state) it's refused and nothing is asked; a member id reaches Slack in any call;
//  3. a refused channel (unlisted for the agent; shared, archived, private or not a member for the server's notice) is
//     posted to, or the refusal isn't audited;
//  4. the grant's daily limit lets a post through past it, or a system notice eats the agent's allowance;
//  5. the delivery binding or a Slack write is reachable from the runner;
//  6. a stored stage changes anything.
// Until M2-N both Slack legs were closed and the Slack post tests skipped; they run again here, rewritten where the agent's
// path changed (the PR lists each).
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, me } from './kit.ts'
import { auditAfter, auditMax, readSql } from './db.ts'
import { createChat } from './chat-kit.ts'
import {
  CHANNEL, ensureDisconnected, expectNoRunnerPathToDelivery, fakeReset, fakeSet, fakeState, freshConnect, hook, hubCall, inhouse, newRun, notifySend, setCeiling,
  setListedChannels, setStage,
} from './fakes-kit.ts'

const dana = actor('memberA')
const admin = actor('admin')
test.describe.configure({ mode: 'serial' })
const POST = 'slack.channel.post'

/** The four parameters `chat.postMessage` may carry, sorted (the fake's own rule, written out here as the oracle). */
const FOUR = ['channel', 'text', 'unfurl_links', 'unfurl_media']
const uniq = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const msg = (over: Record<string, unknown> = {}) => ({ to: { channels: ['#ops-alerts'] }, title: 'Stock low', text: `Fern mug ${uniq()}`, format: 'message', ...over })
const asText = (v: unknown) => JSON.stringify(v)

let owner = ''
test.beforeAll(async ({ request }) => {
  await fakeReset(request)
  await freshConnect(request)
  await setListedChannels(request, [CHANNEL.opsAlerts, CHANNEL.general], true)
  owner = (await me(request, dana)).memberId as string
  // A run that was killed may have left the operation on.
  if (readSql("SELECT 1 FROM permission_ceiling WHERE operation = 'slack.channel.post' AND enabled = 1").length > 0) await setCeiling(request, POST, false)
})
test.afterAll(async ({ request }) => {
  await setCeiling(request, POST, false)
  await setStage(request, 'Watch')
  await fakeReset(request)
  await setListedChannels(request, [])
  await ensureDisconnected(request)
})

const bell = async (request: APIRequestContext) => ((await call(request, dana, 'GET', '/api/notifications')).json.items as { id: string; body?: string }[])
const audited = (mark: number, detail: string) =>
  auditAfter(mark).filter(l => l.action === 'notify.send').map(l => JSON.parse(l.args_json) as { outcome: string; detail?: string }).filter(a => a.detail === detail)
/** The channel list as a member reads it (route F): each channel, the alerts mark and, on the alerts channel, the brand's grant. */
const listed = async (request: APIRequestContext) =>
  (await call(request, dana, 'GET', '/api/notify/channels')).json.channels as { channelId: string; name: string; alerts: boolean; permission?: { id: string; scope: string; perDay: number } }[]
/** A brand admin saves the list with the alerts mark on `alertsChannelId` (route H): the mark gives the brand's grant (M2-N). */
async function markAlerts(request: APIRequestContext, alertsChannelId: string | null) {
  const cur = await call(request, admin, 'GET', '/api/notify/channels')
  const r = await call(request, admin, 'PUT', '/api/notify/channels', { json: { channelIds: (cur.json.channels as { channelId: string }[]).map(c => c.channelId), alertsChannelId, ifRev: cur.json.rev } })
  expect(r.status, r.text).toBe(200)
}
/** The card the outbox made for a recipient, from the tool's structured answer. */
const actionOf = (out: { result: { structuredContent: { recipients: { to: string; approval_id?: string; status?: string; created?: boolean; detail?: string }[] } } }, to = '#ops-alerts') =>
  out.result.structuredContent.recipients.find(r => r.to === to)!
const card = async (request: APIRequestContext, id: string) => (await call(request, dana, 'GET', `/api/actions/${id}`)).json as { state: string; kind: string; rev: number; lapsed?: string }
/** Polls the card until it reaches `state` (BrandAgent's alarm runs the send after the 10 s hold). */
const until = (request: APIRequestContext, id: string, state: string) => expect.poll(async () => (await card(request, id)).state, { timeout: 45_000, intervals: [500] }).toBe(state)

test('the product\'s state (no operation on): a listed channel is refused, nothing is asked, the alerts mark gives no grant, Slack gets no call', async ({ request }) => {
  await markAlerts(request, null)
  await markAlerts(request, CHANNEL.opsAlerts)
  expect((await listed(request)).find(c => c.channelId === CHANNEL.opsAlerts)).toEqual({ channelId: CHANNEL.opsAlerts, name: 'ops-alerts', alerts: true })
  const before = await fakeState(request)
  const rows = readSql<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_actions')[0]!.n
  const out = await notifySend(request, newRun(owner), msg())
  expect(actionOf(out)).toMatchObject({ kind: 'slack', outcome: 'refused', detail: 'over_ceiling' })
  expect(asText(out)).toContain('This kind of action is turned off for this brand')
  expect(readSql<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_actions')[0]!.n).toBe(rows)
  expect((await fakeState(request)).web.requests).toEqual(before.web.requests)
})

test('a listed channel without the grant: a card waits for the person and nothing reaches Slack until they approve it', async ({ request }) => {
  test.setTimeout(120_000)
  await setCeiling(request, POST, true)
  try {
    await markAlerts(request, null)
    expect((await listed(request)).every(c => c.permission === undefined), 'no grant on the list').toBe(true)
    const token = `nogrant-${uniq()}`
    const before = await fakeState(request)
    const out = await notifySend(request, newRun(owner), msg({ text: `${token} restock` }))
    const a = actionOf(out)
    expect(a).toMatchObject({ kind: 'slack', outcome: 'asked', status: 'waiting', created: true })
    expect(asText(out)).toContain("waiting for a person's OK")
    expect(await card(request, a.approval_id!)).toMatchObject({ state: 'waiting', kind: 'ask' })
    expect((await fakeState(request)).web.requests, 'no Slack call while it waits').toEqual(before.web.requests)
    // Dana allows it once: it goes after the hold, once.
    const c = await card(request, a.approval_id!)
    const r = await call(request, dana, 'POST', `/api/actions/${a.approval_id}/answer`, { json: { choice: 'once', ifRev: c.rev } })
    expect(r.status, r.text).toBe(200)
    await until(request, a.approval_id!, 'sent')
    expect((await fakeState(request)).web.posts.filter(p => (p.text ?? '').includes(token)).map(p => p.channel)).toEqual([CHANNEL.opsAlerts])
  } finally {
    await setCeiling(request, POST, false)
  }
})

test('a listed channel with the brand\'s grant (the admin\'s alerts mark): listed with its scope and daily limit, posted once after the hold: four parameters, no unfurl, no URL, mentions escaped, one escape level', async ({ request }) => {
  test.setTimeout(120_000)
  await setCeiling(request, POST, true, 30)
  try {
    await markAlerts(request, null)
    await markAlerts(request, CHANNEL.opsAlerts)
    const ops = (await listed(request)).find(c => c.channelId === CHANNEL.opsAlerts)!
    expect(ops).toMatchObject({ alerts: true, permission: { scope: '#ops-alerts', perDay: 30 } })
    expect(readSql<{ holder: string; granted_role: string }>('SELECT holder, granted_role FROM permission_grants WHERE id = ?', ops.permission!.id)).toEqual([{ holder: 'brand', granted_role: 'admin' }])
    const before = (await fakeState(request)).web.posts.length
    const out = await notifySend(request, newRun(owner), msg({
      title: 'Stock R&D low',
      text: 'Ping <!channel> and @here about https://evil.test/x?d=1 for R&D',
      link: { kind: 'today' },
    }))
    const a = actionOf(out)
    expect(a).toMatchObject({ outcome: 'asked', status: 'approved', created: true })
    expect(asText(out)).toContain('approved under a standing permission')
    await until(request, a.approval_id!, 'sent')
    const state = await fakeState(request)
    expect(state.web.posts.length, 'one post').toBe(before + 1)
    expect(state.web.violations, 'the fake saw no forbidden parameter').toEqual([])
    const post = state.web.posts.at(-1)!
    expect(Object.keys(post).sort()).toEqual(FOUR)
    expect(post.unfurl_links).toBe('false')
    expect(post.unfurl_media).toBe('false')
    expect(post.channel).toBe(CHANNEL.opsAlerts)
    expect(post.text).toContain('Stock R&amp;D low')
    expect(post.text).toContain('R&amp;D')
    expect(post.text, 'one escape level').not.toContain('R&amp;amp;D')
    expect(post.text).not.toMatch(/<[!@#]/)
    expect(post.text, 'no live broadcast mention').not.toMatch(/@(?:here|channel|everyone)/i)
    expect(post.text).not.toContain('evil.test')
    expect(post.text.match(/https?:\/\/[^\s>|]+/g) ?? [], 'an outbox post carries no URL').toEqual([])
  } finally {
    await setCeiling(request, POST, false)
  }
})

test('the grant\'s daily limit: past it, the post becomes an exact card (count), never a send', async ({ request }) => {
  await setCeiling(request, POST, true, 1)
  try {
    await markAlerts(request, null)
    await markAlerts(request, CHANNEL.opsAlerts)
    // Today's uses of earlier tests' grants don't count: this mark made a fresh grant.
    const first = actionOf(await notifySend(request, newRun(owner), msg()))
    expect(first).toMatchObject({ status: 'approved' })
    const second = actionOf(await notifySend(request, newRun(owner), msg()))
    expect(second).toMatchObject({ status: 'waiting', created: true })
    expect(readSql<{ verdict: string; guardrail: string | null }>('SELECT verdict, guardrail FROM outbox_actions WHERE id = ?', second.approval_id!)).toEqual([{ verdict: 'exact', guardrail: 'count' }])
    // The first one is undone in its hold, so nothing is left to send after this test.
    const c = await card(request, first.approval_id!)
    expect((await call(request, dana, 'POST', `/api/actions/${first.approval_id}/undo`, { json: { ifRev: c.rev } })).status).toBe(200)
  } finally {
    await setCeiling(request, POST, false)
  }
})

test('a new card while the alerts channel is set: the server\'s fixed "Approval waiting" notice posts there once, with no card lines', async ({ request }) => {
  await setCeiling(request, POST, true)
  try {
    await markAlerts(request, null)
    await markAlerts(request, CHANNEL.opsAlerts)
    const token = `alerted-${uniq()}`
    const before = (await fakeState(request)).web.posts.length
    // #general has no grant (only the alerts channel does): the post is a card.
    const a = actionOf(await notifySend(request, newRun(owner), msg({ to: { channels: ['#general'] }, text: `${token} restock` })), '#general')
    expect(a).toMatchObject({ status: 'waiting', created: true })
    await expect.poll(async () => (await fakeState(request)).web.posts.length, { timeout: 15_000, intervals: [250] }).toBe(before + 1)
    const post = (await fakeState(request)).web.posts.at(-1)!
    expect(post.channel).toBe(CHANNEL.opsAlerts)
    expect(post.text.startsWith('*Approval waiting*'), post.text).toBe(true)
    expect(post.text, 'never the card\'s lines').not.toContain(token)
    expect(post.text).toContain(`/approvals/${a.approval_id}|Open in Inhouse>`)
    // The card is withdrawn by its person, so nothing is left waiting after this test.
    const c = await card(request, a.approval_id!)
    expect((await call(request, dana, 'POST', `/api/actions/${a.approval_id}/answer`, { json: { choice: 'deny', ifRev: c.rev } })).status).toBe(200)
  } finally {
    await setCeiling(request, POST, false)
  }
})

test("the server's own notice posts to the alerts channel without a card and doesn't reduce the agent's allowance", async ({ request }) => {
  const day = (await fakeState(request)).serverDay
  const agentToday = () => readSql<{ n: number }>("SELECT count(*) AS n FROM notify_sends WHERE source = 'agent' AND kind = 'slack' AND day = ?", day)[0]!.n
  const agentBefore = agentToday()
  const before = (await fakeState(request)).web.posts.length
  const r = await hook(request, { op: 'systemNotice', notice: { key: `e2e:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, body: 'Two approvals are waiting.', link: { kind: 'today' } } })
  expect(r.status, r.text).toBe(200)
  expect(r.json).toEqual({ ok: true, recipients: [{ kind: 'slack', to: 'alerts', outcome: 'posted' }] })
  const state = await fakeState(request)
  expect(state.web.posts.length, 'posted to the alerts channel').toBe(before + 1)
  expect(state.web.posts.at(-1)!.channel).toBe(CHANNEL.opsAlerts)
  expect(agentToday(), 'the agent still has the same allowance').toBe(agentBefore)
})

for (const stage of ['Watch', 'Act', 'Run'] as const) {
  test(`with ${stage} stored, the agent's post is refused while the operation is off and the server's notice posts once`, async ({ request }) => {
    await setStage(request, stage)
    const marker = `Notice ${uniq()}`
    const known = new Set((await bell(request)).map(i => i.id))
    const chatId = await createChat(request, dana)
    const before = await fakeState(request)
    const out = await notifySend(request, { memberId: owner, chatId }, msg({ to: { members: [owner], channels: ['#ops-alerts'] }, text: `${marker} agent https://evil.test/x`, link: { kind: 'today' } }))
    expect(actionOf(out)).toMatchObject({ outcome: 'refused', detail: 'over_ceiling' })
    const system = await hook(request, { op: 'systemNotice', notice: {
      key: `e2e:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { members: [owner], alertsChannel: true },
      body: `${marker} system`, link: { kind: 'today' },
    } })
    expect(system.status, system.text).toBe(200)
    expect(system.json).toEqual({ ok: true, recipients: [{ kind: 'bell', to: owner, outcome: 'posted' }, { kind: 'slack', to: 'alerts', outcome: 'posted' }] })
    const after = await fakeState(request)
    expect(after.web.posts.slice(before.web.posts.length).map(p => p.channel), "only the server's notice was posted").toEqual([CHANNEL.opsAlerts])
    expect(after.web.violations).toEqual([])
    const fresh = (await bell(request)).filter(i => !known.has(i.id))
    expect(fresh.find(i => i.body?.includes(`${marker} agent`))?.body, "the member's own bell copy").toContain('[link removed]')
    expect(fresh.some(i => i.body?.includes(`${marker} system`))).toBe(true)
  })
}

test('an unlisted channel is refused and audited, and the fake Slack gets no call', async ({ request }) => {
  for (const channel of ['#design', '#partner-shared']) {
    const mark = auditMax()
    const before = await fakeState(request)
    const out = asText(await notifySend(request, newRun(owner), msg({ to: { channels: [channel] } })))
    expect(out, `${channel}: refused`).toContain('refused')
    expect(out, `${channel}: says why`).toContain('not_listed')
    expect((await fakeState(request)).web.requests, `${channel}: no Slack call`).toEqual(before.web.requests)
    expect(audited(mark, 'not_listed').map(a => a.outcome), `${channel}: audited as refused`).toEqual(['refused'])
  }
})

test("the alerts channel shared, archived, private or no longer a member since it was listed: the server's notice is refused with a clear reason, no post, and an audit line", async ({ request }) => {
  const cases: { name: string; patch: Record<string, unknown>; detail: string }[] = [
    { name: 'shared since it was listed', patch: { is_shared: true, is_ext_shared: true }, detail: 'shared_channel' },
    { name: 'archived since', patch: { is_archived: true }, detail: 'archived' },
    { name: 'no longer a member', patch: { is_member: false }, detail: 'not_member' },
    { name: 'private since', patch: { is_private: true }, detail: 'not_public' },
  ]
  for (const c of cases) {
    await fakeReset(request)
    await fakeSet(request, { web: { channels: [{ id: CHANNEL.opsAlerts, patch: c.patch }] } })
    const mark = auditMax()
    const before = (await fakeState(request)).web.posts.length
    const r = await hook(request, { op: 'systemNotice', notice: { key: `e2e:${uniq()}`, source: 'approvals', kind: 'approval_sent', to: { alertsChannel: true }, link: { kind: 'today' } } })
    expect(r.json, c.name).toEqual({ ok: true, recipients: [{ kind: 'slack', to: 'alerts', outcome: 'refused', detail: c.detail }] })
    expect((await fakeState(request)).web.posts.length, `${c.name}: no post`).toBe(before)
    expect(audited(mark, c.detail).map(a => a.outcome), `${c.name}: audited as refused`).toEqual(['refused'])
  }
  await fakeReset(request)
})

test('a member id reaches the bell and never Slack; the stored text has no URL or Slack syntax; an Inhouse member id is unknown_member', async ({ request }) => {
  await fakeReset(request)
  const marker = `Bell notice ${uniq()}`
  const known = new Set((await bell(request)).map(i => i.id))
  const slackBefore = await fakeState(request)
  const out = await notifySend(request, newRun(owner), msg({
    to: { members: [owner] },
    title: 'Check this',
    text: `${marker} see https://evil.test/?d=1 and <!channel> and <@U0TEST0009>`,
  }))
  expect(asText(out)).toContain('sent')
  const after = await fakeState(request)
  expect(after.web.posts.length, 'a member notice posts nothing').toBe(slackBefore.web.posts.length)
  // No call to either fake carried the member id or any Slack user id.
  const everything = asText({ web: after.web.requests.slice(slackBefore.web.requests.length), mcp: after.mcp.requests.slice(slackBefore.mcp.requests.length) })
  expect(everything).not.toContain(owner)
  expect(everything).not.toMatch(/\b[UW]0TEST\d+/)
  const fresh = (await bell(request)).filter(i => !known.has(i.id))
  const mine = fresh.find(i => i.body?.includes(marker))
  expect(mine, 'the bell holds the notice').toBeTruthy()
  // No URL survives. Slack syntax is stored as plain characters (`<!channel>` stays text: the bell renders plain text, and the escape
  // is the hub's, for Slack only; server/notify-slack/send.test.ts pins the same body), so this asserts the link removal, not the syntax.
  expect(mine!.body).not.toMatch(/https?:|www\.|evil\.test/)
  expect(mine!.body, 'the link became the fixed marker').toContain('[link removed]')

  const inhouseId = (await me(request, inhouse)).memberId as string
  expect(asText(await notifySend(request, newRun(owner), msg({ to: { members: [inhouseId] } })))).toContain('unknown_member')
})

test('[static] the runner has no path to the delivery binding', async () => {
  expectNoRunnerPathToDelivery()
})

test('a direct Slack write through the hub route is refused there (not on the read list) and posts nothing', async ({ request }) => {
  const before = (await fakeState(request)).web.posts.length
  expect(await hubCall(request, 'callTool', 'slack_send_message', { channel_id: CHANNEL.general, message: 'hello' })).toMatchObject({ ok: false, error: { code: 'not_listed' }, refusedBy: 'egress' })
  expect((await fakeState(request)).web.posts.length).toBe(before)
})
