// Slack notices (P5 W5, acceptance 6), against the test build's fake Slack Web API. `notification_send` runs through the
// test-fakes hook's `notify` op (the tool handler with this run's ids, as the MCP route would call it) and the server's own
// `sendSystemNotice` through its `systemNotice` op. The fake's post log, the bell (GET /api/notifications) and the audit log
// (the local D1) are what the specs read. Expected values are literals. Ways it can fail, written first:
//  1. a post carries a fifth parameter, an unfurl, a URL other than the app link, a live mention or a doubled escape;
//  2. a notice posts below Act, or a member id reaches Slack in any call;
//  3. a refused channel (unlisted, shared, archived, private, not a member) is posted to, or the refusal isn't audited;
//  4. a cap lets the 4th post of a run or the 21st of a day through, or a system notice eats the agent's allowance;
//  5. the delivery binding or a Slack write is reachable from the runner.
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { actor, call, me } from './kit.ts'
import { auditAfter, auditMax, readSql, writeSql } from './db.ts'
import {
  CHANNEL, ensureDisconnected, fakeReset, fakeSet, fakeState, freshConnect, hook, hubCall, inhouse, newRun, notifySend, setListedChannels, setStage,
} from './fakes-kit.ts'

const dana = actor('memberA')
test.describe.configure({ mode: 'serial' })

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
  await setStage(request, 'Act')
  owner = (await me(request, dana)).memberId as string
})
test.afterAll(async ({ request }) => {
  await setStage(request, 'Watch')
  await fakeReset(request)
  await setListedChannels(request, [])
  await ensureDisconnected(request)
})

const bell = async (request: Parameters<typeof call>[0]) => ((await call(request, dana, 'GET', '/api/notifications')).json.items as { id: string; body?: string }[])
const audited = (mark: number, detail: string) =>
  auditAfter(mark).filter(l => l.action === 'notify.send').map(l => JSON.parse(l.args_json) as { outcome: string; detail?: string }).filter(a => a.detail === detail)

test('at Act a notice to a listed channel posts once: four parameters, no unfurl, only the app link, mentions escaped, one escape level', async ({ request }) => {
  await setStage(request, 'Act')
  const before = (await fakeState(request)).web.posts.length
  const out = await notifySend(request, newRun(owner), msg({
    title: 'Stock R&D low',
    text: 'Ping <!channel> and @here about https://evil.test/x?d=1 for R&D',
    link: { kind: 'today' },
  }))
  expect(asText(out)).toContain('sent')
  const state = await fakeState(request)
  expect(state.web.posts.length, 'one post').toBe(before + 1)
  expect(state.web.violations, 'the fake saw no forbidden parameter').toEqual([])
  const post = state.web.posts.at(-1)!
  expect(Object.keys(post).sort()).toEqual(FOUR)
  expect(post.unfurl_links).toBe('false')
  expect(post.unfurl_media).toBe('false')
  expect(post.channel).toBe(CHANNEL.opsAlerts)
  expect(post.text).toContain('R&amp;D')
  expect(post.text, 'one escape level').not.toContain('R&amp;amp;D')
  expect(post.text).not.toMatch(/<[!@#]/)
  expect(post.text, 'no live broadcast mention').not.toMatch(/@(?:here|channel|everyone)/i)
  expect(post.text).not.toContain('evil.test')
  const urls = post.text.match(/https?:\/\/[^\s>|]+/g) ?? []
  expect(urls.length, 'the app link is the one URL').toBeGreaterThan(0)
  for (const u of urls) expect(u.startsWith('https://inhouse.example.com'), `${u} is the app's own address`).toBe(true)
})

test("the server's own notice posts to the alerts channel and doesn't reduce the agent's remaining daily count", async ({ request }) => {
  const day = new Date().toISOString().slice(0, 10)
  const agentToday = () => readSql<{ n: number }>("SELECT count(*) AS n FROM notify_sends WHERE source = 'agent' AND kind = 'slack' AND day = ?", day)[0]!.n
  const agentBefore = agentToday()
  const before = (await fakeState(request)).web.posts.length
  const r = await hook(request, { op: 'systemNotice', notice: { key: `e2e:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, body: 'Two approvals are waiting.', link: { kind: 'today' } } })
  expect(r.status, r.text).toBe(200)
  const state = await fakeState(request)
  expect(state.web.posts.length, 'posted to the alerts channel').toBe(before + 1)
  expect(state.web.posts.at(-1)!.channel).toBe(CHANNEL.opsAlerts)
  expect(agentToday(), 'the agent still has the same allowance').toBe(agentBefore)
})

test('at Watch the same call reaches the bell of the chat owner and the fake records no post', async ({ request }) => {
  await setStage(request, 'Watch')
  try {
    const marker = `Watch notice ${uniq()}`
    const known = new Set((await bell(request)).map(i => i.id))
    const before = (await fakeState(request)).web.posts.length
    const out = await notifySend(request, newRun(owner), msg({ text: marker }))
    expect(asText(out)).toContain('sent to the bell')
    expect((await fakeState(request)).web.posts.length, 'no Slack post at Watch').toBe(before)
    const fresh = (await bell(request)).filter(i => !known.has(i.id))
    expect(fresh.some(i => i.body?.includes(marker)), "the owner's bell holds the notice").toBe(true)
  } finally {
    await setStage(request, 'Act')
  }
})

test('an unlisted, shared, archived, private or non-member channel is refused with a clear message, no post, and an audit line', async ({ request }) => {
  const cases: { name: string; channel: string; patch?: Record<string, unknown>; detail: string }[] = [
    { name: '#design', channel: '#design', detail: 'not_listed' },
    { name: '#partner-shared', channel: '#partner-shared', detail: 'not_listed' },
    { name: '#general shared since it was listed', channel: '#general', patch: { is_shared: true, is_ext_shared: true }, detail: 'shared_channel' },
    { name: '#general archived since', channel: '#general', patch: { is_archived: true }, detail: 'archived' },
    { name: '#general no longer a member', channel: '#general', patch: { is_member: false }, detail: 'not_member' },
    { name: '#general private since', channel: '#general', patch: { is_private: true }, detail: 'not_public' },
  ]
  for (const c of cases) {
    await fakeReset(request)
    if (c.patch) await fakeSet(request, { web: { channels: [{ id: CHANNEL.general, patch: c.patch }] } })
    const mark = auditMax()
    const before = (await fakeState(request)).web.posts.length
    const out = await notifySend(request, newRun(owner), msg({ to: { channels: [c.channel] } }))
    expect(asText(out), `${c.name}: refused`).toContain('refused')
    expect(asText(out), `${c.name}: says why`).toContain(c.detail)
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
  expect(mine!.body).not.toMatch(/https?:|www\.|<[@!#]|evil\.test/)

  const inhouseId = (await me(request, inhouse)).memberId as string
  expect(asText(await notifySend(request, newRun(owner), msg({ to: { members: [inhouseId] } })))).toContain('unknown_member')
})

test('the 4th post in one run is refused (run_cap) and the 21st in a day is refused (day_cap), both audited', async ({ request }) => {
  await fakeReset(request)
  // A fresh day's worth of counts: the caps count today's rows, so earlier specs' rows are cleared (a local D1 only).
  writeSql("DELETE FROM notify_sends WHERE source = 'agent'")
  const run = newRun(owner)
  const mark = auditMax()
  const outs: string[] = []
  for (let i = 0; i < 4; i++) outs.push(asText(await notifySend(request, run, msg())))
  expect(outs.slice(0, 3).every(o => o.includes('sent')), 'the first three post').toBe(true)
  expect(outs[3]).toContain('run_cap')
  expect(audited(mark, 'run_cap').map(a => a.outcome)).toEqual(['refused'])

  // 3 posts used so far today; 16 more in other runs make 19, a system notice runs beside them, the 20th still posts, the 21st doesn't.
  for (let r = 0; r < 6; r++) {
    const other = newRun(owner)
    for (let i = 0; i < (r < 5 ? 3 : 1); i++) expect(asText(await notifySend(request, other, msg()))).toContain('sent')
  }
  const sys = await hook(request, { op: 'systemNotice', notice: { key: `e2e:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, link: { kind: 'today' } } })
  expect(sys.status, sys.text).toBe(200)
  const twentieth = newRun(owner)
  expect(asText(await notifySend(request, twentieth, msg())), 'the 20th agent post').toContain('sent')
  const dayMark = auditMax()
  expect(asText(await notifySend(request, newRun(owner), msg())), 'the 21st').toContain('day_cap')
  expect(audited(dayMark, 'day_cap').map(a => a.outcome)).toEqual(['refused'])
  writeSql("DELETE FROM notify_sends WHERE source = 'agent'")
})

test('the delivery binding is not reachable from the runner, and a direct Slack write through the hub route is write_refused', async ({ request }) => {
  const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  // The runner's routes are six literals (the hub's `/hub/` rides the `mcp` grant); none of them is delivery, notices or Slack.
  const routes = /EGRESS_ROUTES: readonly EgressRoute\[\] = \[([^\]]*)\]/.exec(read('server/do/brand-agent/tokens.ts'))
  expect(routes, 'EGRESS_ROUTES is in server/do/brand-agent/tokens.ts').not.toBeNull()
  expect(routes![1]!.split(',').map(s => s.trim().replaceAll("'", '')).sort()).toEqual(['audit', 'events', 'files', 'mcp', 'model', 'store'])
  // The egress (the only door the runner has) holds only the ReadGateway binding of the hub.
  for (const file of ['server/egress/index.ts', 'server/egress/hub.ts']) {
    expect(read(file), `${file} holds no delivery or connect binding`).not.toMatch(/HUB_DELIVERY|HUB_CONNECT|DeliveryGateway|ConnectGateway/)
  }
  const before = (await fakeState(request)).web.posts.length
  expect(await hubCall(request, 'callTool', 'slack_send_message', { channel_id: CHANNEL.general, message: 'hello' })).toMatchObject({ ok: false, error: { code: 'write_refused' } })
  expect((await fakeState(request)).web.posts.length).toBe(before)
})
