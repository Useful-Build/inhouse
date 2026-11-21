// P5 W4 brief "Tests" 2 (the bell side), 5, 6, 7, 8 (server side), 9, 10 and 11, in the Workers runtime on the real
// migrations, with a fake DeliveryGateway (the hub's own side is app/hub/connectors/slack/delivery.test.ts). Ways it can
// fail, written down first:
//  1. a member id reaches Slack in any parameter, or an Inhouse member's bell gets a notice;
//  2. model text lands outside the bell's `body` (a template, fields, the link), or a URL, control character or Slack
//     syntax lands in the body, or the body is cut instead of refused;
//  3. a channel recipient posts below Act, or reaches the wrong person's bell;
//  4. concurrent sends pass a cap together, or one group's sends eat the other's allowance;
//  5. a repeat re-sends, a thrown hub call is retried, or two notices differing only in title are deduped;
//  6. an audit line, a log line or `notify_sends` holds the text;
//  7. a system notice takes its title from the caller, or misses its key's dedupe, per-run or day cap.
// Expected values are literals or come from the generator, never from the code under test.
import { env } from 'cloudflare:workers'
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import type { HubResult, PostNoticeRequest } from '../../hub/index/contract.ts'
import { NOTICE_TEMPLATES } from '../notices/templates.ts'
import { renderNotice } from '../notices/render.ts'
import type { NoticeRow } from '../notices/read.ts'
import { notifyAgent, sendSystemNotice } from './send.ts'
import type { AgentNoticeInput, DeliveryBinding, NotifyCtx } from './send.ts'

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

const ctxOf = (delivery: DeliveryBinding | null, nowMs: number): NotifyCtx => ({ db, delivery, nowMs, requestId: `req-${uniq()}` })
const notices = async (where: string, ...p: unknown[]) => (await db.prepare(`SELECT * FROM notices WHERE ${where}`).bind(...p).all<NoticeRow & { audience: string; audience_member_id: string | null; template: string }>()).results
const sends = async (where: string, ...p: unknown[]) => (await db.prepare(`SELECT * FROM notify_sends WHERE ${where}`).bind(...p).all<Record<string, unknown>>()).results
const lines = async (since: number) => (await db.prepare("SELECT * FROM audit_log WHERE id > ? AND action = 'notify.send' ORDER BY id").bind(since).all<{ args_json: string; actor_id: string; target_kind: string | null; target_id: string | null }>()).results
const lastLine = async () => (await db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log').first<number>('id'))!

async function scene(stage: 'Watch' | 'Act' = 'Act') {
  await setStage(stage)
  await resetChannels([{ id: 'C0TEST0001', name: 'ops-alerts', alerts: true }, { id: 'C0TEST0002', name: 'General' }])
  const owner = await member()
  return { owner, chatId: await chat(owner), runId: runId(), turnId: turnId(), nowMs: freshDay() }
}
const scopeOf = (s: Awaited<ReturnType<typeof scene>>) => ({ memberId: s.owner, chatId: s.chatId, runId: s.runId, turnId: s.turnId })
const msg = (over: Partial<AgentNoticeInput> = {}): AgentNoticeInput => ({ to: { channels: ['#ops-alerts'] }, title: 'Stock low', text: `Fern mug ${uniq()}`, format: 'message', ...over })

describe('test 9: the bell, from notification_send', () => {
  it('one member notice per member, model text only in a bounded body, no Slack syntax', async () => {
    const s = await scene()
    const p2 = await member()
    const { delivery, calls } = fakeDelivery()
    const out = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), {
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

  it('test 2, the bell side: R&D, a < b and x > y are stored as written; the hub gets them unescaped', async () => {
    const s = await scene()
    const { delivery, calls } = fakeDelivery()
    await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), { to: { members: [s.owner], channels: ['ops-alerts'] }, title: 'Q&A', text: 'R&D a < b x > y', format: 'message' })
    const [row] = await notices('audience_member_id = ?', s.owner)
    expect(row!.body).toBe('Q&A\n\nR&D a < b x > y')
    expect(calls.map(c => [c.req.title, c.req.text])).toEqual([['Q&A', 'R&D a < b x > y']])
  })
})

describe('test 8: no DM, no Inhouse bell', () => {
  it('member ids never reach the hub in any parameter; Inhouse, service, removed and unknown ids are unknown_member', async () => {
    const s = await scene()
    const ih = await member('inhouse')
    const gone = await member('person', 'removed')
    const { delivery, calls } = fakeDelivery()
    const out = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), msg({ to: { members: [s.owner, ih, gone, 'm_system', 'm_nobody'], channels: ['ops-alerts', 'general'] } }))
    expect(out.recipients.map(r => `${r.to}:${r.outcome}:${r.detail ?? ''}`)).toEqual([
      `${s.owner}:posted:`, `${ih}:refused:unknown_member`, `${gone}:refused:unknown_member`, 'm_system:refused:unknown_member',
      'm_nobody:refused:unknown_member', 'ops-alerts:posted:', 'general:posted:',
    ])
    const sent = JSON.stringify(calls)
    for (const id of [s.owner, ih, gone, 'm_system', 'm_nobody']) expect(sent).not.toContain(id)
    expect(calls.map(c => c.req.channelId)).toEqual(['C0TEST0001', 'C0TEST0002'])
    expect(calls.every(c => (c.scope as { kind: string }).kind === 'server')).toBe(true)
    expect(await notices('audience_member_id IN (?, ?, ?)', ih, gone, 'm_system')).toEqual([])
  })
})

describe('test 5: channels', () => {
  it('an unlisted name is refused with the listed names; a channel the hub refuses is refused and audited, never posted', async () => {
    const s = await scene()
    const since = await lastLine()
    const { delivery, calls } = fakeDelivery(req => (req.channelId === 'C0TEST0002' ? { ok: false, error: { code: 'connect_refused', message: 'connect refused by the provider: shared_channel' } } : { ok: true, value: { ts: '1.1' } }))
    const out = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), msg({ to: { channels: ['#random', '#GENERAL', 'ops-alerts'] } }))
    expect(out.listed).toEqual(['#General', '#ops-alerts'])
    expect(out.recipients.map(r => `${r.to}:${r.outcome}:${r.detail ?? ''}`)).toEqual(['#random:refused:not_listed', '#GENERAL:refused:shared_channel', 'ops-alerts:posted:'])
    expect(calls.length).toBe(2)
    const shared = await sends("run_id = ? AND target = 'C0TEST0002'", s.runId)
    expect(shared.map(r => [r.outcome, r.detail])).toEqual([['refused', 'shared_channel']])
    expect((await lines(since)).map(l => JSON.parse(l.args_json) as { target: string; outcome: string; detail?: string }).map(a => `${a.target}:${a.outcome}:${a.detail ?? ''}`))
      .toEqual(['C0TEST0002:refused:shared_channel', 'C0TEST0001:posted:'])
  })

  it.each([
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
    const out = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), msg())
    expect(out.recipients).toEqual([{ kind: 'slack', to: '#ops-alerts', outcome, detail }])
  })

  it('no delivery binding: slack_unavailable, nothing reserved, the bell still goes', async () => {
    const s = await scene()
    const out = await notifyAgent(ctxOf(null, s.nowMs), scopeOf(s), msg({ to: { members: [s.owner], channels: ['ops-alerts'] } }))
    expect(out.recipients.map(r => `${r.outcome}:${r.detail ?? ''}`)).toEqual(['posted:', 'failed:slack_unavailable'])
    expect(await sends("run_id = ? AND kind = 'slack'", s.runId)).toEqual([])
  })
})

describe('review round 1: APP_ORIGIN missing has its own detail', () => {
  it('the audit line and the outcome say app_origin_missing', async () => {
    const s = await scene()
    const since = await lastLine()
    const { delivery } = fakeDelivery(() => ({ ok: false, error: { code: 'not_configured', message: 'connector not configured: APP_ORIGIN' } }))
    const out = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), msg({ link: { kind: 'today' } }))
    expect(out.recipients).toEqual([{ kind: 'slack', to: '#ops-alerts', outcome: 'refused', detail: 'app_origin_missing' }])
    expect((await lines(since)).map(l => (JSON.parse(l.args_json) as { detail?: string }).detail)).toEqual(['app_origin_missing'])
  })
})

describe('test 6: the stage', () => {
  it("at Watch a channel recipient becomes the chat owner's bell notice and nothing is posted", async () => {
    const s = await scene('Watch')
    const { delivery, calls } = fakeDelivery()
    const out = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), msg({ to: { channels: ['ops-alerts', 'general'] } }))
    expect(calls).toEqual([])
    expect(out.recipients.map(r => `${r.to}:${r.outcome}:${r.detail ?? ''}:${r.bell}:${r.repeat ?? ''}`)).toEqual([
      `ops-alerts:posted:to_bell:${s.owner}:`, `general:posted:to_bell:${s.owner}:true`,
    ])
    expect((await notices('audience_member_id = ?', s.owner)).length).toBe(1)
  })

  it("an Inhouse member's chat, a removed owner and an unknown chat go to the admins' bell, no member id", async () => {
    for (const ownerKind of ['inhouse', 'removed', 'none'] as const) {
      const s = await scene('Watch')
      const owner = ownerKind === 'inhouse' ? await member('inhouse') : ownerKind === 'removed' ? await member('person', 'removed') : null
      const chatId = owner ? await chat(owner) : 'c_missing'
      const text = `admins ${uniq()}`
      await notifyAgent(ctxOf(null, s.nowMs), { ...scopeOf(s), memberId: owner ?? s.owner, chatId }, msg({ text }))
      const rows = (await notices("audience = 'admins'")).filter(r => r.body?.includes(text))
      expect(rows.map(r => [r.audience, r.audience_member_id]), ownerKind).toEqual([['admins', null]])
    }
  })
})

describe('repeats, failures and audit (tests 7 and 10)', () => {
  it('an identical call returns the first outcome with one post; a different title posts again', async () => {
    const s = await scene()
    const { delivery, calls } = fakeDelivery()
    const m = msg()
    const a = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), m)
    const b = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), m)
    const c = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), { ...m, title: 'Stock low again' })
    expect([a, b, c].map(r => `${r.recipients[0]!.outcome}:${r.recipients[0]!.repeat ?? ''}`)).toEqual(['posted:', 'posted:true', 'posted:'])
    expect(calls.length).toBe(2)
  })

  it('a thrown hub call answers unknown, keeps the row reserved, audits unknown and is never re-sent', async () => {
    const s = await scene()
    const since = await lastLine()
    const { delivery, calls } = fakeDelivery(() => 'throw')
    const m = msg()
    const a = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), m)
    const b = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), m)
    expect([a.recipients[0]!.outcome, b.recipients[0]!.outcome, b.recipients[0]!.repeat]).toEqual(['unknown', 'unknown', true])
    expect(calls.length).toBe(1)
    expect((await sends('run_id = ?', s.runId)).map(r => r.outcome)).toEqual(['reserved'])
    expect((await lines(since)).map(l => (JSON.parse(l.args_json) as { outcome: string }).outcome)).toEqual(['unknown', 'unknown'])
  })

  it('one audit line per recipient, the run member as actor, never the text', async () => {
    const s = await scene()
    const since = await lastLine()
    const canary = 'CANARY-TEXT-4c1d'
    const { delivery } = fakeDelivery()
    await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), { to: { members: [s.owner], channels: ['ops-alerts', 'nope'] }, title: `${canary} title`, text: `${canary} https://x.example.com`, format: 'message' })
    const ls = await lines(since)
    expect(ls.map(l => [l.actor_id, l.target_kind, l.target_id])).toEqual([[s.owner, 'member', s.owner], [s.owner, 'channel', 'C0TEST0001']])
    const args = ls.map(l => JSON.parse(l.args_json) as Record<string, unknown>)
    expect(args.map(a => [a.source, a.runId, a.kind, a.outcome, a.changed])).toEqual([['agent', s.runId, 'bell', 'posted', ['links']], ['agent', s.runId, 'slack', 'posted', ['links']]])
    const everything = JSON.stringify([(await db.prepare('SELECT * FROM audit_log').all()).results, (await db.prepare('SELECT * FROM notify_sends').all()).results])
    expect(everything).not.toContain(canary)
  })
})

describe('test 7: caps under concurrency (property, real local D1)', () => {
  type Op = { system: boolean; run: number | null }
  // Few runs and long lists, so runs overflow their cap and the day caps bind (fast-check's default size is small).
  const ops = fc.array(fc.record({ system: fc.boolean(), run: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }) }), { minLength: 8, maxLength: 120, size: 'max' })
  test.prop([ops], { numRuns: 12 })('agent ≤ 3 per run and ≤ 20 a day; system ≤ 3 per known run and ≤ 50 a day; neither touches the other', async list => {
    await setStage('Act')
    await resetChannels([{ id: 'C0TEST0001', name: 'ops-alerts', alerts: true }])
    const owner = await member()
    const chatId = await chat(owner)
    const nowMs = freshDay()
    const runs = Array.from({ length: 4 }, runId)
    const { delivery } = fakeDelivery()
    // Agent ops always have a run (the run token's); a null run on an agent op uses run 0.
    const all = list.map((op: Op, i) => op.system
      ? sendSystemNotice({ DB: db, HUB_DELIVERY: delivery }, { key: `k:${i}:${uniq()}`, source: 'approvals', kind: 'approval_waiting', ...(op.run === null ? {} : { runId: runs[op.run]! }), to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs })
      : notifyAgent(ctxOf(delivery, nowMs), { memberId: owner, chatId, runId: runs[op.run ?? 0]!, turnId: turnId() }, msg({ text: `op ${i}` })))
    await Promise.all(all)
    // The expected counts come from the generator.
    const perRun = (system: boolean) => {
      const m = new Map<number | null, number>()
      for (const op of list) if (op.system === system) m.set(system ? op.run : op.run ?? 0, (m.get(system ? op.run : op.run ?? 0) ?? 0) + 1)
      return m
    }
    const agentRuns = perRun(false)
    const expectedAgent = Math.min(20, [...agentRuns.values()].reduce((a, n) => a + Math.min(3, n), 0))
    const systemRuns = perRun(true)
    const expectedSystem = Math.min(50, [...systemRuns.entries()].reduce((a, [r, n]) => a + (r === null ? n : Math.min(3, n)), 0))
    const day = new Date(nowMs).toISOString().slice(0, 10)
    const rows = await sends("day = ? AND kind = 'slack' AND outcome = 'posted'", day)
    const agentRows = rows.filter(r => r.source === 'agent')
    const systemRows = rows.filter(r => r.source !== 'agent')
    expect(agentRows.length).toBe(expectedAgent)
    expect(systemRows.length).toBe(expectedSystem)
    for (const r of runs) {
      expect(agentRows.filter(x => x.run_id === r).length).toBeLessThanOrEqual(3)
      expect(systemRows.filter(x => x.run_id === r).length).toBeLessThanOrEqual(3)
    }
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
  it('100 agent Slack rows today leave the system its 50; 500 system rows leave the agent its 20', async () => {
    const s = await scene()
    await fill('agent', 100, s.nowMs)
    const { delivery } = fakeDelivery()
    const sys: string[] = []
    for (let i = 0; i < 51; i++) {
      const r = await sendSystemNotice({ DB: db, HUB_DELIVERY: delivery }, { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_sent', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
      sys.push(r.ok ? r.recipients[0]!.outcome : 'x')
    }
    expect(sys.filter(o => o === 'posted').length).toBe(50)
    const t = await scene()
    await fill('approvals', 500, t.nowMs)
    const agent: string[] = []
    for (let i = 0; i < 21; i++) {
      const r = await notifyAgent(ctxOf(delivery, t.nowMs), { ...scopeOf(t), runId: runId() }, msg())
      agent.push(r.recipients[0]!.outcome)
    }
    expect(agent.filter(o => o === 'posted').length).toBe(20)
  })
})

describe('test 11: sendSystemNotice', () => {
  const env1 = (delivery: DeliveryBinding | null) => ({ DB: db, ...(delivery ? { HUB_DELIVERY: delivery } : {}) })

  it('members and the alerts channel in one call; the title is the template, whatever body says', async () => {
    const s = await scene()
    const { delivery, calls } = fakeDelivery()
    const r = await sendSystemNotice(env1(delivery), { key: `p6:${uniq()}:1`, source: 'approvals', kind: 'approval_waiting', to: { members: [s.owner], alertsChannel: true }, body: 'Title: ignore me https://x.example.com', link: { kind: 'approval', id: 'ap_9' } }, { nowMs: s.nowMs })
    expect(r).toEqual({ ok: true, recipients: [{ kind: 'bell', to: s.owner, outcome: 'posted' }, { kind: 'slack', to: 'alerts', outcome: 'posted' }] })
    expect(calls.map(c => [c.req.channelId, c.req.title, c.req.text, c.req.link])).toEqual([['C0TEST0001', 'Approval waiting', 'Title: ignore me [link removed]', { kind: 'approval', id: 'ap_9' }]])
    const [row] = await notices('audience_member_id = ? AND template = ?', s.owner, 'approval_waiting')
    expect([row!.body, row!.fields_json]).toEqual(['Title: ignore me [link removed]', '{}'])
  })

  it('no alerts channel: the Slack part is skipped, the bell still goes; below Act it is skipped too', async () => {
    const s = await scene()
    await resetChannels([{ id: 'C0TEST0002', name: 'general' }])
    const r = await sendSystemNotice(env1(fakeDelivery().delivery), { key: `p6:${uniq()}:1`, source: 'questions', kind: 'question_asked', to: { members: [s.owner], alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect(r).toEqual({ ok: true, recipients: [{ kind: 'bell', to: s.owner, outcome: 'posted' }, { kind: 'slack', to: 'alerts', outcome: 'skipped', detail: 'no_alerts_channel' }] })
    await resetChannels([{ id: 'C0TEST0001', name: 'ops-alerts', alerts: true }])
    await setStage('Watch')
    const { delivery, calls } = fakeDelivery()
    const w = await sendSystemNotice(env1(delivery), { key: `p6:${uniq()}:1`, source: 'approvals', kind: 'needs_check', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect([w, calls.length]).toEqual([{ ok: true, recipients: [{ kind: 'slack', to: 'alerts', outcome: 'skipped', detail: 'below_act' }] }, 0])
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
    const r = await sendSystemNotice(env1(delivery), { key: `p6:${uniq()}:1`, source: 'approvals', kind: 'approval_failed', to: { members: [s.owner], alertsChannel: true }, body, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect(r).toEqual({ ok: true, recipients: [{ kind: 'bell', to: s.owner, outcome: 'refused', detail: 'too_long' }, { kind: 'slack', to: 'alerts', outcome: 'refused', detail: 'too_long' }] })
    expect(calls).toEqual([])
    expect(await notices('audience_member_id = ? AND template = ?', s.owner, 'approval_failed')).toEqual([])
    expect((await lines(since)).length).toBe(2)
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
    const go = (runId?: string) => sendSystemNotice(env1(delivery), { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_sent', ...(runId ? { runId } : {}), to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
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
    for (let i = 0; i < 50; i++) await sendSystemNotice(env1(delivery), { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_sent', to: { alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    const r = await sendSystemNotice(env1(delivery), { key: `k:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { members: [s.owner], alertsChannel: true }, link: { kind: 'today' } }, { nowMs: s.nowMs })
    expect(r).toEqual({ ok: true, recipients: [{ kind: 'bell', to: s.owner, outcome: 'posted' }, { kind: 'slack', to: 'alerts', outcome: 'refused', detail: 'day_cap' }] })
    expect(calls.length).toBe(50)
    // The agent's allowance is untouched by the system's 50.
    const a = await notifyAgent(ctxOf(delivery, s.nowMs), scopeOf(s), msg())
    expect(a.recipients[0]!.outcome).toBe('posted')
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
    expect(Object.values(NOTICE_TEMPLATES).filter(t => t.body).length).toBe(11)
  })
})
