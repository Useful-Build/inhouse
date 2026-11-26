// A deleted chat withdraws its actions; a card's permission (Stage 1 M2-D; N11, from #433's review; #442's carry-over).
// Ways it can fail, written down first:
//  1. a waiting card of a deleted chat stays approvable for its 7 days, or an approval in its hold is still claimed;
//  2. the deletion touches another chat's actions, a final row or a row in flight (`sending`), or keeps an approved
//     row's use;
//  3. the withdrawal isn't audited, or its line carries more than ids;
//  4. the card names no permission for an action run under "Always allow" (so "Stop allowing this" can't name it), or
//     names one to a viewer who may not remove it.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { chatStore } from '../db/chats.ts'
import { lastLineId, linesSince } from '../db/test-support.ts'
import { POLICY_REV } from '../permissions/policy.ts'
import { insertGrant } from '../permissions/test-support.ts'
import { cardOf } from './card.ts'
import { ADMIN, ASKER, HUB_FACTS, SHOP_GEN, fresh, outbox, requestCtx, rowOf, sendNow, tagArgs, unreleasedUses, world } from './test-support.ts'
import { openOutbox } from './store.ts'
import { outboxFacts } from './facts.ts'

const db = env.DB
const T0 = 1_800_000_000_000

const chat = async (id: string) => {
  await db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, 0, 0) ON CONFLICT (id) DO UPDATE SET deleted_at_ms = NULL').bind(id, ASKER, 'A chat').run()
}
const ask = async (chatId: string, order: number) => {
  const r = await outbox(db, () => T0).request(requestCtx({ nowMs: T0, chatId }), { operation: 'shopify.order.tag_add', args: tagArgs(order) }, { mode: 'tool' })
  if (r.outcome === 'refused') throw new Error(r.reason)
  return r.action
}
const grant = async () => {
  const id = `pg_${fresh('g').replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'A').slice(0, 22)}`
  await insertGrant(db, {
    id, holder: `member:${ASKER}`, accountId: 'shopify:store', accountGen: SHOP_GEN, operation: 'shopify.order.tag_add', scopeKey: 'shop=store-a',
    perDay: 50, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
  })
  return id
}
const at = { actorId: ASKER, requestId: 'req-delete', nowMs: T0 + 1_000 }

beforeEach(async () => {
  await world(db)
})

describe('a deleted chat withdraws its waiting and approved actions (failures 1, 2, 3)', () => {
  it('withdrawn in the deletion\'s own batch, uses released, one id-only line each; another chat and final rows untouched', async () => {
    const c1 = `c_del_${fresh('a')}`
    const c2 = `c_del_${fresh('b')}`
    await chat(c1)
    await chat(c2)
    const waiting = await ask(c1, 1)
    await grant()
    const approved = await ask(c1, 2)
    expect(approved.state).toBe('approved')
    expect(await unreleasedUses(db, approved.id)).toHaveLength(1)
    const elsewhere = await ask(c2, 3)
    const sent = await ask(c1, 4)
    await db.prepare("UPDATE outbox_actions SET state = 'sent' WHERE id = ?").bind(sent.id).run()
    const mark = await lastLineId(db)

    await chatStore({ db }).markDeleted([c1], ASKER, at)

    for (const id of [waiting.id, approved.id]) {
      expect(await rowOf(db, id)).toMatchObject({ state: 'withdrawn', lapsed_reason: 'chat_deleted', final_at_ms: at.nowMs })
    }
    expect(await unreleasedUses(db, approved.id)).toEqual([])
    expect(await rowOf(db, elsewhere.id)).toMatchObject({ state: elsewhere.state })
    expect(await rowOf(db, sent.id)).toMatchObject({ state: 'sent' })
    const lines = (await linesSince(db, mark)).filter(l => l.action === 'action.withdrawn')
    expect(lines.map(l => [l.target_id, l.actor_id, JSON.parse(l.args_json)]).sort()).toEqual(
      [[approved.id, ASKER, { actionId: approved.id, by: 'member' }], [waiting.id, ASKER, { actionId: waiting.id, by: 'member' }]].sort(),
    )
    // The card says why.
    expect(cardOf((await rowOf(db, waiting.id))!, { memberId: ASKER, role: 'member' }, T0).lapsed).toBe('The chat it was asked in was deleted, so this was withdrawn.')
  })

  it('a request from a chat already in the trash is refused (the window before BrandAgent ends its turns), writing nothing', async () => {
    const c = `c_del_${fresh('f')}`
    await chat(c)
    await db.prepare('UPDATE chats SET deleted_at_ms = 1 WHERE id = ?').bind(c).run()
    const r = await outbox(db, () => T0).request(requestCtx({ nowMs: T0, chatId: c }), { operation: 'shopify.order.tag_add', args: tagArgs(9) }, { mode: 'tool' })
    expect(r).toEqual({ outcome: 'refused', reason: 'chat_deleted', text: 'This chat was deleted, so nothing was asked or sent.' })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM outbox_actions WHERE chat_id = ?').bind(c).first<number>('n')).toBe(0)
  })

  it('another owner\'s deletion of the same ids changes nothing (the update is the owner\'s own chats)', async () => {
    const c = `c_del_${fresh('c')}`
    await chat(c)
    const a = await ask(c, 5)
    await chatStore({ db }).markDeleted([c], ADMIN, { ...at, actorId: ADMIN })
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'waiting' })
  })

  it('an answer to a card whose chat is in the trash is refused (the race the deletion\'s batch can\'t close)', async () => {
    const c = `c_del_${fresh('d')}`
    await chat(c)
    const a = await ask(c, 6)
    // Put in the trash by hand, without the deletion's withdrawal: the card is still waiting.
    await db.prepare('UPDATE chats SET deleted_at_ms = 1 WHERE id = ?').bind(c).run()
    for (const choice of ['once', 'always', 'deny'] as const) {
      expect(await outbox(db, () => T0).answer({ memberId: ASKER, role: 'member' }, a.id, { choice, ifRev: a.rev }), choice).toEqual({ refused: { code: 'conflict' } })
    }
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'waiting', rev: a.rev })
  })
})

describe('M2-D round 2: the insert and the claim check the chat and the store themselves', () => {
  it('a chat deleted after the request\'s own read and before its insert gets nothing (the insert\'s condition), even with a grant', async () => {
    for (const withGrant of [false, true]) {
      if (withGrant) await grant()
      const c = `c_del_${fresh('race')}`
      await chat(c)
      const base = outboxFacts({ db, hubAccounts: async () => HUB_FACTS })
      const port = openOutbox({
        db, requestId: fresh('req'), now: () => T0, schedule: async () => {},
        // The deletion lands while `decide` reads its facts: after the request's chat read, before its batch.
        facts: { resolveFacts: base.resolveFacts, decideFacts: async (r, ctx) => {
          await db.prepare('UPDATE chats SET deleted_at_ms = 1 WHERE id = ?').bind(c).run()
          return base.decideFacts(r, ctx)
        } },
      })
      const r = await port.request(requestCtx({ nowMs: T0, chatId: c }), { operation: 'shopify.order.tag_add', args: tagArgs(20) }, { mode: 'tool' })
      expect(r, String(withGrant)).toEqual({ outcome: 'refused', reason: 'chat_deleted', text: 'This chat was deleted, so nothing was asked or sent.' })
      expect(await db.prepare('SELECT COUNT(*) AS n FROM outbox_actions WHERE chat_id = ?').bind(c).first<number>('n')).toBe(0)
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM permission_uses').first<number>('n')).toBe(0)
  })

  it('the claim refuses an approval whose chat went to the trash without its withdrawal: withdrawn, its use released, nothing sent', async () => {
    await grant()
    const c = `c_del_${fresh('claim')}`
    await chat(c)
    const a = await ask(c, 21)
    expect(a.state).toBe('approved')
    await db.prepare('UPDATE chats SET deleted_at_ms = 1 WHERE id = ?').bind(c).run()
    const hub = await sendNow(db, a.id, a.send_at_ms! + 1)
    expect(hub.calls).toEqual([])
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'withdrawn', lapsed_reason: 'chat_deleted' })
    expect(await unreleasedUses(db, a.id)).toEqual([])
  })

  it('the claim refuses a Shopify action whose store changed under the same connection date: withdrawn, nothing sent', async () => {
    await grant()
    const c = `c_shop_${fresh('claim')}`
    await chat(c)
    const a = await ask(c, 22)
    expect(JSON.parse(a.scope_json)).toEqual({ shop: 'store-a' })
    await db.prepare("UPDATE connector_accounts SET shop = 'store-b' WHERE account_id = 'shopify:store'").run()
    const hub = await sendNow(db, a.id, a.send_at_ms! + 1)
    expect(hub.calls).toEqual([])
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'withdrawn', lapsed_reason: 'account_changed' })
  })

  it('the same store at send: the claim goes through and it is sent once', async () => {
    await grant()
    const c = `c_shop_${fresh('ok')}`
    await chat(c)
    const a = await ask(c, 23)
    const hub = await sendNow(db, a.id, a.send_at_ms! + 1)
    expect(hub.calls).toHaveLength(1)
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'sent' })
  })
})

describe('the card names its permission (failure 4)', () => {
  it('an action run under "Always allow" carries its permission id for its asker and an admin; others never', async () => {
    const g = await grant()
    const c = `c_perm_${fresh('e')}`
    await chat(c)
    const run = await ask(c, 7)
    expect(run.grant_id).toBe(g)
    expect(cardOf(run, { memberId: ASKER, role: 'member' }, T0).permissionId).toBe(g)
    expect(cardOf(run, { memberId: ADMIN, role: 'admin' }, T0).permissionId).toBe(g)
    expect('permissionId' in cardOf(run, { memberId: 'm_someone', role: 'member' }, T0)).toBe(false)
    await db.prepare('DELETE FROM permission_grants').run()
    const plain = await ask(c, 8)
    expect('permissionId' in cardOf(plain, { memberId: ASKER, role: 'member' }, T0)).toBe(false)
  })
})
