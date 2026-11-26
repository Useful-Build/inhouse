// notification_send as the model sees it (p5-w4.md section 2; Stage 1 M2-N, Q3 = A), in the Workers runtime on the real
// migrations, with the real outbox behind the Slack leg: the input schema's limits and the result text's closed list.
// Ways it can fail, written down first:
//  1. the schema lets through more recipients than the design allows, an unknown key, or a free-form link;
//  2. the result text says "sent" for a Slack post that only waits for a person, or leaks anything but the closed
//     reasons, the outbox's own words, ids and listed names;
//  3. a post to a listed channel goes anywhere but the outbox: the hub, a bell, or a row of ours; or the outbox is asked
//     without N14's admission, or for a channel a replay's first try never asked for;
//  4. a post runs without a live grant: no grant gives a card; only the brand's grant (the alerts mark) or the person's
//     own "Always allow" approves it, and a routine's post never runs under a grant;
//  5. with the operation off (N2: every deployable build) anything is asked or written.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../db/ids.ts'
import { notifyChannelStore } from '../../../notify-slack/channels.ts'
import { HUB_FACTS, resetOutbox } from '../../../outbox/test-support.ts'
import type { OutboxActionRow } from '../../../outbox/types.ts'
import type { HubAccountFacts } from '../../../outbox/facts.ts'
import { account, ceiling, person } from '../../../permissions/test-support.ts'
import type { ToolScope } from '../../server/tool.ts'
import { notifyDeps } from './deps.ts'
import type { NotifyAdmitted, NotifyWiring } from './deps.ts'
import { NotificationSendInput, notificationSend } from './send.ts'

const db = env.DB
let u = 0
const uniq = () => `${++u}q${Math.random().toString(36).slice(2, 8)}`
const SLACK_GEN = 2_000
const OWNER = 'm_ns_owner'
const ADMIN = 'm_ns_admin'
const CREATOR = 'm_ns_creator'

/** The egress's wiring with a stand-in admission: each call admitted as a fresh main-agent call, or as `next` says. */
function wiring(o: { admit?: (input: unknown) => NotifyAdmitted | null; routineAsker?: string | null; hub?: HubAccountFacts[] } = {}) {
  const scheduled: { actionId: string; atMs: number }[] = []
  const noted: string[] = []
  const admitted: unknown[] = []
  const w: NotifyWiring = {
    hubAccounts: async () => o.hub ?? HUB_FACTS,
    admit: async (_scope, input) => {
      admitted.push(input)
      return o.admit ? o.admit(input) : { toolUseId: `toolu_${uniq()}`, jobId: null, replay: false }
    },
    routineAsker: async () => (o.routineAsker ? { memberId: o.routineAsker, role: 'member' } : null),
    noted: async (_scope, actionId) => { noted.push(actionId) },
    schedule: async (actionId, atMs) => { scheduled.push({ actionId, atMs }) },
  }
  return { deps: notifyDeps(w), scheduled, noted, admitted }
}

async function setup(o: { ceiling?: boolean } = {}) {
  await resetOutbox(db)
  await person(db, OWNER, 'member')
  await person(db, ADMIN, 'admin')
  await person(db, CREATOR, 'member')
  await account(db, 'slack:workspace', SLACK_GEN)
  if (o.ceiling ?? true) await ceiling(db, 'slack.channel.post', { enabled: true, perDayMax: 50, loweredRev: 1 })
  await db.prepare("INSERT INTO notify_channels (channel_id, name, alerts, added_by, added_at_ms) VALUES ('C0TEST0001', 'ops-alerts', 0, 'm_system', 1), ('C0TEST0002', 'general', 0, 'm_system', 1)").run()
  const chatId = `c_${uniq()}`
  await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, 'T', 1, 1)").bind(chatId, OWNER).run()
  const scope: ToolScope = { memberId: OWNER, chatId, runId: `r_${uniq().padEnd(22, 'Z').slice(0, 22)}`, turnId: `t_${uniq().padEnd(22, 'Z').slice(0, 22)}`, nowMs: Date.UTC(2026, 5, 1) + u * 1_000, requestId: `mcp-${uniq()}` }
  return { scope }
}

/** The admin marks a channel for alerts through the real store: the brand's grant follows the mark (M2-N). */
async function markAlerts(channelId: string | null, actorId = ADMIN) {
  const store = notifyChannelStore({ db })
  const current = await store.list()
  return store.save({ channels: current.channels.map(c => ({ channelId: c.channelId, name: c.name })), alertsChannelId: channelId, ifRev: current.rev }, { actorId, requestId: `req-${uniq()}`, nowMs: Date.UTC(2026, 5, 1) })
}

const text = (r: { content: { text: string }[] }) => r.content[0]!.text
const adminsBell = async (marker: string) => (await db.prepare("SELECT COUNT(*) AS n FROM notices WHERE audience = 'admins' AND body LIKE ?").bind(`%${marker}%`).first<number>('n'))!
const actions = async () => (await db.prepare('SELECT * FROM outbox_actions ORDER BY created_at_ms, id').all<OutboxActionRow>()).results
const send = (args: unknown, scope: ToolScope, deps: ReturnType<typeof wiring>['deps'] | undefined) =>
  notificationSend.call(NotificationSendInput.parse(args), scope, { db, ...(deps ? { notify: deps } : {}) })

describe('the input schema', () => {
  const ok = (v: unknown) => NotificationSendInput.safeParse(v).success
  const base = { to: { channels: ['#ops-alerts'] }, title: 'T', text: 'x', format: 'message' }
  it('takes the design’s shape', () => {
    expect(ok(base)).toBe(true)
    expect(ok({ ...base, to: { members: Array.from({ length: 20 }, (_, i) => `m_${i}`) } })).toBe(true)
    expect(ok({ ...base, title: '\u{1F600}'.repeat(120), text: '\u{1F600}'.repeat(1500) })).toBe(true)
    expect(ok({ ...base, link: { kind: 'approval', id: 'ap_1' } })).toBe(true)
  })
  it.each([
    ['no recipient', { ...base, to: {} }],
    ['21 members', { ...base, to: { members: Array.from({ length: 21 }, (_, i) => `m_${i}`) } }],
    ['4 channels', { ...base, to: { channels: ['a', 'b', 'c', 'd'] } }],
    ['a 121 code point title', { ...base, title: '\u{1F600}'.repeat(121) }],
    ['a 1,501 code point text', { ...base, text: 'a'.repeat(1501) }],
    ['an email recipient', { ...base, to: { emails: ['a@example.com'] } }],
    ['a URL link', { ...base, link: { kind: 'url', id: 'https://x.example.com' } }],
    ['an extra key', { ...base, blocks: [] }],
    ['another format', { ...base, format: 'html' }],
  ])('refuses %s', (_, v) => expect(ok(v)).toBe(false))
})

describe('a post to a listed channel follows the same rule as any Slack post (M2-N, Q3 = A)', () => {
  beforeEach(() => { u += 1 })

  it('no grant: a card waits for the person, with the cleaned headline and text; nothing is scheduled', async () => {
    const { scope } = await setup()
    const w = wiring()
    const args = { to: { members: [OWNER, 'm_nobody'], channels: ['#ops-alerts', 'random'] }, title: 'Low stock', text: 'See https://x.example.com <!here>', format: 'message', link: { kind: 'today' } }
    const r = await send(args, scope, w.deps)
    const [row] = await actions()
    expect(text(r).split('\n')).toEqual([
      `${OWNER}: sent`,
      'm_nobody: refused: unknown_member',
      `#ops-alerts: waiting for a person's OK: nothing goes to Slack until they approve it in Approvals (approval_id: ${row!.id})`,
      '#random: refused: not_listed (listed: #general, #ops-alerts)',
      'changed: links removed',
      'changed: mentions escaped',
    ])
    expect(r.isError).toBeUndefined()
    expect([row!.state, row!.verdict, row!.operation, row!.origin, row!.asked_by, row!.approver, row!.chat_id, row!.scope_key]).toEqual(['waiting', 'ask', 'slack.channel.post', 'chat', OWNER, OWNER, scope.chatId, 'channelId=C0TEST0001'])
    expect(JSON.parse(row!.args_json)).toEqual({ channel: 'C0TEST0001', text: 'See [link removed] <!here>', title: 'Low stock' })
    expect(JSON.parse(row!.card_json)).toMatchObject({ title: 'Post to #ops-alerts in Slack', lines: ['Low stock', 'See [link removed] <!here>'] })
    expect(w.admitted, 'admitted once, on the call as the model sent it').toEqual([NotificationSendInput.parse(args)])
    expect(w.noted).toEqual([row!.id])
    expect(w.scheduled).toEqual([])
    expect((await db.prepare("SELECT COUNT(*) AS n FROM notify_sends WHERE kind = 'slack'").first<number>('n'))).toBe(0)
  })

  it("the brand's grant (the admin marked the channel for alerts): approved, scheduled after the hold, its use reserved", async () => {
    const { scope } = await setup()
    await markAlerts('C0TEST0001')
    const grant = await db.prepare("SELECT * FROM permission_grants WHERE holder = 'brand' AND revoked_at_ms IS NULL").first<{ id: string; scope_key: string; per_day: number; granted_by: string }>()
    expect(grant).toMatchObject({ scope_key: 'channelId=C0TEST0001', per_day: 50, granted_by: ADMIN })
    const w = wiring()
    const r = await send({ to: { channels: ['ops-alerts', '#general'] }, title: 'T', text: 'x', format: 'report' }, scope, w.deps)
    const all = await actions()
    const ops = all.find(a => a.scope_key === 'channelId=C0TEST0001')
    const general = all.find(a => a.scope_key === 'channelId=C0TEST0002')
    expect(text(r).split('\n')).toEqual([
      `#ops-alerts: approved under a standing permission: it posts to Slack after a short hold (approval_id: ${ops!.id})`,
      `#general: waiting for a person's OK: nothing goes to Slack until they approve it in Approvals (approval_id: ${general!.id})`,
    ])
    expect([ops!.state, ops!.verdict, ops!.grant_id, ops!.approved_by]).toEqual(['approved', 'run', grant!.id, `grant:${grant!.id}`])
    expect([general!.state, general!.grant_id]).toEqual(['waiting', null])
    expect(w.scheduled).toEqual([{ actionId: ops!.id, atMs: ops!.send_at_ms }])
    expect(await db.prepare('SELECT grant_id FROM permission_uses WHERE action_id = ?').bind(ops!.id).first<string>('grant_id')).toBe(grant!.id)
    // One call, two channels: each action keyed on the invocation plus its channel.
    expect(ops!.tool_use_id!.endsWith('#C0TEST0001') && general!.tool_use_id!.endsWith('#C0TEST0002')).toBe(true)
    expect(ops!.tool_use_id!.split('#')[0]).toBe(general!.tool_use_id!.split('#')[0])
  })

  // The orchestrator's decision (review round 1): while the operation is off the notice doesn't vanish: the chat owner's
  // bell gets it, as before M2-N, and the agent reads that it didn't go to Slack.
  it('the operation off (no ceiling row, the product\'s state): no card, nothing to Slack; the bell copy, and the agent is told', async () => {
    const { scope } = await setup({ ceiling: false })
    await markAlerts('C0TEST0001')
    expect(await db.prepare('SELECT COUNT(*) AS n FROM permission_grants').first<number>('n'), 'no grant without the operation').toBe(0)
    const w = wiring()
    const r = await send({ to: { channels: ['ops-alerts'] }, title: 'T', text: 'x off', format: 'message' }, scope, w.deps)
    expect(text(r)).toBe('#ops-alerts: sent to the bell (not Slack): Slack posts are turned off for this brand, so it went to the bell, not Slack.')
    expect((r.structuredContent as { recipients: unknown[] }).recipients).toEqual([{ to: 'ops-alerts', kind: 'bell', outcome: 'posted', detail: 'channel_to_bell', slack: 'slack_off' }])
    expect(await actions()).toEqual([])
    expect(w.scheduled).toEqual([])
    expect((await db.prepare("SELECT body FROM notices WHERE audience_member_id = ? AND body LIKE '%x off%'").bind(OWNER).all()).results.length).toBe(1)
  })

  it('the same notice to the same channel again in one run, from another call: the first action, never a second', async () => {
    const { scope } = await setup()
    await markAlerts('C0TEST0001')
    const args = { to: { channels: ['ops-alerts'] }, title: 'T', text: 'once per run', format: 'message' }
    const first = wiring()
    await send(args, scope, first.deps)
    const [row] = await actions()
    expect(row!.state).toBe('approved')
    // A retry with a fresh admission (a new tool_use_id), as after a partial failure or a resumed turn.
    const second = wiring()
    const r = await send(args, { ...scope, requestId: `mcp-${uniq()}` }, second.deps)
    expect(text(r)).toBe(`#ops-alerts: already asked: approved (approval_id: ${row!.id})`)
    expect((await actions()).length).toBe(1)
    expect(second.scheduled).toEqual([])
    // Another run may post it again.
    await send(args, { ...scope, runId: `r_${uniq().padEnd(22, 'Y').slice(0, 22)}` }, wiring().deps)
    expect((await actions()).length).toBe(2)
  })

  it('a headline or text the hub would refuse by its own measure (UTF-16) is refused before any card', async () => {
    const { scope } = await setup()
    const r = await send({ to: { channels: ['ops-alerts'] }, title: '\u{1F600}'.repeat(61), text: 'x', format: 'message' }, scope, wiring().deps)
    expect(text(r)).toBe('#ops-alerts: refused: invalid_args (The details of that action aren’t valid, so nothing was asked or sent.)')
    expect(await actions()).toEqual([])
  })

  it('without the egress wiring a channel is refused and the bell still goes', async () => {
    const { scope } = await setup()
    const r = await send({ to: { members: [OWNER], channels: ['ops-alerts'] }, title: 'T', text: 'y', format: 'message' }, scope, undefined)
    expect(text(r).split('\n')).toEqual([`${OWNER}: sent`, '#ops-alerts: refused: actions_unavailable (Slack posts can’t be asked for from here, so nothing was asked or sent.)'])
    expect(await actions()).toEqual([])
  })

  it('a call admission refuses (a helper\'s call, a hand-made request) asks nothing; a bell-only call needs no admission', async () => {
    const { scope } = await setup()
    const w = wiring({ admit: () => null })
    const r = await send({ to: { channels: ['ops-alerts', 'general'] }, title: 'T', text: 'x', format: 'message' }, scope, w.deps)
    expect(text(r).split('\n')).toEqual([
      "#ops-alerts: refused: not_admitted (That call couldn't be matched to this turn, so nothing was asked or sent.)",
      "#general: refused: not_admitted (That call couldn't be matched to this turn, so nothing was asked or sent.)",
    ])
    expect(w.admitted.length, 'admitted once per call').toBe(1)
    expect(await actions()).toEqual([])
    const bell = wiring({ admit: () => null })
    await send({ to: { members: [OWNER] }, title: 'T', text: 'bell only', format: 'message' }, scope, bell.deps)
    expect(bell.admitted).toEqual([])
  })

  it('a replay answers each channel\'s own action as it is, and refuses a channel the first try never asked for', async () => {
    const { scope } = await setup()
    const toolUseId = `toolu_${uniq()}`
    const first = wiring({ admit: () => ({ toolUseId, jobId: null, replay: false }) })
    await send({ to: { channels: ['ops-alerts'] }, title: 'T', text: 'x', format: 'message' }, scope, first.deps)
    const [row] = await actions()
    const again = wiring({ admit: () => ({ toolUseId, jobId: null, replay: true }) })
    const r = await send({ to: { channels: ['ops-alerts', 'general'] }, title: 'T', text: 'x', format: 'message' }, scope, again.deps)
    expect(text(r).split('\n')).toEqual([
      `#ops-alerts: already asked: waiting (approval_id: ${row!.id})`,
      "#general: refused: not_admitted (That call couldn't be matched to this turn, so nothing was asked or sent.)",
    ])
    expect((await actions()).length).toBe(1)
  })

  it("a routine's post asks its creator even under the brand's grant; a system routine has no one to ask", async () => {
    const { scope } = await setup()
    await markAlerts('C0TEST0001')
    // A routine's run is in a chat the system owns (the routine's slot's), not a person's.
    const routineChat = `c_${uniq()}`
    await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, 'R', 1, 1)").bind(routineChat, SYSTEM_MEMBER_ID).run()
    const routine = { ...scope, memberId: SYSTEM_MEMBER_ID, chatId: routineChat }
    const team = wiring({ routineAsker: CREATOR })
    await send({ to: { channels: ['ops-alerts'] }, title: 'T', text: 'routine', format: 'message' }, routine, team.deps)
    const [row] = await actions()
    expect([row!.state, row!.verdict, row!.origin, row!.asked_by, row!.grant_id]).toEqual(['waiting', 'ask', 'routine', CREATOR, null])
    expect(team.scheduled).toEqual([])
    const system = wiring({ routineAsker: null })
    const r = await send({ to: { channels: ['ops-alerts'] }, title: 'T', text: 'system routine', format: 'message' }, routine, system.deps)
    // No one to approve it: the notice goes to the admins' bell instead (the run person rule: a system chat has no person).
    expect(text(r)).toBe('#ops-alerts: sent to the bell (not Slack): There’s no one here to approve a Slack post, so it went to the bell, not Slack.')
    expect((await actions()).length).toBe(1)
    expect(await adminsBell('system routine')).toBe(1)
  })

  it("a job's post is the job's; a removed person is no one to ask", async () => {
    const { scope } = await setup()
    const job = wiring({ admit: () => ({ toolUseId: `toolu_${uniq()}`, jobId: 'j_ns_1', replay: false }) })
    await send({ to: { channels: ['ops-alerts'] }, title: 'T', text: 'job', format: 'message' }, scope, job.deps)
    const [row] = await actions()
    expect([row!.origin, row!.job_id]).toEqual(['job', 'j_ns_1'])
    await person(db, OWNER, 'member', 'removed')
    const r = await send({ to: { channels: ['ops-alerts'] }, title: 'T', text: 'gone', format: 'message' }, scope, wiring().deps)
    expect(text(r)).toBe('#ops-alerts: sent to the bell (not Slack): There’s no one here to approve a Slack post, so it went to the bell, not Slack.')
    expect(await adminsBell('gone')).toBe(1)
  })

  // Review round 2: a notice must never vanish. Each refusal that isn't about the call itself sends it to the bell instead.
  it('Slack paused at the hub (account_unavailable): the chat owner\'s bell, and the agent is told', async () => {
    const { scope } = await setup()
    const w = wiring({ hub: [{ accountId: 'slack:workspace', paused: true, label: 'Slack' }] })
    const r = await send({ to: { channels: ['ops-alerts'] }, title: 'T', text: 'slack paused', format: 'message' }, scope, w.deps)
    expect(text(r)).toBe('#ops-alerts: sent to the bell (not Slack): Slack isn’t connected or is paused right now, so it went to the bell, not Slack.')
    expect(await actions()).toEqual([])
    expect((await db.prepare("SELECT COUNT(*) AS n FROM notices WHERE audience_member_id = ? AND body LIKE '%slack paused%'").bind(OWNER).first<number>('n'))).toBe(1)
  })

  it("an Inhouse member's chat (no one to ask): the admins' bell, never a card", async () => {
    const { scope } = await setup()
    const IH = 'm_ns_inhouse'
    await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'inhouse', NULL, 'active', 'I', 1) ON CONFLICT (id) DO NOTHING").bind(IH).run()
    const chatId = `c_${uniq()}`
    await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, 'T', 1, 1)").bind(chatId, IH).run()
    const r = await send({ to: { channels: ['ops-alerts'] }, title: 'T', text: 'inhouse chat', format: 'message' }, { ...scope, memberId: IH, chatId }, wiring().deps)
    expect(text(r)).toBe('#ops-alerts: sent to the bell (not Slack): There’s no one here to approve a Slack post, so it went to the bell, not Slack.')
    expect(await actions()).toEqual([])
    expect(await adminsBell('inhouse chat')).toBe(1)
  })
})
