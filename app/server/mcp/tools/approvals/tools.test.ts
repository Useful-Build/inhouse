// The approval tools (Stage 1 M2-E). Ways they can fail, written down first:
//  1. `approval_request` returns `run`, approves, reserves a use or schedules a send, even with a covering grant, or waits;
//  2. it makes a card while no operation is enabled (N2), without admission, for an unknown operation, for a routine's
//     own run or a removed person, or makes a second card for a retry;
//  3. the served map (no wiring until M2-D) makes anything at all;
//  4. `approval_get` or `approval_list` shows another member's action, or an admin's wider view inside a chat;
//  5. `approval_withdraw` takes back another member's action, another chat's, or one that isn't waiting;
//  6. a result or an audit line carries the model's arguments or the hub's output (results are fixed texts plus ids and
//     the card's server words; audit lines hold ids only);
//  7. a registry description promises a send or a wait (the descriptions are pinned here as literals).
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { lastLineId, linesSince } from '../../../db/test-support.ts'
import { POLICY_REV } from '../../../permissions/policy.ts'
import { insertGrant, person } from '../../../permissions/test-support.ts'
import { ADMIN, ASKER, HUB_FACTS, OTHER, SHOP_GEN, fresh, resetOutbox, rowOf, tagArgs, world } from '../../../outbox/test-support.ts'
import { INHOUSE_TOOLS } from '../../registry.ts'
import type { ToolHandler, ToolResult, ToolScope } from '../../server/tool.ts'
import { TOOL_HANDLERS } from '../index.ts'
import { approvalHandlers } from './index.ts'
import type { ApprovalsWiring } from './index.ts'

const db = env.DB
const T0 = 1_800_000_000_000
const CHAT = 'c_m2e_asker'
const OTHER_CHAT = 'c_m2e_other'

let n = 0
const scope = (memberId = ASKER, over: Partial<ToolScope> = {}): ToolScope => ({
  memberId, chatId: memberId === ASKER ? CHAT : `c_m2e_${memberId}`, runId: 'r_m2e', turnId: `t_m2e_${++n}`, nowMs: T0, requestId: fresh('req'), ...over,
})

/** The wiring M2-D will build: the hub's accounts, and an admission that hands out a fresh tool use id (or what a test says). */
let admitWith: () => { toolUseId: string; jobId: string | null } | null
const admitted: unknown[] = []
const wiring: ApprovalsWiring = {
  hubAccounts: async () => HUB_FACTS,
  admit: async (_s, input) => {
    admitted.push(input)
    return admitWith()
  },
}
const wired = approvalHandlers(() => wiring)

async function call(name: 'approval_request' | 'approval_get' | 'approval_list' | 'approval_withdraw', args: Record<string, unknown>, s: ToolScope, handlers: Partial<Record<string, ToolHandler>> = wired): Promise<ToolResult> {
  const h = handlers[name]!
  const parsed = h.input.safeParse(args)
  if (!parsed.success) throw new Error(`${name}: ${parsed.error.message}`)
  return h.call(parsed.data, s, { db })
}
const text = (r: ToolResult) => r.content[0].text
const data = (r: ToolResult) => r.structuredContent as Record<string, unknown>
const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n')) ?? 0

const request = (order = 1, s = scope(), tag = 'vip') => call('approval_request', { operation: 'shopify_order_tag_add', args: tagArgs(order, tag) }, s)
const made = async (order = 1, s = scope()) => {
  const r = await request(order, s)
  expect(r.isError, text(r)).toBeUndefined()
  return data(r).approval_id as string
}

const grant = async () => {
  const id = `pg_${fresh('g').replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'A').slice(0, 22)}`
  await insertGrant(db, {
    id, holder: `member:${ASKER}`, accountId: 'shopify:store', accountGen: SHOP_GEN, operation: 'shopify.order.tag_add', scopeKey: 'shop=store-a',
    perDay: 50, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
  })
  return id
}

beforeEach(async () => {
  await world(db)
  admitted.length = 0
  admitWith = () => ({ toolUseId: fresh('tu'), jobId: null })
})

describe('approval_request (failures 1, 2, 6)', () => {
  it('makes one waiting card through ask_only, says so in fixed words, and audits ids only', async () => {
    const mark = await lastLineId(db)
    const r = await request(1042, scope(), 'zebra-sale')
    expect(r.isError).toBeUndefined()
    const id = data(r).approval_id as string
    expect(text(r)).toBe(`It's in Approvals for the person to answer (approval_id: ${id}). Nothing goes out unless they approve it. This doesn't wait for the answer: check it later with approval_get.`)
    expect(data(r)).toMatchObject({ status: 'waiting', created: true, title: 'Add a tag to order 1042', lines: ['Tag: zebra-sale'], tool: 'Shopify (Store A)', this_chat: true })
    expect(await rowOf(db, id)).toMatchObject({ state: 'waiting', verdict: 'ask', via: 'approval_request', origin: 'chat', asked_by: ASKER, approver: ASKER, chat_id: CHAT, grant_id: null, send_at_ms: null })
    const lines = await linesSince(db, mark)
    expect(lines.map(l => [l.action, l.target_id])).toEqual([['action.requested', id]])
    for (const l of lines) {
      expect(l.args_json).not.toContain('zebra')
      expect(l.args_json).not.toContain('1042')
    }
    expect(admitted).toEqual([{ operation: 'shopify_order_tag_add', args: tagArgs(1042, 'zebra-sale') }])
  })

  it('never returns run, approves, reserves a use or schedules a send, even with a covering grant', async () => {
    await grant()
    for (const jobId of [null, 'j_m2e']) {
      admitWith = () => ({ toolUseId: fresh('tu'), jobId })
      const r = await request(jobId ? 2 : 1)
      expect(r.isError, text(r)).toBeUndefined()
      expect(data(r)).toMatchObject({ status: 'waiting', created: true })
      expect(await rowOf(db, data(r).approval_id as string)).toMatchObject({ state: 'waiting', verdict: 'ask', grant_id: null, approved_by: null, origin: jobId ? 'job' : 'chat', job_id: jobId })
    }
    expect(await count('permission_uses')).toBe(0)
    expect(await db.prepare("SELECT COUNT(*) AS n FROM outbox_actions WHERE state <> 'waiting' OR verdict = 'run'").first<number>('n')).toBe(0)
  })

  it('is refused, writing nothing, while no operation is enabled (N2)', async () => {
    await resetOutbox(db)
    await world(db)
    await db.prepare('DELETE FROM permission_ceiling').run()
    const mark = await lastLineId(db)
    const r = await request()
    expect(r).toMatchObject({ isError: true, structuredContent: { error: 'over_ceiling' } })
    expect(text(r)).toBe('This kind of action is turned off for this brand, so nothing was asked or sent.')
    expect(await count('outbox_actions')).toBe(0)
    expect(await linesSince(db, mark)).toEqual([])
  })

  it('refuses without admission, an unknown operation, bad arguments, a routine run and a removed person, writing nothing', async () => {
    const mark = await lastLineId(db)
    admitWith = () => null
    expect(data(await request())).toEqual({ error: 'not_admitted' })
    admitWith = () => ({ toolUseId: fresh('tu'), jobId: null })
    expect(data(await call('approval_request', { operation: 'shopify_order_delete', args: {} }, scope()))).toEqual({ error: 'unknown_operation' })
    expect(data(await call('approval_request', { operation: 'shopify.order.tag_add', args: tagArgs(1) }, scope()))).toEqual({ error: 'unknown_operation' })
    expect(data(await call('approval_request', { operation: 'shopify_order_tag_add', args: { orderId: 'x', tags: [] } }, scope()))).toEqual({ error: 'invalid_args' })
    expect(data(await request(1, scope('m_system', { chatId: 'c_m2e_routine' })))).toEqual({ error: 'no_one_to_ask' })
    await person(db, OTHER, 'member', 'removed')
    expect(data(await request(1, scope(OTHER)))).toEqual({ error: 'no_one_to_ask' })
    expect(await count('outbox_actions')).toBe(0)
    expect(await linesSince(db, mark)).toEqual([])
  })

  it("returns the waiting card for a retry, a replay as it is, and refuses other arguments under the same call", async () => {
    const id = await made(1)
    const retry = await request(1)
    expect(text(retry)).toBe(`The same action is already waiting in Approvals, so no second card was made (approval_id: ${id}). Check it with approval_get.`)
    expect(data(retry)).toMatchObject({ approval_id: id, created: false })
    admitWith = () => ({ toolUseId: 'tu_m2e_same', jobId: null })
    const first = await made(2)
    const replay = await request(2)
    expect(text(replay)).toBe(`This call already made approval ${first}. It's waiting for the person's answer in Approvals.`)
    expect(data(await request(3))).toEqual({ error: 'invocation_conflict' })
    expect(await count('outbox_actions')).toBe(2)
  })

  it('the served map has no wiring yet: refused with a fixed text, nothing made, even with the ceiling seeded (failure 3)', async () => {
    const mark = await lastLineId(db)
    const r = await call('approval_request', { operation: 'shopify_order_tag_add', args: tagArgs(1) }, scope(), Object.fromEntries(TOOL_HANDLERS))
    expect(r).toMatchObject({ isError: true, structuredContent: { error: 'not_switched_on' } })
    expect(text(r)).toBe("Asking for approval from chat isn't switched on yet, so nothing was asked or sent. Tell the person you can't put this in Approvals yet.")
    expect(await count('outbox_actions')).toBe(0)
    expect(await linesSince(db, mark)).toEqual([])
  })
})

describe('approval_get and approval_list (failure 4)', () => {
  it("read the person's own actions only: another member's isn't found, and an admin gets no wider view in a chat", async () => {
    const mine = await made(1)
    const theirs = await made(2, scope(OTHER))
    const get = await call('approval_get', { approval_id: mine }, scope())
    expect(text(get)).toBe(`Approval ${mine} is waiting for the person's answer in Approvals.`)
    expect(data(get)).toMatchObject({ approval_id: mine, status: 'waiting', title: 'Add a tag to order 1', this_chat: true })
    expect(Object.keys(data(get))).not.toContain('result')

    const other = await call('approval_get', { approval_id: theirs }, scope())
    expect(other).toMatchObject({ isError: true, structuredContent: { error: 'not_found' } })
    expect(text(other)).toBe("There's no approval with that approval_id for this person. Use approval_list to see theirs.")
    expect(data(await call('approval_get', { approval_id: 'ac_AAAAAAAAAAAAAAAAAAAAAA' }, scope()))).toEqual({ error: 'not_found' })

    const list = await call('approval_list', {}, scope())
    expect((data(list).approvals as { approval_id: string }[]).map(a => a.approval_id)).toEqual([mine])
    expect(text(list)).toBe('1 approval, newest first.')

    // The admin: neither card is theirs, so the chat's agent sees none of them.
    expect(data(await call('approval_get', { approval_id: mine }, scope(ADMIN)))).toEqual({ error: 'not_found' })
    const admin = await call('approval_list', {}, scope(ADMIN))
    expect(data(admin)).toEqual({ approvals: [] })
    expect(text(admin)).toBe('No approvals match.')
  })

  it('filters by status and shows a card from another chat as not this chat', async () => {
    const here = await made(1)
    const there = await made(2, scope(ASKER, { chatId: OTHER_CHAT }))
    expect(await call('approval_withdraw', { approval_id: here }, scope())).toMatchObject({ structuredContent: { status: 'withdrawn' } })
    const waiting = data(await call('approval_list', { status: 'waiting' }, scope())).approvals as { approval_id: string; this_chat: boolean }[]
    expect(waiting).toEqual([expect.objectContaining({ approval_id: there, this_chat: false })])
    const gone = data(await call('approval_list', { status: 'withdrawn' }, scope())).approvals as { approval_id: string }[]
    expect(gone.map(a => a.approval_id)).toEqual([here])
  })

  it('says a waiting card past its 7 days is expired', async () => {
    const id = await made(1)
    const later = await call('approval_get', { approval_id: id }, scope(ASKER, { nowMs: T0 + 8 * 24 * 3600_000 }))
    expect(data(later)).toMatchObject({ status: 'expired' })
  })
})

describe('approval_withdraw (failure 5)', () => {
  it("moves this chat's own waiting action to withdrawn, audited with ids only", async () => {
    const id = await made(1)
    const mark = await lastLineId(db)
    const r = await call('approval_withdraw', { approval_id: id }, scope())
    expect(text(r)).toBe(`Approval ${id} is withdrawn. Nothing from it will go out.`)
    expect(await rowOf(db, id)).toMatchObject({ state: 'withdrawn', rev: 2 })
    const lines = await linesSince(db, mark)
    expect(lines.map(l => [l.action, l.actor_id, l.target_id])).toEqual([['action.withdrawn', ASKER, id]])
    expect(JSON.parse(lines[0].args_json)).toEqual({ actionId: id, by: 'agent' })
    const again = await call('approval_withdraw', { approval_id: id }, scope())
    expect(again).toMatchObject({ isError: true, structuredContent: { error: 'conflict' } })
    expect(text(again)).toBe(`Approval ${id} is withdrawn, so there's nothing to take back.`)
  })

  it("can't take back another member's action, another chat's, or one the person already answered", async () => {
    const theirs = await made(1, scope(OTHER))
    const elsewhere = await made(2, scope(ASKER, { chatId: OTHER_CHAT }))
    const answered = await made(3)
    await db.prepare("UPDATE outbox_actions SET state = 'approved', rev = rev + 1 WHERE id = ?").bind(answered).run()
    const mark = await lastLineId(db)

    expect(data(await call('approval_withdraw', { approval_id: theirs }, scope()))).toEqual({ error: 'not_found' })
    // Even with the other member's own chat id in the scope, the action isn't this person's.
    expect(data(await call('approval_withdraw', { approval_id: theirs }, scope(ASKER, { chatId: `c_m2e_${OTHER}` })))).toEqual({ error: 'not_found' })
    const other = await call('approval_withdraw', { approval_id: elsewhere }, scope())
    expect(other).toMatchObject({ structuredContent: { error: 'forbidden' } })
    expect(text(other)).toBe('That approval was asked for in another chat, so it can only be taken back there. The person can still say No to it in Approvals.')
    const late = await call('approval_withdraw', { approval_id: answered }, scope())
    expect(text(late)).toBe(`Approval ${answered} is approved and in its short hold, when the person can still undo it, so there's nothing to take back.`)

    expect((await rowOf(db, theirs))?.state).toBe('waiting')
    expect((await rowOf(db, elsewhere))?.state).toBe('waiting')
    expect((await rowOf(db, answered))?.state).toBe('approved')
    expect(await linesSince(db, mark)).toEqual([])
  })
})

describe('the registry (failure 7)', () => {
  it('describes the four approval tools in plain, honest words', () => {
    const approvals = INHOUSE_TOOLS.filter(t => t.category === 'approvals').map(t => ({ name: t.name, alwaysLoad: t.alwaysLoad, annotations: t.annotations, description: t.description }))
    expect(approvals).toEqual([
      { name: 'approval_request', alwaysLoad: true, annotations: {}, description: "Put an action in Approvals for the person to answer, without doing it: `operation` is the write tool's name and `args` its arguments. It only makes the card: it doesn't wait for the answer and doesn't send anything, and nothing goes out unless the person approves it. An action that's turned off for this brand is refused. Returns `approval_id`; check it later with `approval_get`." },
      { name: 'approval_get', alwaysLoad: false, annotations: { readOnlyHint: true }, description: "Check one of this person's approvals by `approval_id`: waiting, approved, sent, didn't go out, declined, withdrawn or expired." },
      { name: 'approval_list', alwaysLoad: false, annotations: { readOnlyHint: true }, description: "List this person's approvals, newest first, optionally by `status`, so you don't ask for the same thing twice." },
      { name: 'approval_withdraw', alwaysLoad: false, annotations: { destructiveHint: true }, description: "Take back an approval this chat asked for that's still waiting and no longer needed (for example, the stock arrived), by `approval_id`. It can't take back one the person already answered." },
    ])
  })
})
