// notification_send as the model sees it (p5-w4.md section 2), in the Workers runtime on the real migrations: the
// input schema's limits and the result text's closed list. Ways it can fail, written down first:
//  1. the schema lets through more recipients than the design allows, an unknown key, or a free-form link;
//  2. the result text says "sent" for something that wasn't, or leaks anything but the closed reasons and listed names;
//  3. without the hub's deps the tool throws instead of answering slack_unavailable (and the bell must still go).
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { PostNoticeRequest } from '../../../../hub/index/contract.ts'
import type { ToolScope } from '../../server/tool.ts'
import { notifyDeps } from './deps.ts'
import { NotificationSendInput, notificationSend } from './send.ts'

const db = env.DB
let u = 0
const uniq = () => `${++u}q${Math.random().toString(36).slice(2, 8)}`

async function setup(stage: string) {
  const owner = `m_${uniq()}`
  await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'admin', 'active', 'N', 1)").bind(owner).run()
  const chatId = `c_${uniq()}`
  await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, 'T', 1, 1)").bind(chatId, owner).run()
  await db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 'stage', ?, 1, 1, 'm_system', 'r') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json").bind(JSON.stringify(stage)).run()
  await db.prepare('DELETE FROM notify_channels').run()
  await db.prepare("INSERT INTO notify_channels (channel_id, name, alerts, added_by, added_at_ms) VALUES ('C0TEST0001', 'ops-alerts', 0, 'm_system', 1), ('C0TEST0002', 'general', 0, 'm_system', 1)").run()
  const scope: ToolScope = { memberId: owner, chatId, runId: `r_${uniq().padEnd(22, 'Z').slice(0, 22)}`, turnId: `t_${uniq().padEnd(22, 'Z').slice(0, 22)}`, nowMs: Date.UTC(2026, 5, 1) + u * 86_400_000, requestId: `mcp-${uniq()}` }
  return { owner, scope }
}

const posts: PostNoticeRequest[] = []
const HUB_DELIVERY = {
  async postNotice(_scope: unknown, req: PostNoticeRequest) {
    posts.push(req)
    return req.channelId === 'C0TEST0002'
      ? { ok: false, error: { code: 'connect_refused', message: 'connect refused by the provider: not_member' } }
      : { ok: true, value: { ts: '1.1' } }
  },
}

const text = (r: { content: { text: string }[] }) => r.content[0]!.text

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

describe('the result text', () => {
  it('at Act: sent, refused with the listed names, not_member, the bell, and what changed', async () => {
    const { owner, scope } = await setup('Act')
    const args = NotificationSendInput.parse({ to: { members: [owner, 'm_nobody'], channels: ['#ops-alerts', 'random', 'General'] }, title: 'Low stock', text: 'See https://x.example.com <!here>', format: 'message', link: { kind: 'today' } })
    const r = await notificationSend.call(args, scope, { db, notify: notifyDeps({ HUB_DELIVERY }) })
    expect(text(r).split('\n')).toEqual([
      `${owner}: sent`,
      'm_nobody: refused: unknown_member',
      '#ops-alerts: sent',
      '#random: refused: not_listed (listed: #general, #ops-alerts)',
      '#General: refused: not_member',
      'changed: links removed',
      'changed: mentions escaped',
    ])
    expect(r.isError).toBeUndefined()
  })

  it('at Watch a channel reaches the bell and says so', async () => {
    const { scope } = await setup('Watch')
    const before = posts.length
    const args = NotificationSendInput.parse({ to: { channels: ['ops-alerts'] }, title: 'T', text: 'x', format: 'report' })
    const r = await notificationSend.call(args, scope, { db, notify: notifyDeps({ HUB_DELIVERY }) })
    expect(text(r)).toBe('#ops-alerts: sent to the bell (Slack starts at Act)')
    expect(posts.length).toBe(before)
  })

  it('without the delivery deps, channels answer slack_unavailable and the bell still goes', async () => {
    const { owner, scope } = await setup('Act')
    const args = NotificationSendInput.parse({ to: { members: [owner], channels: ['ops-alerts'] }, title: 'T', text: 'y', format: 'message' })
    const r = await notificationSend.call(args, scope, { db })
    expect(text(r).split('\n')).toEqual([`${owner}: sent`, '#ops-alerts: refused: slack_unavailable'])
  })

  it('the 4th Slack post in one run is refused with the run cap named', async () => {
    const { scope } = await setup('Act')
    const out: string[] = []
    for (let i = 0; i < 4; i++) {
      const args = NotificationSendInput.parse({ to: { channels: ['ops-alerts'] }, title: `T${i}`, text: 'z', format: 'message' })
      out.push(text(await notificationSend.call(args, scope, { db, notify: notifyDeps({ HUB_DELIVERY }) })))
    }
    expect(out).toEqual(['#ops-alerts: sent', '#ops-alerts: sent', '#ops-alerts: sent', '#ops-alerts: refused: run_cap (3 Slack posts per run)'])
  })
})
