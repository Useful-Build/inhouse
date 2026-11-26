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
import { ADMIN, ASKER, SHOP_GEN, fresh, outbox, requestCtx, rowOf, tagArgs, unreleasedUses, world } from './test-support.ts'

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
    await db.prepare('UPDATE chats SET deleted_at_ms = 1 WHERE id = ?').bind(c).run()
    const a = await ask(c, 6)
    for (const choice of ['once', 'always', 'deny'] as const) {
      expect(await outbox(db, () => T0).answer({ memberId: ASKER, role: 'member' }, a.id, { choice, ifRev: a.rev }), choice).toEqual({ refused: { code: 'conflict' } })
    }
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'waiting', rev: a.rev })
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
