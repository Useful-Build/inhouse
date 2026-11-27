// The server's two fixed notices to the alerts channel (Stage 1 M2-N, Q3 = A): "an approval is waiting" (BrandAgent's
// askNoted, for a card `request` made) and "a routine failed" (routines/end.ts). Real D1, a fake DeliveryGateway. Ways it
// can fail, written first:
//  1. a notice posts with no alerts channel, without Slack (no binding, or the hub says it's not connected), or twice
//     for one card or one run slot (a retry, a replayed request, a re-run end);
//  2. a card approved under a grant, or a final one, announces itself as waiting;
//  3. a quiet `not_connected` failure, or a run that went fine, posts;
//  4. a post carries the card's lines or the model's text (only the template's title and fixed text go).
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HubResult, PostNoticeRequest } from '../../hub/index/contract.ts'
import { outbox, requestCtx, resetOutbox, world } from '../outbox/test-support.ts'
import { ceiling } from '../permissions/test-support.ts'
import { routineEnd } from '../routines/end.ts'
import { endTaskId } from '../routines/keys.ts'
import { addPerson, fresh, insertRoutine, insertSlot, routine, runIdFor, turnIdFor } from '../routines/test-kit.ts'
import { alertApprovalWaiting, alertRoutineFailed } from './alerts-notices.ts'
import type { DeliveryBinding } from './send.ts'

const db = env.DB
let dayN = 0
const day = () => Date.UTC(2026, 2, 1) + ++dayN * 86_400_000

function fakeDelivery(answer: () => HubResult<{ ts: string }> = () => ({ ok: true, value: { ts: '1.1' } })) {
  const posts: PostNoticeRequest[] = []
  const delivery: DeliveryBinding = {
    async postNotice(_scope, req) {
      posts.push(req)
      return answer()
    },
    async listChannels() { throw new Error('not used') },
    async checkChannel() { throw new Error('not used') },
  }
  return { delivery, posts }
}

async function channels(alerts: boolean) {
  await db.prepare('DELETE FROM notify_channels').run()
  await db.prepare('INSERT INTO notify_channels (channel_id, name, alerts, added_by, added_at_ms) VALUES (?, ?, ?, ?, 1)').bind('C0ALERT001', 'ops-alerts', alerts ? 1 : 0, 'm_system').run()
}

describe('"an approval is waiting" to the alerts channel', () => {
  beforeEach(async () => {
    await world(db)
    await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1 })
  })

  async function waitingCard(nowMs: number): Promise<string> {
    const r = await outbox(db, () => nowMs).request(requestCtx({ nowMs }), { operation: 'shopify.order.tag_add', args: { orderIds: ['gid://shopify/Order/42'], tags: ['vip-secret-tag'] } }, { mode: 'tool' })
    if (r.outcome !== 'waiting') throw new Error(`expected a card, got ${r.outcome}`)
    return r.action.id
  }

  it('posts once to the alerts channel: the template title, fixed text and a link to the card, never its lines', async () => {
    await channels(true)
    const nowMs = day()
    const id = await waitingCard(nowMs)
    const { delivery, posts } = fakeDelivery()
    await alertApprovalWaiting({ DB: db, HUB_DELIVERY: delivery }, id, { nowMs })
    await alertApprovalWaiting({ DB: db, HUB_DELIVERY: delivery }, id, { nowMs })
    expect(posts.map(p => [p.channelId, p.title, p.text, p.link])).toEqual([['C0ALERT001', 'Approval waiting', 'Open Inhouse for the details.', { kind: 'approval', id }]])
    expect(JSON.stringify(posts)).not.toContain('vip-secret-tag')
  })

  it('no alerts channel, no delivery binding, or Slack not connected at the hub: nothing is posted and nothing throws', async () => {
    const nowMs = day()
    const id = await waitingCard(nowMs)
    await channels(false)
    const none = fakeDelivery()
    await alertApprovalWaiting({ DB: db, HUB_DELIVERY: none.delivery }, id, { nowMs })
    expect(none.posts).toEqual([])
    await channels(true)
    await alertApprovalWaiting({ DB: db }, id, { nowMs })
    const off = fakeDelivery(() => ({ ok: false, error: { code: 'not_configured', message: 'connector not configured' } }))
    const other = await waitingCard(nowMs + 1)
    await alertApprovalWaiting({ DB: db, HUB_DELIVERY: off.delivery }, other, { nowMs })
    expect(off.posts.length, 'one try at the hub, which refused it').toBe(1)
    const sends = (await db.prepare("SELECT outcome, detail FROM notify_sends WHERE source = 'approvals' AND notice_kind = 'approval_waiting' AND at_ms = ? ORDER BY detail").bind(nowMs).all()).results
    expect(sends).toEqual([{ outcome: 'refused', detail: 'slack_not_connected' }])
  })

  it('a card that isn\'t waiting (approved under a grant, or final) announces nothing', async () => {
    await channels(true)
    const nowMs = day()
    const id = await waitingCard(nowMs)
    await db.prepare("UPDATE outbox_actions SET state = 'approved' WHERE id = ?").bind(id).run()
    const { delivery, posts } = fakeDelivery()
    await alertApprovalWaiting({ DB: db, HUB_DELIVERY: delivery }, id, { nowMs })
    await alertApprovalWaiting({ DB: db, HUB_DELIVERY: delivery }, 'ac_nosuchaction00000000', { nowMs })
    expect(posts).toEqual([])
    await resetOutbox(db)
  })
})

describe('"a routine failed" to the alerts channel', () => {
  const CREATOR = 'm_m2n_creator'
  beforeEach(async () => {
    await fresh()
    await addPerson(CREATOR)
  })

  async function endSlot(e: { outcome: string; failure: string | null }, envOf: { DB: D1Database; HUB_DELIVERY?: unknown }, nowMs: number, slot?: { routineId: string; slotKey: string; chatId: string; turnId: string; runId: string }) {
    let s = slot
    if (!s) {
      const r = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: nowMs - 60_000 }))
      const row = await insertSlot({ routine_id: r.id, local_date: '2026-03-01', claimed_at_ms: nowMs - 60_000, state: 'started', outcome: null, ended_at_ms: null, creator_id: CREATOR })
      s = { routineId: r.id, slotKey: row.slot_key, chatId: row.chat_id, turnId: turnIdFor(), runId: runIdFor() }
    }
    const payload = { turnId: s.turnId, runId: s.runId, chatId: s.chatId, ...e, structuredOutput: null }
    await routineEnd({ id: endTaskId(s.slotKey), kind: 'routine-end', gen: 1, dueAtMs: nowMs, payload, attempts: 0 }, { nowMs, env: envOf as unknown as Env })
    return s
  }

  it('a failed run posts once (a re-run end posts nothing more), with a link to the routine', async () => {
    await channels(true)
    const nowMs = day()
    const { delivery, posts } = fakeDelivery()
    const s = await endSlot({ outcome: 'failed', failure: 'structured_output' }, { DB: db, HUB_DELIVERY: delivery }, nowMs)
    await endSlot({ outcome: 'failed', failure: 'structured_output' }, { DB: db, HUB_DELIVERY: delivery }, nowMs + 60_000, s)
    expect(posts.map(p => [p.channelId, p.title, p.text, p.link])).toEqual([['C0ALERT001', 'A routine failed', 'Open Inhouse for the details.', { kind: 'routine', id: s.routineId }]])
  })

  it('a run that went fine, a quiet not_connected, or no alerts channel posts nothing', async () => {
    await channels(true)
    const { delivery, posts } = fakeDelivery()
    await endSlot({ outcome: 'done', failure: null }, { DB: db, HUB_DELIVERY: delivery }, day())
    await endSlot({ outcome: 'cancelled', failure: 'not_connected' }, { DB: db, HUB_DELIVERY: delivery }, day())
    await channels(false)
    await endSlot({ outcome: 'failed', failure: 'structured_output' }, { DB: db, HUB_DELIVERY: delivery }, day())
    expect(posts).toEqual([])
  })

  it('no delivery binding (Slack not wired): the end still lands, nothing posts', async () => {
    await channels(true)
    const s = await endSlot({ outcome: 'failed', failure: 'structured_output' }, { DB: db }, day())
    expect((await db.prepare('SELECT state, failure FROM routine_slots WHERE slot_key = ?').bind(s.slotKey).first())).toEqual({ state: 'ended', failure: 'structured_output' })
  })

  it('one key per slot, whatever characters the slot key holds', async () => {
    await channels(true)
    const nowMs = day()
    const { delivery, posts } = fakeDelivery()
    for (const slotKey of ['now|rt_AAAAAAAAAAAAAAAAAAAAAA|client key with spaces', 'now|rt_AAAAAAAAAAAAAAAAAAAAAA|other']) {
      await alertRoutineFailed({ DB: db, HUB_DELIVERY: delivery }, { slotKey, routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA', runId: null }, { nowMs })
      await alertRoutineFailed({ DB: db, HUB_DELIVERY: delivery }, { slotKey, routineId: 'rt_AAAAAAAAAAAAAAAAAAAAAA', runId: null }, { nowMs })
    }
    expect(posts.length).toBe(2)
  })
})
