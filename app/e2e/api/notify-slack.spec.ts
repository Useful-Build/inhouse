// Slack notices (P5 W5, acceptance 6), against the test build's fake Slack Web API. `notification_send` runs through the
// test-fakes hook's `notify` op (the tool handler with this run's ids, as the MCP route would call it) and the server's own
// `sendSystemNotice` through its `systemNotice` op. The fake's post log, the bell (GET /api/notifications) and the audit log
// (the local D1) are what the specs read. Expected values are literals. Ways it can fail, written first:
//  1. a post carries a fifth parameter, an unfurl, a URL other than the app link, a live mention or a doubled escape;
//  2. a notice posts below Act, or a member id reaches Slack in any call;
//  3. a refused channel (unlisted, shared, archived, private, not a member) is posted to, or the refusal isn't audited;
//  4. a cap lets the 4th post of a run or the 21st of a day through, or a system notice eats the agent's allowance;
//  5. the delivery binding or a Slack write is reachable from the runner;
//  6. while both Slack legs are closed (server/notify-slack/slack-legs.ts, M2-F, until Wasim's Q3), either notice path makes any
//     Slack Web API call, whatever stage is stored.
// The tests of a Slack post itself (1, 3 for the hub's refusals, 4) keep their assertions and run again when that constant opens
// the legs; while it is closed they are skipped, and the closed-legs tests below stand in for them.
import { expect, test } from '@playwright/test'
import { SLACK_DELIVERY_ENABLED } from '../../server/notify-slack/slack-legs.ts'
import { actor, call, me } from './kit.ts'
import { auditAfter, auditMax, readSql, writeSql } from './db.ts'
import { createChat } from './chat-kit.ts'
import {
  CHANNEL, ensureDisconnected, expectNoRunnerPathToDelivery, fakeReset, fakeSet, fakeState, freshConnect, hook, hubCall, inhouse, newRun, notifySend, setListedChannels, setStage,
} from './fakes-kit.ts'

const dana = actor('memberA')
test.describe.configure({ mode: 'serial' })
const CLOSED = !SLACK_DELIVERY_ENABLED
const CLOSED_WHY = 'the Slack legs are closed until Q3 (server/notify-slack/slack-legs.ts); this runs again when they open'

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

test('with the legs open a notice to a listed channel posts once: four parameters, no unfurl, only the app link, mentions escaped, one escape level', async ({ request }) => {
  test.skip(CLOSED, CLOSED_WHY)
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
  for (const u of urls) expect(new URL(u).origin, `${u} is the app's own address`).toBe('https://inhouse.example.com')
})

test("the server's own notice posts to the alerts channel and doesn't reduce the agent's remaining daily count", async ({ request }) => {
  test.skip(CLOSED, CLOSED_WHY)
  const day = (await fakeState(request)).serverDay
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

for (const stage of ['Watch', 'Act', 'Run'] as const) {
  test(`with ${stage} stored, both notice paths reach the bell and the fake Slack gets no call at all`, async ({ request }) => {
    await setStage(request, stage)
    const marker = `Notice ${uniq()}`
    const known = new Set((await bell(request)).map(i => i.id))
    // The chat must be the owner's real one: a listed channel's notice goes to the bell of the person whose chat the run is in. (The
    // hook refuses a chat that isn't the member's, and a run or turn that isn't the chat's, so only the chat is named.)
    const chatId = await createChat(request, dana)
    const before = await fakeState(request)
    const mark = auditMax()
    const out = await notifySend(request, { memberId: owner, chatId }, msg({ text: `${marker} agent https://evil.test/x`, link: { kind: 'today' } }))
    expect(asText(out)).toContain('sent to the bell (not Slack)')
    expect(audited(mark, 'channel_to_bell').map(a => a.outcome)).toEqual(['posted'])
    const system = await hook(request, { op: 'systemNotice', notice: {
      key: `e2e:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { members: [owner], alertsChannel: true },
      body: `${marker} system`, link: { kind: 'today' },
    } })
    expect(system.status, system.text).toBe(200)
    expect(system.json).toEqual({ ok: true, recipients: [{ kind: 'bell', to: owner, outcome: 'posted' }, { kind: 'slack', to: 'alerts', outcome: 'skipped', detail: 'slack_off' }] })
    const after = await fakeState(request)
    expect(after.web.requests, "no Slack Web API call: the hub's delivery binding was never used").toEqual(before.web.requests)
    expect(after.web.posts).toEqual(before.web.posts)
    expect(after.web.violations).toEqual([])
    const fresh = (await bell(request)).filter(i => !known.has(i.id))
    expect(fresh.find(i => i.body?.includes(`${marker} agent`))?.body).toContain('[link removed]')
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

test('an unlisted, shared, archived, private or non-member channel is refused with a clear message, no post, and an audit line', async ({ request }) => {
  test.skip(CLOSED, CLOSED_WHY)
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
  // No URL survives. Slack syntax is stored as plain characters (`<!channel>` stays text: the bell renders plain text, and the escape
  // is the hub's, for Slack only; server/notify-slack/send.test.ts pins the same body), so this asserts the link removal, not the syntax.
  expect(mine!.body).not.toMatch(/https?:|www\.|evil\.test/)
  expect(mine!.body, 'the link became the fixed marker').toContain('[link removed]')

  const inhouseId = (await me(request, inhouse)).memberId as string
  expect(asText(await notifySend(request, newRun(owner), msg({ to: { members: [inhouseId] } })))).toContain('unknown_member')
})

test('the 4th post in one run is refused (run_cap) and the 21st in a day is refused (day_cap), both audited', async ({ request }) => {
  test.skip(CLOSED, CLOSED_WHY)
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
  expect(sys.json.ok, `the system notice was accepted: ${sys.text}`).toBe(true)
  const twentieth = newRun(owner)
  expect(asText(await notifySend(request, twentieth, msg())), 'the 20th agent post').toContain('sent')
  const dayMark = auditMax()
  expect(asText(await notifySend(request, newRun(owner), msg())), 'the 21st').toContain('day_cap')
  expect(audited(dayMark, 'day_cap').map(a => a.outcome)).toEqual(['refused'])
  writeSql("DELETE FROM notify_sends WHERE source = 'agent'")
})

test('[static] the runner has no path to the delivery binding', async () => {
  expectNoRunnerPathToDelivery()
})

test('a direct Slack write through the hub route is write_refused and posts nothing', async ({ request }) => {
  const before = (await fakeState(request)).web.posts.length
  expect(await hubCall(request, 'callTool', 'slack_send_message', { channel_id: CHANNEL.general, message: 'hello' })).toMatchObject({ ok: false, error: { code: 'write_refused' } })
  expect((await fakeState(request)).web.posts.length).toBe(before)
})
