// P5 W4 brief "Tests" 2 (the bell side), 5, 6, 7, 8 (server side), 9, 10 and 11, in the Workers runtime on the real
// migrations, with a fake DeliveryGateway (the hub's own side is app/hub/connectors/slack/delivery.test.ts). Ways it can
// fail, written down first:
//  1. a member id reaches Slack in any parameter, or an Inhouse member's bell gets a notice;
//  2. model text lands outside the bell's `body` (a template, fields, the link), or a URL, control character or Slack
//     syntax lands in the body, or the body is cut instead of refused;
//  3. the agent's post to a listed channel reaches the hub's delivery binding or anyone's bell instead of going to the
//     outbox as a proposal (Stage 1 M2-N, Q3 = A), or a proposal carries a member id, a link or uncleaned text;
//  4. concurrent sends pass a cap together, or one group's sends eat the other's allowance;
//  5. a repeat re-sends, a thrown hub call is retried, or two notices differing only in title are deduped;
//  6. an audit line, a log line or `notify_sends` holds the text;
//  7. a system notice takes its title from the caller, or misses its key's dedupe, per-run or day cap, or doesn't reach
//     the alerts channel (Q3 = A: the server's own fixed notices post there without a card).
// Expected values are literals or come from the generator, never from the code under test.
// The agent's Slack leg is a fake here (`fakeLeg`): the real one, through the outbox, is the notifications tool's
// (mcp/tools/notifications/send.test.ts) and the write-safety gate's (outbox/write-safety.property.test.ts). Until M2-N
// both Slack legs were closed and the Slack path's tests skipped; the server's notice tests run again as they were, and
// the agent's became proposal tests (the PR lists each).
import { env } from 'cloudflare:workers'
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import type { HubResult, PostNoticeRequest } from '../../hub/index/contract.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { notifyDeps } from '../mcp/tools/notifications/deps.ts'
import { NotificationSendInput, notificationSend } from '../mcp/tools/notifications/send.ts'
import { NOTICE_TEMPLATES } from '../notices/templates.ts'
import { renderNotice } from '../notices/render.ts'
import type { NoticeRow } from '../notices/read.ts'
import { notifyAgent, sendSystemNotice } from './send.ts'
import type { AgentNoticeInput, AgentNotifyCtx, DeliveryBinding, ListedChannel, SlackLeg, SlackLegAnswer } from './send.ts'
import { dataOf } from '../mcp/server/test-support.ts'

const db = env.DB
const DAY = 86_400_000
let dayN = 0
/** A fresh UTC day per test, so the day caps start at zero (storage is shared within this file). */
const freshDay = () => Date.UTC(2026, 0, 1) + ++dayN * DAY + 3_600_000
let u = 0
const uniq = () => `${++u}x${Math.random().toString(36).slice(2, 8)}`
const runId = () => `r_${uniq().padEnd(22, 'A').slice(0, 22)}`
const turnId = () => `t_${uniq().padEnd(22, 'B').slice(0, 22)}`

async function member(kind: 'person' | 'inhouse' = 'person', status = 'active'): Promise<string> {
  const id = `m_${uniq()}`
  await db.prepare('INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(id, kind, kind === 'person' ? 'member' : null, status, `Name ${id}`).run()
  return id
}
async function chat(owner: string): Promise<string> {
  const id = `c_${uniq()}`
  await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, 'T', 1, 1)").bind(id, owner).run()
  return id
}
async function setStage(stage: 'Watch' | 'Act' | 'Run') {
  await db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 'stage', ?, 1, 1, 'm_system', 'r') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json")
    .bind(JSON.stringify(stage)).run()
}
async function resetChannels(list: { id: string; name: string; alerts?: boolean }[]) {
  await db.prepare('DELETE FROM notify_channels').run()
  for (const c of list) {
    await db.prepare('INSERT INTO notify_channels (channel_id, name, alerts, added_by, added_at_ms) VALUES (?, ?, ?, ?, 1)').bind(c.id, c.name, c.alerts ? 1 : 0, 'm_system').run()
  }
}

type Call = { scope: unknown; req: PostNoticeRequest }
function fakeDelivery(answer: (req: PostNoticeRequest, n: number) => HubResult<{ ts: string }> | 'throw' = () => ({ ok: true, value: { ts: '1.000001' } })) {
  const calls: Call[] = []
  const delivery: DeliveryBinding = {
    async postNotice(scope, req) {
      calls.push({ scope, req })
      const a = answer(req, calls.length)
      if (a === 'throw') throw new Error('hub went away')
      return a
    },
    async listChannels() {
      throw new Error('not used')
    },
    async checkChannel() {
      throw new Error('not used')
    },
  }
  return { delivery, calls }
}

/** A stand-in for the outbox leg: records each proposal and answers a waiting card (or what `answer` says). */
function fakeLeg(answer: (channel: ListedChannel, n: number) => SlackLegAnswer = (_c, n) => ({ kind: 'action', actionId: `act_fake${n}`, state: 'waiting', verdict: 'ask', created: true })) {
  const proposals: { channel: ListedChannel; post: { title: string; text: string } }[] = []
  const leg: SlackLeg = {
    async propose(channel, post) {
      proposals.push({ channel, post })
      return answer(channel, proposals.length)
    },
  }
  return { leg, proposals }
}

const ctxOf = (slack: SlackLeg | null, nowMs: number): AgentNotifyCtx => ({ db, slack, nowMs, requestId: `req-${uniq()}` })
const notices = async (where: string, ...p: unknown[]) => (await db.prepare(`SELECT * FROM notices WHERE ${where}`).bind(...p).all<NoticeRow & { audience: string; audience_member_id: string | null; template: string }>()).results
const sends = async (where: string, ...p: unknown[]) => (await db.prepare(`SELECT * FROM notify_sends WHERE ${where}`).bind(...p).all<Record<string, unknown>>()).results
const lines = async (since: number) => (await db.prepare("SELECT * FROM audit_log WHERE id > ? AND action = 'notify.send' ORDER BY id").bind(since).all<{ args_json: string; actor_id: string; target_kind: string | null; target_id: string | null }>()).results
const lastLine = async () => (await db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log').first<number>('id'))!

/** `stage`: a stored value nothing reads any more (M2-F); a test that stores one shows it changes nothing. */
async function scene(stage?: 'Watch' | 'Act' | 'Run') {
  if (stage) await setStage(stage)
  await resetChannels([{ id: 'C0TEST0001', name: 'ops-alerts', alerts: true }, { id: 'C0TEST0002', name: 'General' }])
  const owner = await member()
  return { owner, chatId: await chat(owner), runId: runId(), turnId: turnId(), nowMs: freshDay() }
}
const scopeOf = (s: Awaited<ReturnType<typeof scene>>) => ({ memberId: s.owner, chatId: s.chatId, runId: s.runId, turnId: s.turnId })
const msg = (over: Partial<AgentNoticeInput> = {}): AgentNoticeInput => ({ to: { channels: ['#ops-alerts'] }, title: 'Stock low', text: `Fern mug ${uniq()}`, format: 'message', ...over })

/** Rows in any permission table (none exist before M2-A; once they do, these tests still need them empty). */
async function permissionRows(): Promise<number> {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'permission%'").all<{ name: string }>()).results
  let n = 0
  for (const t of tables) n += (await db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).first<number>('n'))!
  return n
}

// M2-F's safety test, as M2-N leaves it (Q3 = A). Ways it can fail, written first: a stored stage (any value, or a
// broken one) changes either path; the agent's post reaches the hub's delivery binding, a bell, or `notify_sends`
// instead of the outbox; the server's own notice doesn't reach the alerts channel, or reaches it more than once.
describe('the agent posts through the outbox, the server posts its own notices (M2-N; Q3 = A)', () => {
  it('only ./send.ts calls postNotice(, so no caller goes around it', () => {
    const sources = import.meta.glob<string>(
      ['../**/*.ts', '../../shared/**/*.ts', '../../src/**/*.{ts,tsx}', '../../runner/src/**/*.ts', '!../**/*.test.ts', '!../../shared/**/*.test.ts', '!../../src/**/*.test.{ts,tsx}', '!../../runner/**/*.test.ts'],
      { query: '?raw', import: 'default', eager: true },
    )
    expect(Object.keys(sources).length).toBeGreaterThan(200)
    expect(Object.entries(sources).filter(([, text]) => /postNotice\s*\(/.test(text)).map(([file]) => file)).toEqual(['./send.ts'])
  })

  for (const stored of [null, 'Watch', 'Act', 'Run', '{'] as const) {
    it(`no permission and a listed alerts channel, stage ${stored ?? 'unset'}: the agent's post never reaches the delivery binding; the server's notice posts once`, async () => {
      const s = await scene()
      if (stored === null) await db.prepare("DELETE FROM settings WHERE owner = 'brand' AND key = 'stage'").run()
      else if (stored === '{') await db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 'stage', '{', 1, 1, 'm_system', 'r') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json").run()
      else await setStage(stored)
      expect(await permissionRows()).toBe(0)
      const { delivery, calls } = fakeDelivery()
      // The agent's path as the MCP route runs it with no egress wiring: the post is refused, nothing is asked or sent.
      const agent = await notificationSend.call(NotificationSendInput.parse(msg()), { ...scopeOf(s), nowMs: s.nowMs, requestId: `m2-n-${uniq()}` }, { db, notify: notifyDeps(null) })
      expect(calls, 'the agent path never calls the delivery binding').toEqual([])
      expect(agent.content[0]!.text).toBe('#ops-alerts: refused: actions_unavailable (Slack posts can’t be asked for from here, so nothing was asked or sent.)')
      expect(dataOf(agent)).toEqual({ recipients: [{ to: '#ops-alerts', kind: 'slack', outcome: 'refused', detail: 'actions_unavailable' }], changed: [] })
      // The server's own notice to a member and the alerts channel: the channel's post goes out once, with no card.
      const system = await sendSystemNotice({ DB: db, HUB_DELIVERY: delivery }, {
        key: `m2-n:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { members: [s.owner], alertsChannel: true }, link: { kind: 'today' },
      }, { nowMs: s.nowMs })
      expect(system).toEqual({ ok: true, recipients: [{ kind: 'bell', to: s.owner, outcome: 'posted' }, { kind: 'slack', to: 'alerts', outcome: 'posted' }] })
      expect(calls.map(c => [c.req.channelId, c.req.title])).toEqual([['C0TEST0001', 'Approval waiting']])
      expect((await notices('audience_member_id = ?', s.owner)).map(n => n.template)).toEqual(['approval_waiting'])
      expect((await sends("kind = 'slack' AND at_ms = ?", s.nowMs)).map(r => r.source)).toEqual(['approvals'])
      expect(await permissionRows(), 'nothing on the permission path was written').toBe(0)
    })
  }

  it('one audit line per own recipient, the run member as actor, never the text; a listed channel is the outbox\'s to audit', async () => {
    const s = await scene()
    const since = await lastLine()
    const canary = 'CANARY-TEXT-7e2a'
    const { leg, proposals } = fakeLeg()
    await notifyAgent(ctxOf(leg, s.nowMs), scopeOf(s), { to: { channels: ['ops-alerts', 'nope'] }, title: `${canary} title`, text: `${canary} https://x.example.com`, format: 'message' })
    // The proposal holds the cleaned text (the outbox's action keeps it; the card shows it); never in our own tables.
    expect(proposals.map(p => [p.channel.channelId, p.post.title, p.post.text])).toEqual([['C0TEST0001', `${canary} title`, `${canary} [link removed]`]])
    const ls = await lines(since)
    expect(ls.map(l => [l.actor_id, l.target_kind, l.target_id])).toEqual([[s.owner, null, null]])
    const args = ls.map(l => JSON.parse(l.args_json) as Record<string, unknown>)
    expect(args.map(a => [a.source, a.runId, a.kind, a.outcome, a.detail, a.changed])).toEqual([['agent', s.runId, 'slack', 'refused', 'not_listed', ['links']]])
    const everything = JSON.stringify([(await db.prepare('SELECT * FROM audit_log').all()).results, (await db.prepare('SELECT * FROM notify_sends').all()).results])
    expect(everything).not.toContain(canary)
  })
})

describe('test 9: the bell, from notification_send', () => {
  it('one member notice per member, model text only in a bounded body, no Slack syntax', async () => {
    const s = await scene()
    const p2 = await member()
    const { leg, proposals: calls } = fakeLeg()
    const out = await notifyAgent(ctxOf(leg, s.nowMs), scopeOf(s), {
      to: { members: [s.owner, p2] },
      title: 'See https://canary-9f1.example.com <!here>',
      text: 'R&D a < b x > y \u202Eflip\u0007 www.canary-9f1.example.org <@U0TEST0001> mail@canary-9f1.example.net',
      format: 'message',
      link: { kind: 'approval', id: 'ap_1' },
    })
    expect(out.recipients.map(r => [r.to, r.outcome])).toEqual([[s.owner, 'posted'], [p2, 'posted']])
    expect(calls).toEqual([])
    const rows = await notices('audience_member_id IN (?, ?)', s.owner, p2)
    expect(rows.map(r => [r.audience, r.audience_member_id, r.template, r.fields_json, r.link_json]).sort()).toEqual([
      ['member', s.owner, 'notify_message', '{}', '{"to":"page","page":"approvals"}'],
      ['member', p2, 'notify_message', '{}', '{"to":"page","page":"approvals"}'],
    ].sort())
    // Hand-written: links removed, controls stripped, nothing escaped, title and text joined by a blank line.
    expect(rows[0]!.body).toBe('See [link removed] <!here>\n\nR&D a < b x > y flip [link removed] <@U0TEST0001> [link removed]')
    const dump = JSON.stringify(await notices('1 = 1'))
    expect(dump).not.toMatch(/canary-9f1|&lt;|&amp;/)
  })

  it('report keeps line breaks and uses notify_report; 1,622 code points are stored whole', async () => {
    const s = await scene()
    const title = 'T'.repeat(120)
    const text = `${'x'.repeat(749)}\n${'é'.repeat(750)}`
    await notifyAgent(ctxOf(null, s.nowMs), scopeOf(s), { to: { members: [s.owner] }, title, text, format: 'report' })
    const [row] = await notices('audience_member_id = ? AND template = ?', s.owner, 'notify_report')
    expect([...row!.body!].length).toBe(1622)
    expect(row!.body).toBe(`${title}\n\n${text}`)
  })

  it('a text over 1,500 code points is refused before any notice, never cut', async () => {
    const s = await scene()
    const out = await notifyAgent(ctxOf(null, s.nowMs), scopeOf(s), { to: { members: [s.owner] }, title: 'T', text: 'y'.repeat(1501), format: 'report' })
    expect(out.recipients).toEqual([{ kind: 'bell', to: s.owner, outcome: 'refused', detail: 'too_long' }])
    expect(await notices('audience_member_id = ?', s.owner)).toEqual([])
    // Measured after the escape: 300 `&` are 1,500 escaped code points, 301 are too many.
    const ok = await notifyAgent(ctxOf(null, s.nowMs), scopeOf(s), { to: { members: [s.owner] }, title: 'T', text: '&'.repeat(300), format: 'report' })
    const no = await notifyAgent(ctxOf(null, s.nowMs), scopeOf(s), { to: { members: [s.owner] }, title: 'T', text: '&'.repeat(301), format: 'report' })
    expect([ok.recipients[0]!.outcome, no.recipients[0]!.detail]).toEqual(['posted', 'too_long'])
  })

  it('test 2, the bell side: R&D, a < b and x > y are stored as written; the proposal gets them unescaped (the hub escapes once)', async () => {
    const s = await scene()
    const { leg, proposals } = fakeLeg()
    await notifyAgent(ctxOf(leg, s.nowMs), scopeOf(s), { to: { members: [s.owner], channels: ['ops-alerts'] }, title: 'Q&A', text: 'R&D a < b x > y', format: 'message' })
    const [row] = await notices('audience_member_id = ?', s.owner)
    expect(row!.body).toBe('Q&A\n\nR&D a < b x > y')
    expect(proposals.map(p => [p.post.title, p.post.text])).toEqual([['Q&A', 'R&D a < b x > y']])
  })

  // A backstop (shared/rpc-answer.ts): an answer that carries a disposer keeps its call open until released, and this
  // sender can run inside BrandAgent.
  it("the hub's answer to the server's own notice is released once", async () => {
    const s = await scene()
    const DISPOSE = (Symbol as unknown as { dispose: symbol }).dispose
    let released = 0
    const { delivery } = fakeDelivery(() => Object.assign({ ok: true as const, value: { ts: '1.000042' } }, { [DISPOSE]: () => { released++ } }))
    const out = await sendSystemNotice({ DB: db, HUB_DELIVERY: delivery }, { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect(out.ok && out.recipients.map(r => r.outcome)).toEqual(['posted'])
    expect(released).toBe(1)
  })
})

describe('test 8: no DM, no Inhouse bell', () => {
  it('the bell side: Inhouse, service, removed and unknown ids are unknown_member and get no notice; the person gets one', async () => {
    const s = await scene()
    const ih = await member('inhouse')
    const gone = await member('person', 'removed')
    const { leg, proposals } = fakeLeg()
    const out = await notifyAgent(ctxOf(leg, s.nowMs), scopeOf(s), msg({ to: { members: [s.owner, ih, gone, 'm_system', 'm_nobody'] } }))
    expect(out.recipients.map(r => `${r.to}:${r.outcome}:${r.detail ?? ''}`)).toEqual([
      `${s.owner}:posted:`, `${ih}:refused:unknown_member`, `${gone}:refused:unknown_member`, 'm_system:refused:unknown_member', 'm_nobody:refused:unknown_member',
    ])
    expect(await notices('audience_member_id IN (?, ?, ?, ?)', ih, gone, 'm_system', 'm_nobody')).toEqual([])
    expect((await notices('audience_member_id = ?', s.owner)).length).toBe(1)
    expect(proposals).toEqual([])
  })

  it('member ids never reach a Slack proposal; Inhouse, service, removed and unknown ids are unknown_member', async () => {
    const s = await scene()
    const ih = await member('inhouse')
    const gone = await member('person', 'removed')
    const { leg, proposals } = fakeLeg()
    const out = await notifyAgent(ctxOf(leg, s.nowMs), scopeOf(s), msg({ to: { members: [s.owner, ih, gone, 'm_system', 'm_nobody'], channels: ['ops-alerts', 'general'] } }))
    expect(out.recipients.map(r => `${r.to}:${r.outcome}:${r.detail ?? ''}`)).toEqual([
      `${s.owner}:posted:`, `${ih}:refused:unknown_member`, `${gone}:refused:unknown_member`, 'm_system:refused:unknown_member',
      'm_nobody:refused:unknown_member', 'ops-alerts:asked:', 'general:asked:',
    ])
    const sent = JSON.stringify(proposals)
    for (const id of [s.owner, ih, gone, 'm_system', 'm_nobody']) expect(sent).not.toContain(id)
    expect(proposals.map(p => p.channel.channelId)).toEqual(['C0TEST0001', 'C0TEST0002'])
    expect(await notices('audience_member_id IN (?, ?, ?)', ih, gone, 'm_system')).toEqual([])
  })
})

describe('test 5: channels', () => {
  it('an unlisted name is refused with the listed names; each listed one is proposed by its id, as the outbox answers it', async () => {
    const s = await scene()
    const since = await lastLine()
    const { leg, proposals } = fakeLeg(c => (c.channelId === 'C0TEST0002'
      ? { kind: 'refused', reason: 'not_admitted', text: "That call couldn't be matched to this turn, so nothing was asked or sent." }
      : { kind: 'action', actionId: 'act_fake1', state: 'approved', verdict: 'run', created: true }))
    const out = await notifyAgent(ctxOf(leg, s.nowMs), scopeOf(s), msg({ to: { channels: ['#random', '#GENERAL', 'ops-alerts'] } }))
    expect(out.listed).toEqual(['#General', '#ops-alerts'])
    expect(out.recipients).toEqual([
      { kind: 'slack', to: '#random', outcome: 'refused', detail: 'not_listed' },
      { kind: 'slack', to: '#GENERAL', outcome: 'refused', refusal: { reason: 'not_admitted', text: "That call couldn't be matched to this turn, so nothing was asked or sent." } },
      { kind: 'slack', to: 'ops-alerts', outcome: 'asked', action: { id: 'act_fake1', state: 'approved', verdict: 'run', created: true } },
    ])
    expect(proposals.map(p => p.channel.channelId)).toEqual(['C0TEST0002', 'C0TEST0001'])
    expect(await sends('run_id = ?', s.runId), 'no Slack row of ours for a proposal').toEqual([])
    expect((await lines(since)).map(l => JSON.parse(l.args_json) as { target: string; outcome: string; detail?: string }).map(a => `${a.target}:${a.outcome}:${a.detail ?? ''}`))
      .toEqual(['unlisted:refused:not_listed'])
  })

  // Ways the unlisted audit can fail, written first: no line for an unlisted name; a line that holds the name (untrusted
  // agent text) in any column; a line that names a channel id; more or fewer than one line per refused name; a listed
  // channel's own refusal loses its line; the over-bounds path skips it.
  const INJECT = '#evil-CANARY-9f2e"},{"target":"admins'
  const unlistedLines = async (since: number) => (await lines(since)).filter(l => (JSON.parse(l.args_json) as { target: string }).target === 'unlisted')

  it('an unlisted name is refused and audited once, with no channel id and never the name', async () => {
    const s = await scene()
    const since = await lastLine()
    const { leg, proposals } = fakeLeg()
    const out = await notifyAgent(ctxOf(leg, s.nowMs), scopeOf(s), msg({ to: { channels: [INJECT] } }))
    expect(out.recipients).toEqual([{ kind: 'slack', to: INJECT, outcome: 'refused', detail: 'not_listed' }])
    expect(proposals.length).toBe(0)
    const ls = await lines(since)
    expect(ls.map(l => [l.actor_id, l.target_kind, l.target_id])).toEqual([[s.owner, null, null]])
    const a = JSON.parse(ls[0]!.args_json) as Record<string, unknown>
    expect([a.source, a.runId, a.kind, a.target, a.outcome, a.detail]).toEqual(['agent', s.runId, 'slack', 'unlisted', 'refused', 'not_listed'])
    expect(await sends('run_id = ?', s.runId)).toEqual([])
    expect(JSON.stringify((await db.prepare('SELECT * FROM audit_log WHERE id > ?').bind(since).all()).results)).not.toContain('CANARY-9f2e')
  })

  it('one line per refused unlisted name per call, at Watch too', async () => {
    const s = await scene('Watch')
    const since = await lastLine()
    await notifyAgent(ctxOf(null, s.nowMs), scopeOf(s), msg({ to: { channels: ['#nope', 'NOPE', '#random'] } }))
    expect((await unlistedLines(since)).length).toBe(3)
  })

  it('the alerts channel the hub refuses (archived, private) keeps its own line for the server\'s notice', async () => {
    for (const reason of ['archived', 'not_public'] as const) {
      const s = await scene()
      const since = await lastLine()
      const { delivery } = fakeDelivery(() => ({ ok: false, error: { code: 'connect_refused', message: `connect refused by the provider: ${reason}` } }))
      await sendSystemNotice({ DB: db, HUB_DELIVERY: delivery }, { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
      const ls = await lines(since)
      expect(ls.map(l => [l.target_kind, l.target_id])).toEqual([['channel', 'C0TEST0001']])
      const a = JSON.parse(ls[0]!.args_json) as { target: string; outcome: string; detail?: string }
      expect([a.target, a.outcome, a.detail]).toEqual(['C0TEST0001', 'refused', reason])
    }
  })

  it('over the bounds: an unlisted name is audited too, a listed one keeps its line, never the name', async () => {
    const s = await scene()
    const since = await lastLine()
    const { leg, proposals } = fakeLeg()
    const out = await notifyAgent(ctxOf(leg, s.nowMs), scopeOf(s), { to: { channels: [INJECT, 'ops-alerts'] }, title: 'T', text: 'y'.repeat(1501), format: 'report' })
    expect(proposals, 'refused before any proposal').toEqual([])
    expect(out.recipients.map(r => `${r.outcome}:${r.detail}`)).toEqual(['refused:not_listed', 'refused:too_long'])
    const ls = await lines(since)
    expect(ls.map(l => [l.target_kind, l.target_id])).toEqual([[null, null], ['channel', 'C0TEST0001']])
    expect(ls.map(l => (JSON.parse(l.args_json) as { target: string; detail: string })).map(a => `${a.target}:${a.detail}`)).toEqual(['unlisted:not_listed', 'C0TEST0001:too_long'])
    expect(JSON.stringify(ls)).not.toContain('CANARY-9f2e')
  })

  describe('the hub\'s answers to the server\'s own notice', () => it.each([
    ['not_in_channel at the hub', { code: 'connect_refused', message: 'connect refused by the provider: not_member' }, 'refused', 'not_member'],
    ['archived', { code: 'connect_refused', message: 'connect refused by the provider: archived' }, 'refused', 'archived'],
    ['paused', { code: 'paused', message: 'connector paused' }, 'refused', 'slack_not_connected'],
    ['needs a reconnect', { code: 'scope_mismatch', message: 'granted scopes do not match the connector' }, 'refused', 'slack_not_connected'],
    ['rate limited', { code: 'rate_limited', message: 'rate limited by the upstream', retryAfterMs: 7000 }, 'failed', 'rate_limited'],
    ['anything else', { code: 'upstream_rejected', message: 'upstream rejected the request' }, 'failed', 'slack_unavailable'],
    ['APP_ORIGIN missing at the hub', { code: 'not_configured', message: 'connector not configured: APP_ORIGIN' }, 'refused', 'app_origin_missing'],
    ['Slack not configured', { code: 'not_configured', message: 'connector not configured' }, 'refused', 'slack_not_connected'],
  ] as const)('%s maps to %s %s', async (_, error, outcome, detail) => {
    const s = await scene()
    const { delivery } = fakeDelivery(() => ({ ok: false, error }))
    const out = await sendSystemNotice({ DB: db, HUB_DELIVERY: delivery }, { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect(out).toEqual({ ok: true, recipients: [{ kind: 'slack', to: 'alerts', outcome, detail }] })
  }))

  it('no delivery binding: the alerts copy is slack_unavailable, nothing reserved, the bell still goes', async () => {
    const s = await scene()
    const key = `k:${uniq()}`
    const out = await sendSystemNotice({ DB: db }, { key, source: 'approvals', kind: 'approval_waiting', to: { members: [s.owner], alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect(out.ok && out.recipients.map(r => `${r.outcome}:${r.detail ?? ''}`)).toEqual(['posted:', 'failed:slack_unavailable'])
    expect(await sends("system_key = ? AND kind = 'slack'", key)).toEqual([])
  })
})

describe('review round 1: APP_ORIGIN missing has its own detail', () => {
  it("the audit line and the outcome say app_origin_missing (the server's notice carries the app link)", async () => {
    const s = await scene()
    const since = await lastLine()
    const { delivery } = fakeDelivery(() => ({ ok: false, error: { code: 'not_configured', message: 'connector not configured: APP_ORIGIN' } }))
    const out = await sendSystemNotice({ DB: db, HUB_DELIVERY: delivery }, { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect(out).toEqual({ ok: true, recipients: [{ kind: 'slack', to: 'alerts', outcome: 'refused', detail: 'app_origin_missing' }] })
    expect((await lines(since)).map(l => (JSON.parse(l.args_json) as { detail?: string }).detail)).toEqual(['app_origin_missing'])
  })
})

describe('test 6, since M2-N: a listed channel is a proposal through the outbox, never a bell', () => {
  it('each listed channel is proposed once with the cleaned title and text; no bell notice, no row of ours', async () => {
    const s = await scene()
    const { leg, proposals } = fakeLeg()
    const out = await notifyAgent(ctxOf(leg, s.nowMs), scopeOf(s), msg({ to: { channels: ['ops-alerts', 'general'] }, text: 'Low https://x.example.com' }))
    expect(out.recipients.map(r => `${r.to}:${r.outcome}:${r.action?.state ?? ''}`)).toEqual(['ops-alerts:asked:waiting', 'general:asked:waiting'])
    expect(proposals.map(p => [p.channel.channelId, p.post.title, p.post.text])).toEqual([['C0TEST0001', 'Stock low', 'Low [link removed]'], ['C0TEST0002', 'Stock low', 'Low [link removed]']])
    expect(await notices('audience_member_id = ?', s.owner)).toEqual([])
    expect(await sends('run_id = ?', s.runId)).toEqual([])
  })

  // The orchestrator's decision (M2-N review round 1): while `slack.channel.post` is off (every deployable build today) a
  // listed channel's notice doesn't vanish. It reaches the run person's bell, as before M2-N, and says it didn't go to Slack.
  it('the operation off: the notice reaches the chat owner\'s bell (the admins\' for an Inhouse or removed owner) and says Slack is off', async () => {
    const off = (): SlackLegAnswer => ({ kind: 'refused', reason: 'over_ceiling', text: 'This kind of action is turned off for this brand, so nothing was asked or sent.' })
    const s = await scene()
    const since = await lastLine()
    const out = await notifyAgent(ctxOf(fakeLeg(off).leg, s.nowMs), scopeOf(s), msg({ to: { channels: ['ops-alerts', 'general'] } }))
    expect(out.recipients.map(r => `${r.to}:${r.kind}:${r.outcome}:${r.detail ?? ''}:${r.bell ?? ''}:${r.refusal?.reason ?? ''}:${r.repeat ?? ''}`)).toEqual([
      `ops-alerts:bell:posted:channel_to_bell:${s.owner}:slack_off:`, `general:bell:posted:channel_to_bell:${s.owner}:slack_off:true`,
    ])
    expect((await notices('audience_member_id = ?', s.owner)).length).toBe(1)
    expect((await lines(since)).map(l => (JSON.parse(l.args_json) as { detail?: string }).detail)).toEqual(['channel_to_bell', 'channel_to_bell'])
    for (const ownerKind of ['inhouse', 'removed'] as const) {
      const t = await scene()
      const owner = await member(ownerKind === 'inhouse' ? 'inhouse' : 'person', ownerKind === 'inhouse' ? 'active' : 'removed')
      const chatId = await chat(owner)
      const text = `admins ${uniq()}`
      await notifyAgent(ctxOf(fakeLeg(off).leg, t.nowMs), { ...scopeOf(t), memberId: owner, chatId }, msg({ text }))
      expect((await notices("audience = 'admins'")).filter(r => r.body?.includes(text)).map(r => r.audience_member_id), ownerKind).toEqual([null])
    }
  })

  it('Slack unavailable or no one to approve it: each also reaches the bell instead, with its own words; a call not admitted is refused', async () => {
    const cases: [string, string, string][] = [
      ['account_unavailable', 'slack_unavailable', 'Slack isn’t connected or is paused right now, so it went to the bell, not Slack.'],
      ['no_one_to_ask', 'no_one_to_ask', 'There’s no one here to approve a Slack post, so it went to the bell, not Slack.'],
    ]
    for (const [refused, reason, words] of cases) {
      const s = await scene()
      const out = await notifyAgent(ctxOf(fakeLeg(() => ({ kind: 'refused', reason: refused, text: 'outbox words' })).leg, s.nowMs), scopeOf(s), msg())
      expect(out.recipients, refused).toEqual([{ kind: 'bell', to: '#ops-alerts', bell: s.owner, outcome: 'posted', detail: 'channel_to_bell', refusal: { reason, text: words } }])
    }
    const s = await scene()
    const out = await notifyAgent(ctxOf(fakeLeg(() => ({ kind: 'refused', reason: 'not_admitted', text: 'no' })).leg, s.nowMs), scopeOf(s), msg())
    expect(out.recipients).toEqual([{ kind: 'slack', to: '#ops-alerts', outcome: 'refused', refusal: { reason: 'not_admitted', text: 'no' } }])
    expect(await notices('audience_member_id = ?', s.owner)).toEqual([])
  })

  it("with no leg (no egress behind the call) a listed channel is refused and reaches nobody's bell, in any chat", async () => {
    for (const ownerKind of ['person', 'inhouse', 'system'] as const) {
      const s = await scene()
      const owner = ownerKind === 'person' ? s.owner : ownerKind === 'inhouse' ? await member('inhouse') : SYSTEM_MEMBER_ID
      const text = `nobody ${uniq()}`
      const out = await notifyAgent(ctxOf(null, s.nowMs), { ...scopeOf(s), memberId: owner }, msg({ text }))
      expect(out.recipients.map(r => `${r.outcome}:${r.refusal?.reason ?? ''}`), ownerKind).toEqual(['refused:actions_unavailable'])
      expect((await notices('1 = 1')).filter(r => r.body?.includes(text)), ownerKind).toEqual([])
    }
  })
})

describe('repeats, failures and audit (tests 7 and 10)', () => {
  it('the bell side: an identical call returns the first outcome with one notice; a different title is a new notice', async () => {
    const s = await scene()
    const m = msg({ to: { members: [s.owner] } })
    const a = await notifyAgent(ctxOf(null, s.nowMs), scopeOf(s), m)
    const b = await notifyAgent(ctxOf(null, s.nowMs), scopeOf(s), m)
    const c = await notifyAgent(ctxOf(null, s.nowMs), scopeOf(s), { ...m, title: 'Stock low again' })
    expect([a, b, c].map(r => `${r.recipients[0]!.outcome}:${r.recipients[0]!.repeat ?? ''}`)).toEqual(['posted:', 'posted:true', 'posted:'])
    expect((await notices('audience_member_id = ?', s.owner)).map(n => n.body).sort()).toEqual([`Stock low\n\n${m.text}`, `Stock low again\n\n${m.text}`])
  })

  it("a thrown hub call on the server's notice answers unknown, keeps the row reserved, audits unknown and is never re-sent", async () => {
    const s = await scene()
    const since = await lastLine()
    const { delivery, calls } = fakeDelivery(() => 'throw')
    const key = `k:${uniq()}`
    const send = () => sendSystemNotice({ DB: db, HUB_DELIVERY: delivery }, { key, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    const a = await send()
    const b = await send()
    expect([a, b].map(r => (r.ok ? `${r.recipients[0]!.outcome}:${r.recipients[0]!.repeat ?? ''}` : 'x'))).toEqual(['unknown:', 'unknown:true'])
    expect(calls.length).toBe(1)
    expect((await sends('system_key = ?', key)).map(r => r.outcome)).toEqual(['reserved'])
    expect((await lines(since)).map(l => (JSON.parse(l.args_json) as { outcome: string }).outcome)).toEqual(['unknown', 'unknown'])
  })
})

describe('test 7: caps under concurrency (property, real local D1)', () => {
  type Op = { system: boolean; run: number | null }
  // Few runs and long lists, so runs overflow their cap and the day caps bind (fast-check's default size is small).
  const ops = fc.array(fc.record({ system: fc.boolean(), run: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }) }), { minLength: 8, maxLength: 120, size: 'max' })
  // Since M2-N the agent's posts are outbox proposals (their limit is the grant's day, N10), so they reserve no Slack row
  // here: the agent's ops run beside the system's and must leave its counts alone.
  test.prop([ops], { numRuns: 12 })('system ≤ 3 per known run and ≤ 50 a day; the agent\'s proposals reserve no Slack row and don\'t touch it', async list => {
    await resetChannels([{ id: 'C0TEST0001', name: 'ops-alerts', alerts: true }])
    const owner = await member()
    const chatId = await chat(owner)
    const nowMs = freshDay()
    const runs = Array.from({ length: 4 }, runId)
    const { delivery } = fakeDelivery()
    // Agent ops always have a run (the run token's); a null run on an agent op uses run 0.
    const all = list.map((op: Op, i) => op.system
      ? sendSystemNotice({ DB: db, HUB_DELIVERY: delivery }, { key: `k:${i}:${uniq()}`, source: 'approvals', kind: 'approval_waiting', ...(op.run === null ? {} : { runId: runs[op.run]! }), to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs })
      : notifyAgent(ctxOf(fakeLeg().leg, nowMs), { memberId: owner, chatId, runId: runs[op.run ?? 0]!, turnId: turnId() }, msg({ text: `op ${i}` })))
    await Promise.all(all)
    // The expected counts come from the generator.
    const perRun = (system: boolean) => {
      const m = new Map<number | null, number>()
      for (const op of list) if (op.system === system) m.set(system ? op.run : op.run ?? 0, (m.get(system ? op.run : op.run ?? 0) ?? 0) + 1)
      return m
    }
    const systemRuns = perRun(true)
    const expectedSystem = Math.min(50, [...systemRuns.entries()].reduce((a, [r, n]) => a + (r === null ? n : Math.min(3, n)), 0))
    const day = new Date(nowMs).toISOString().slice(0, 10)
    const rows = await sends("day = ? AND kind = 'slack' AND outcome = 'posted'", day)
    const agentRows = rows.filter(r => r.source === 'agent')
    const systemRows = rows.filter(r => r.source !== 'agent')
    expect(agentRows.length).toBe(0)
    expect(systemRows.length).toBe(expectedSystem)
    for (const r of runs) expect(systemRows.filter(x => x.run_id === r).length).toBeLessThanOrEqual(3)
  })
})

describe("test 7: each group's day cap counts only its own rows", () => {
  async function fill(source: 'agent' | 'approvals', n: number, nowMs: number, kind: 'slack' | 'bell' = 'slack') {
    const day = new Date(nowMs).toISOString().slice(0, 10)
    for (let i = 0; i < n; i++) {
      await db.prepare(`INSERT INTO notify_sends (id, source, run_id, system_key, actor_id, kind, target, day, notice_sha256, outcome, at_ms, notice_kind)
        VALUES (?, ?, ?, ?, 'm_system', ?, 'C0TEST0001', ?, ?, 'posted', ?, ?)`)
        .bind(`n_fill${uniq()}`, source, source === 'agent' ? runId() : null, source === 'agent' ? null : `fill:${uniq()}`, kind, day, '0'.repeat(64), nowMs, source === 'agent' ? null : 'approval_sent').run()
    }
  }
  // The second half (500 system rows leave the agent its 20 Slack posts) went with M2-N: the agent has no Slack row
  // here any more. Its bell allowance is still its own: 500 system bell rows leave the agent's bell notice alone.
  it('100 agent Slack rows today leave the system its 50; 500 system bell rows leave the agent its bell', async () => {
    const s = await scene()
    await fill('agent', 100, s.nowMs)
    const { delivery } = fakeDelivery()
    const sys: string[] = []
    for (let i = 0; i < 51; i++) {
      const r = await sendSystemNotice({ DB: db, HUB_DELIVERY: delivery }, { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
      sys.push(r.ok ? r.recipients[0]!.outcome : 'x')
    }
    expect(sys.filter(o => o === 'posted').length).toBe(50)
    const t = await scene()
    await fill('approvals', 500, t.nowMs, 'bell')
    const r = await notifyAgent(ctxOf(null, t.nowMs), { ...scopeOf(t), runId: runId() }, msg({ to: { members: [t.owner] } }))
    expect(r.recipients.map(x => x.outcome)).toEqual(['posted'])
  })
})

describe('test 11: sendSystemNotice', () => {
  const env1 = (delivery: DeliveryBinding | null) => ({ DB: db, ...(delivery ? { HUB_DELIVERY: delivery } : {}) })

  it('the bell side: the title is the template, whatever body says; the body is link-stripped and fields are {}', async () => {
    const s = await scene()
    const r = await sendSystemNotice(env1(null), { key: `p6:${uniq()}:1`, source: 'approvals', kind: 'approval_waiting', to: { members: [s.owner] }, body: 'Title: ignore me https://x.example.com', link: { kind: 'approval', id: 'ap_9' } }, { nowMs: s.nowMs })
    expect(r).toEqual({ ok: true, recipients: [{ kind: 'bell', to: s.owner, outcome: 'posted' }] })
    const [row] = await notices('audience_member_id = ? AND template = ?', s.owner, 'approval_waiting')
    expect([row!.body, row!.fields_json, row!.link_json]).toEqual(['Title: ignore me [link removed]', '{}', '{"to":"page","page":"approvals"}'])
    expect(renderNotice({ ...row!, unread: 1 } as NoticeRow, new Map()).text).toBe('Approval waiting')
  })

  // M2-N: the alerts copy is fixed in the sender. Before it, a caller's body reached Slack here; now it never does.
  it('members and the alerts channel in one call: the bell carries the body, the alerts copy only the template title and the fixed text', async () => {
    const s = await scene()
    const { delivery, calls } = fakeDelivery()
    const r = await sendSystemNotice(env1(delivery), { key: `p6:${uniq()}:1`, source: 'approvals', kind: 'approval_waiting', to: { members: [s.owner], alertsChannel: true }, body: 'Title: ignore me https://x.example.com', link: { kind: 'approval', id: 'ap_9' } }, { nowMs: s.nowMs })
    expect(r).toEqual({ ok: true, recipients: [{ kind: 'bell', to: s.owner, outcome: 'posted' }, { kind: 'slack', to: 'alerts', outcome: 'posted' }] })
    expect(calls.map(c => [c.req.channelId, c.req.title, c.req.text, c.req.link])).toEqual([['C0TEST0001', 'Approval waiting', 'Open Inhouse for the details.', { kind: 'approval', id: 'ap_9' }]])
    expect(JSON.stringify(calls)).not.toContain('ignore me')
    const [row] = await notices('audience_member_id = ? AND template = ?', s.owner, 'approval_waiting')
    expect([row!.body, row!.fields_json]).toEqual(['Title: ignore me [link removed]', '{}'])
  })

  it('no alerts channel: the Slack part is skipped, the bell still goes; with one, it posts there (Q3 = A, no card)', async () => {
    const s = await scene()
    await resetChannels([{ id: 'C0TEST0002', name: 'general' }])
    const r = await sendSystemNotice(env1(fakeDelivery().delivery), { key: `p6:${uniq()}:1`, source: 'approvals', kind: 'approval_waiting', to: { members: [s.owner], alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect(r).toEqual({ ok: true, recipients: [{ kind: 'bell', to: s.owner, outcome: 'posted' }, { kind: 'slack', to: 'alerts', outcome: 'skipped', detail: 'no_alerts_channel' }] })
    await resetChannels([{ id: 'C0TEST0001', name: 'ops-alerts', alerts: true }])
    const { delivery, calls } = fakeDelivery()
    const w = await sendSystemNotice(env1(delivery), { key: `p6:${uniq()}:1`, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect([w, calls.map(c => c.req.channelId)]).toEqual([{ ok: true, recipients: [{ kind: 'slack', to: 'alerts', outcome: 'posted' }] }, ['C0TEST0001']])
  })

  it('the bell side: a repeat within one key returns the first outcome with one notice; the next window key is a new one', async () => {
    const s = await scene()
    const notice = uniq()
    const send = (window: number) => sendSystemNotice(env1(null), { key: `p6:${notice}:${window}`, source: 'approvals', kind: 'approval_waiting', to: { members: [s.owner] }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    const a = await send(1)
    const b = await send(1)
    const c = await send(2)
    expect([a, b, c].map(r => (r.ok ? `${r.recipients[0]!.outcome}:${r.recipients[0]!.repeat ?? ''}` : 'x'))).toEqual(['posted:', 'posted:true', 'posted:'])
    expect((await notices('audience_member_id = ? AND template = ?', s.owner, 'approval_waiting')).length).toBe(2)
  })

  it('a repeat within one key returns the first outcome; the next window key posts again after a refusal', async () => {
    const s = await scene()
    const notice = uniq()
    let refuse = true
    const { delivery, calls } = fakeDelivery(() => (refuse ? { ok: false, error: { code: 'rate_limited', message: 'rate limited by the upstream' } } : { ok: true, value: { ts: '2.2' } }))
    const send = (window: number) => sendSystemNotice(env1(delivery), { key: `p6:${notice}:${window}`, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    const a = await send(1)
    refuse = false
    const b = await send(1)
    const c = await send(2)
    expect([a, b, c].map(r => (r.ok ? `${r.recipients[0]!.outcome}:${r.recipients[0]!.repeat ?? ''}` : 'x'))).toEqual(['failed:', 'failed:true', 'posted:'])
    expect(calls.length).toBe(2)
  })

  it('a body of 400 characters with a URL and a mention is refused (never cut); 300 after the escape is the limit', async () => {
    const s = await scene()
    const since = await lastLine()
    const { delivery, calls } = fakeDelivery()
    const body = `<!channel> https://x.example.com ${'z'.repeat(367)}`
    expect([...body].length).toBe(400)
    const r = await sendSystemNotice(env1(delivery), { key: `p6:${uniq()}:1`, source: 'approvals', kind: 'approval_waiting', to: { members: [s.owner], alertsChannel: true }, body, link: { kind: 'today' } }, { nowMs: s.nowMs })
    // The bell refuses the body; the alerts copy never carries it, so it still posts its fixed text (M2-N).
    expect(r).toEqual({ ok: true, recipients: [{ kind: 'bell', to: s.owner, outcome: 'refused', detail: 'too_long' }, { kind: 'slack', to: 'alerts', outcome: 'posted' }] })
    expect(calls.map(c => c.req.text)).toEqual(['Open Inhouse for the details.'])
    expect(await notices('audience_member_id = ? AND template = ?', s.owner, 'approval_waiting')).toEqual([])
    expect((await lines(since)).length).toBe(2)
  })

  it('M2-N: an alerts copy of any kind but approval_waiting or routine_failed is invalid_args, with no row and no hub call', async () => {
    const s = await scene()
    const { delivery, calls } = fakeDelivery()
    const before = (await sends('1 = 1')).length
    for (const kind of ['approval_sent', 'approval_lapsed', 'approval_failed', 'needs_check', 'approval_expired', 'restore_reconciled', 'question_waiting', 'question_closed', 'question_asked']) {
      expect(await sendSystemNotice(env1(delivery), { key: `k:${uniq()}`, source: 'approvals', kind: kind as never, to: { members: [s.owner], alertsChannel: true }, body: 'card words', link: { kind: 'today' } }, { nowMs: s.nowMs }), kind)
        .toEqual({ ok: false, error: 'invalid_args' })
    }
    expect(calls).toEqual([])
    expect((await sends('1 = 1')).length).toBe(before)
    // routine_failed is the other one allowed.
    const ok = await sendSystemNotice(env1(delivery), { key: `k:${uniq()}`, source: 'routines', kind: 'routine_failed', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect(ok).toEqual({ ok: true, recipients: [{ kind: 'slack', to: 'alerts', outcome: 'posted' }] })
    expect(calls.map(c => c.req.title)).toEqual(['A routine failed'])
  })

  it('M2-N: one alerts copy per key even when the mark moved to another channel before the retry', async () => {
    const s = await scene()
    const { delivery, calls } = fakeDelivery()
    const key = `k:${uniq()}`
    const send = () => sendSystemNotice(env1(delivery), { key, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    const a = await send()
    await resetChannels([{ id: 'C0TEST0001', name: 'ops-alerts' }, { id: 'C0TEST0002', name: 'General', alerts: true }])
    const b = await send()
    expect([a, b]).toEqual([{ ok: true, recipients: [{ kind: 'slack', to: 'alerts', outcome: 'posted' }] }, { ok: true, recipients: [{ kind: 'slack', to: 'alerts', outcome: 'posted', repeat: true }] }])
    expect(calls.map(c => c.req.channelId)).toEqual(['C0TEST0001'])
  })

  it('every kind renders its own title (a literal list), question_asked as "A question is waiting"', async () => {
    const s = await scene()
    const TITLES: [string, string][] = [
      ['approval_waiting', 'Approval waiting'], ['approval_lapsed', 'Approval sent back'], ['approval_sent', 'Approved action sent'],
      ['approval_failed', "An approved action didn't go out"], ['needs_check', 'A send needs a check'], ['approval_expired', 'An approval expired'],
      ['restore_reconciled', 'Sends checked after a restore'], ['question_waiting', 'A question is waiting'], ['question_closed', 'A question was closed'],
      ['question_asked', 'A question is waiting'],
    ]
    for (const [kind, title] of TITLES) {
      const p = await member()
      const r = await sendSystemNotice(env1(null), { key: `k:${uniq()}`, source: 'approvals', kind: kind as never, to: { members: [p] }, link: { kind: 'today' } }, { nowMs: s.nowMs })
      expect(r.ok, kind).toBe(true)
      const [row] = await notices('audience_member_id = ?', p)
      expect(renderNotice({ ...row!, unread: 1 } as NoticeRow, new Map()).text, kind).toBe(title)
    }
  })

  it('an unknown kind, a bad key or no recipient is invalid_args with no row', async () => {
    const s = await scene()
    const before = (await sends('1 = 1')).length
    for (const bad of [
      { key: 'k:1', source: 'approvals', kind: 'approval_spam', to: { members: [s.owner] }, link: { kind: 'today' } },
      { key: 'has space', source: 'approvals', kind: 'approval_sent', to: { members: [s.owner] }, link: { kind: 'today' } },
      { key: 'k:2', source: 'approvals', kind: 'approval_sent', to: {}, link: { kind: 'today' } },
      { key: 'k:3', source: 'agent', kind: 'approval_sent', to: { members: [s.owner] }, link: { kind: 'today' } },
      { key: 'k:4', source: 'approvals', kind: 'approval_sent', to: { members: [s.owner] }, link: { kind: 'chat', id: '../x' } },
    ]) expect(await sendSystemNotice(env1(null), bad as never, { nowMs: s.nowMs })).toEqual({ ok: false, error: 'invalid_args' })
    expect((await sends('1 = 1')).length).toBe(before)
  })

  it('the 4th system Slack post for one run is refused, five with no run all go', async () => {
    const s = await scene()
    const { delivery } = fakeDelivery()
    const go = (runId?: string) => sendSystemNotice(env1(delivery), { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_waiting', ...(runId ? { runId } : {}), to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    const withRun: string[] = []
    for (let i = 0; i < 4; i++) {
      const r = await go(s.runId)
      withRun.push(r.ok ? `${r.recipients[0]!.outcome}:${r.recipients[0]!.detail ?? ''}` : 'x')
    }
    const without: string[] = []
    for (let i = 0; i < 5; i++) {
      const r = await go()
      without.push(r.ok ? r.recipients[0]!.outcome : 'x')
    }
    expect(withRun).toEqual(['posted:', 'posted:', 'posted:', 'refused:run_cap'])
    expect(without).toEqual(['posted', 'posted', 'posted', 'posted', 'posted'])
  })

  it('past the 50th system Slack post in a day the Slack copy is dropped and the bell copy still goes', async () => {
    const s = await scene()
    const { delivery, calls } = fakeDelivery()
    for (let i = 0; i < 50; i++) await sendSystemNotice(env1(delivery), { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    const r = await sendSystemNotice(env1(delivery), { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { members: [s.owner], alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect(r).toEqual({ ok: true, recipients: [{ kind: 'bell', to: s.owner, outcome: 'posted' }, { kind: 'slack', to: 'alerts', outcome: 'refused', detail: 'day_cap' }] })
    expect(calls.length).toBe(50)
    // The agent's post is untouched by the system's 50: it's still proposed through the outbox.
    const a = await notifyAgent(ctxOf(fakeLeg().leg, s.nowMs), scopeOf(s), msg())
    expect(a.recipients[0]!.outcome).toBe('asked')
  })
})

describe("the eleven template rows in P4's table (revision 3.3)", () => {
  it('match a hand-copied list: template, title, maximum', () => {
    const ROWS: [string, string, number][] = [
      ['notify_message', 'Message from your Inhouse agent', 1622], ['notify_report', 'Report from your Inhouse agent', 1622],
      ['approval_waiting', 'Approval waiting', 300], ['approval_lapsed', 'Approval sent back', 300], ['approval_sent', 'Approved action sent', 300],
      ['approval_failed', "An approved action didn't go out", 300], ['needs_check', 'A send needs a check', 300], ['approval_expired', 'An approval expired', 300],
      ['restore_reconciled', 'Sends checked after a restore', 300], ['question_waiting', 'A question is waiting', 300], ['question_closed', 'A question was closed', 300],
    ]
    for (const [template, title, max] of ROWS) expect([NOTICE_TEMPLATES[template]?.text, NOTICE_TEMPLATES[template]?.body?.max], template).toEqual([title, max])
    // Every other row with a body is Stage 1 M1-B's stopped-job notice (bell only; its line is the server's own).
    expect(Object.entries(NOTICE_TEMPLATES).filter(([, t]) => t.body).map(([k]) => k).sort()).toEqual([...ROWS.map(([k]) => k), 'job_stopped'].sort())
  })
})
