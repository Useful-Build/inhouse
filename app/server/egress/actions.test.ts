// The egress's `actions` route (Stage 1 M2-D, N14) on the real D1 and the real outbox, with a fake BrandAgent and a fake
// clock. Ways it can fail, written down first:
//  1. a call with no grant makes no card, or doesn't wait; an answer inside 2 minutes doesn't come back as the result;
//     no answer doesn't come back as "waiting", or leaves the report unclaimed (zero reports);
//  2. a covering grant doesn't run through the hold, or a grant whose day is spent gives anything but an exact card;
//  3. an unknown tool, a call admission refuses, or the product's state (no operation on) writes anything;
//  4. a fourth parallel ask waits, or a job's turn waits;
//  5. the answer carries connector output (only server words and a safe ref), or `tools/list` lists an operation that's off;
//  6. a refused claim of the report (another waiter, a dead turn) still waits.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { FakeBrandAgentRpc } from '../do/brand-agent/testing/fake-brand-agent-rpc.ts'
import type { Admitted } from '../do/brand-agent/invocations.ts'
import type { RunGrant } from '../do/brand-agent/tokens.ts'
import { WAIT_MAX_MS } from '../do/brand-agent/asks.ts'
import { sendAction } from '../outbox/dispatch.ts'
import { ASKER, HUB_FACTS, SHOP_GEN, fakeHub, fresh, notices, outbox, rowOf, tagArgs, world } from '../outbox/test-support.ts'
import { insertGrant } from '../permissions/test-support.ts'
import { POLICY_REV } from '../permissions/policy.ts'
import { ACTION_WORDS, callAction, handleActions } from './actions.ts'
import type { ActionsRouteDeps } from './actions.ts'

const db = env.DB
const T0 = 1_800_000_000_000
const CHAT = 'c_m2d_chat'

const grantOf = (turnId: string): RunGrant => ({
  turnId, runId: 'r_m2d', chatId: CHAT, memberId: ASKER, sessionId: '00000000-0000-4000-8000-0000000000d2', model: 'claude-sonnet-5-5',
  sideModel: 'claude-haiku-5-5', expiresAtMs: T0 + 3_600_000,
})

interface World { deps: ActionsRouteDeps; rpc: FakeBrandAgentRpc; clock: { now: number }; onSleep: ((now: number) => Promise<void>) | null; turnId: string }

function setup(o: { jobId?: string | null; ownerId?: string } = {}): World {
  const turnId = `t_m2d_${fresh('t')}`
  const rpc = new FakeBrandAgentRpc()
  const clock = { now: T0 }
  rpc.admitActionAnswer = (): Admitted => ({ toolUseId: fresh('toolu'), turnId, runId: 'r_m2d', chatId: CHAT, ownerId: o.ownerId ?? ASKER, jobId: o.jobId ?? null, replay: false })
  rpc.askWaitAnswer = { wait: true, untilMs: T0 + 165_000 }
  rpc.askTurnLiveAnswer = true
  rpc.hubAccountsAnswer = [...HUB_FACTS]
  const w: World = {
    rpc, clock, turnId, onSleep: null,
    deps: {
      db, rpc, now: () => clock.now, requestId: () => fresh('req'), log: () => {},
      sleep: async ms => {
        clock.now += ms
        if (w.onSleep) await w.onSleep(clock.now)
      },
    },
  }
  return w
}

const call = (w: World, args: Record<string, unknown> = tagArgs(1042, 'sale'), name = 'shopify_order_tag_add') => callAction(grantOf(w.turnId), name, args, w.deps)
const text = (r: { content: { text: string }[] }) => r.content[0]!.text
const idOf = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent?.approval_id as string
const count = async () => (await db.prepare('SELECT COUNT(*) AS n FROM outbox_actions').first<number>('n')) ?? 0
const methods = (rpc: FakeBrandAgentRpc) => rpc.calls.map(c => c.method)

/** Sends an approved action as BrandAgent's task would, through the fake hub (its ref is always `vip`), at the clock's time. */
async function send(id: string, now: number) {
  const hub = fakeHub(db, () => 'ok')
  await sendAction(id, { db, nowMs: now, hub: hub.gateway, notify: notices().notify, requestId: fresh('send'), again: () => {}, gate: { paused: false, pauseGen: 0 }, timeoutMs: 1_000 })
  return hub
}

beforeEach(async () => {
  await world(db)
  await db.prepare('UPDATE members SET name = NULL WHERE id = ?').bind(ASKER).run()
})

describe('a write with no permission: a card, a wait, the answer (failure 1)', () => {
  it('an answer inside 2 minutes comes back as the result, the report is the tool\'s, and the turn got its ask part', async () => {
    const w = setup()
    let id = ''
    let answered = false
    let sent = false
    w.onSleep = async now => {
      id ||= (await db.prepare('SELECT id FROM outbox_actions ORDER BY created_at_ms DESC LIMIT 1').first<string>('id'))!
      if (!answered && now >= T0 + 20_000) {
        const row = (await rowOf(db, id))!
        const r = await outbox(db, () => now).answer({ memberId: ASKER, role: 'member' }, id, { choice: 'once', ifRev: row.rev })
        expect('action' in r && r.action.state).toBe('approved')
        answered = true
      } else if (answered && !sent && now >= T0 + 32_000) {
        await send(id, now)
        sent = true
      }
    }
    const r = await call(w)
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe(`${ACTION_WORDS.sent('vip')} (approval_id: ${idOf(r)})`)
    expect(r.structuredContent).toEqual({ approval_id: idOf(r), status: 'sent' })
    expect(await rowOf(db, idOf(r))).toMatchObject({ state: 'sent', report: 'tool', verdict: 'ask', via: 'tool', origin: 'chat', chat_id: CHAT, turn_id: w.turnId })
    expect(methods(w.rpc)).toEqual(['admitAction', 'hubAccounts', 'askNoted', 'beginAskWait', 'askTurnLive', 'askTurnLive', 'endAskWait'])
    expect(w.rpc.calls.find(c => c.method === 'admitAction')!.args.slice(0, 2)).toEqual([w.turnId, 'mcp__actions__shopify_order_tag_add'])
    expect(w.rpc.calls.find(c => c.method === 'endAskWait')!.args).toEqual([idOf(r), true])
    // It waited: polled every 2 s until the send, not past it.
    expect(w.clock.now).toBeGreaterThanOrEqual(T0 + 32_000)
    expect(w.clock.now).toBeLessThan(T0 + 40_000)
  })

  it('"The person said no." when they deny it', async () => {
    const w = setup()
    w.onSleep = async now => {
      const row = await db.prepare("SELECT * FROM outbox_actions WHERE state = 'waiting' ORDER BY created_at_ms DESC LIMIT 1").first<{ id: string; rev: number }>()
      if (row && now >= T0 + 6_000) await outbox(db, () => now).answer({ memberId: ASKER, role: 'member' }, row.id, { choice: 'deny', ifRev: row.rev })
    }
    const r = await call(w)
    expect(text(r)).toBe(`The person said no. (approval_id: ${idOf(r)})`)
    expect(await rowOf(db, idOf(r))).toMatchObject({ state: 'denied', report: 'tool' })
  })

  it('no answer in 2 minutes: "waiting" in server words, the report handed on (`later`), the wait ended undelivered', async () => {
    const w = setup()
    const r = await call(w)
    expect(text(r)).toBe(`Waiting for the person's OK. It's in Approvals. (approval_id: ${idOf(r)})`)
    expect(r.structuredContent).toEqual({ approval_id: idOf(r), status: 'waiting' })
    expect(w.clock.now - T0).toBe(WAIT_MAX_MS)
    expect(await rowOf(db, idOf(r))).toMatchObject({ state: 'waiting', report: 'later' })
    expect(w.rpc.calls.find(c => c.method === 'endAskWait')!.args).toEqual([idOf(r), false])
  })

  it('names the approver when the team knows their name', async () => {
    await db.prepare("UPDATE members SET name = 'Dana' WHERE id = ?").bind(ASKER).run()
    const r = await call(setup())
    expect(text(r)).toBe(`Waiting for Dana's OK. It's in Approvals. (approval_id: ${idOf(r)})`)
  })

  it('a waiter that can\'t claim the report (the turn died, or another waiter has it) answers where it stands, without waiting', async () => {
    const w = setup()
    w.rpc.askTurnLiveAnswer = false
    const r = await call(w)
    expect(text(r)).toBe(`Waiting for the person's OK. It's in Approvals. (approval_id: ${idOf(r)})`)
    expect(w.clock.now).toBe(T0)
    expect((await rowOf(db, idOf(r)))!.report).toBeNull()
    expect(w.rpc.calls.find(c => c.method === 'endAskWait')!.args).toEqual([idOf(r), false])
  })
})

describe('permissions: a covering grant runs through the hold; a spent day gives an exact card (failure 2)', () => {
  const grant = async (perDay = 50) => {
    const id = `pg_${fresh('g').replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'A').slice(0, 22)}`
    await insertGrant(db, {
      id, holder: `member:${ASKER}`, accountId: 'shopify:store', accountGen: SHOP_GEN, operation: 'shopify.order.tag_add', scopeKey: 'shop=store-a',
      perDay, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
    })
    return id
  }

  it('approved under the grant at once; after the 10 s hold it is sent and the result comes back', async () => {
    const g = await grant()
    const w = setup()
    let sent = false
    w.onSleep = async now => {
      const row = await db.prepare("SELECT id, send_at_ms FROM outbox_actions WHERE state = 'approved'").first<{ id: string; send_at_ms: number }>()
      if (row && !sent && now >= row.send_at_ms) {
        await send(row.id, now)
        sent = true
      }
    }
    const r = await call(w)
    expect(text(r)).toBe(`${ACTION_WORDS.sent('vip')} (approval_id: ${idOf(r)})`)
    expect(await rowOf(db, idOf(r))).toMatchObject({ state: 'sent', verdict: 'run', grant_id: g, report: 'tool' })
  })

  it('approved, but not final within its 30 s: "Approved. It\'s being sent." and the report handed on', async () => {
    await grant()
    const w = setup()
    const r = await call(w)
    expect(text(r)).toBe(`${ACTION_WORDS.approved} (approval_id: ${idOf(r)})`)
    expect(await rowOf(db, idOf(r))).toMatchObject({ state: 'approved', report: 'later' })
    expect(w.clock.now - T0).toBe(WAIT_MAX_MS)
  })

  it('a grant whose day is spent: an exact card with guardrail count, never run, never a plain ask', async () => {
    await grant(1)
    const first = setup()
    first.onSleep = async now => {
      const row = await db.prepare("SELECT id, send_at_ms FROM outbox_actions WHERE state = 'approved'").first<{ id: string; send_at_ms: number }>()
      if (row && now >= row.send_at_ms) await send(row.id, now)
    }
    await call(first, tagArgs(1, 'a'))
    const w = setup()
    const r = await call(w, tagArgs(2, 'b'))
    expect(await rowOf(db, idOf(r))).toMatchObject({ verdict: 'exact', guardrail: 'count', state: 'waiting', grant_id: null })
  })
})

describe('refusals write nothing (failure 3)', () => {
  it('an unknown tool is refused before admission', async () => {
    const w = setup()
    const r = await call(w, {}, 'shopify_order_delete')
    expect(r).toMatchObject({ isError: true, structuredContent: { error: 'unknown_operation' } })
    expect(text(r)).toBe(ACTION_WORDS.unknownTool)
    expect(methods(w.rpc)).toEqual([])
    expect(await count()).toBe(0)
  })

  it('a call admission refuses (a helper\'s, a hand-made one, other arguments, a fenced turn): refused, nothing written', async () => {
    for (const why of ['no_match', 'turn_not_live', 'paused', 'member_removed'] as const) {
      const w = setup()
      w.rpc.admitActionAnswer = { refused: why }
      const r = await call(w)
      expect(r, why).toMatchObject({ isError: true, structuredContent: { error: 'not_admitted' } })
      expect(methods(w.rpc), why).toEqual(['admitAction'])
    }
    expect(await count()).toBe(0)
  })

  it('the admission hashes the call\'s input as the runner does (the raw arguments\' canonical JSON)', async () => {
    const w = setup()
    w.rpc.admitActionAnswer = { refused: 'no_match' }
    await call(w, { tags: ['sale'], orderId: 'gid://shopify/Order/1042' })
    const { auditInputSha256 } = await import('../../shared/protocol/index.ts')
    expect(w.rpc.calls[0]!.args[2]).toBe(await auditInputSha256({ orderId: 'gid://shopify/Order/1042', tags: ['sale'] }))
  })

  it('the product\'s state (no operation on): refused over_ceiling, nothing written; tools/list is empty', async () => {
    await db.prepare('DELETE FROM permission_ceiling').run()
    const w = setup()
    const r = await call(w)
    expect(r).toMatchObject({ isError: true, structuredContent: { error: 'over_ceiling' } })
    expect(await count()).toBe(0)
    const list = await handleActions(new Request('http://egress.internal/actions/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), grantOf(w.turnId), w.deps)
    expect(await list.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
  })

  it('a paused or unreadable hub account is refused (account_unavailable), nothing written', async () => {
    for (const facts of [[], [{ accountId: 'shopify:store', paused: true, label: 'Shopify' }]]) {
      const w = setup()
      w.rpc.hubAccountsAnswer = facts
      expect(await call(w)).toMatchObject({ isError: true, structuredContent: { error: 'account_unavailable' } })
    }
    expect(await count()).toBe(0)
  })
})

describe('who waits (failure 4)', () => {
  it('a fourth parallel ask doesn\'t wait: answered at once, the report handed on', async () => {
    const w = setup()
    w.rpc.askWaitAnswer = { wait: false, why: 'busy' }
    const r = await call(w)
    expect(text(r)).toBe(`Waiting for the person's OK. It's in Approvals. ${ACTION_WORDS.busyNote} (approval_id: ${idOf(r)})`)
    expect(w.clock.now).toBe(T0)
    expect(await rowOf(db, idOf(r))).toMatchObject({ state: 'waiting', report: 'later' })
    expect(methods(w.rpc)).not.toContain('endAskWait')
  })

  it('a job\'s turn never waits (and never asks to)', async () => {
    const w = setup({ jobId: 'j_m2d' })
    const r = await call(w)
    expect(text(r)).toBe(`Waiting for the person's OK. It's in Approvals. ${ACTION_WORDS.laterNote} (approval_id: ${idOf(r)})`)
    expect(w.clock.now).toBe(T0)
    expect(methods(w.rpc)).not.toContain('beginAskWait')
    expect(await rowOf(db, idOf(r))).toMatchObject({ origin: 'job', job_id: 'j_m2d', report: 'later' })
  })

  it('a system routine\'s turn has no one to ask: refused', async () => {
    const w = setup({ ownerId: 'm_system' })
    expect(await call(w)).toMatchObject({ isError: true, structuredContent: { error: 'no_one_to_ask' } })
    expect(await count()).toBe(0)
  })
})

describe('the route (failure 5)', () => {
  const post = (w: World, body: unknown, headers: Record<string, string> = {}) => handleActions(new Request('http://egress.internal/actions/', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), grantOf(w.turnId), w.deps)

  it('lists each enabled operation as a write tool with its strict schema; initialize names the server', async () => {
    const w = setup()
    const list = (await (await post(w, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as { result: { tools: { name: string; annotations: Record<string, boolean>; inputSchema: { additionalProperties?: boolean } }[] } }
    expect(list.result.tools.map(t => t.name)).toEqual(['shopify_order_tag_add'])
    expect(list.result.tools[0]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true })
    expect(list.result.tools[0]!.inputSchema.additionalProperties).toBe(false)
    const init = (await (await post(w, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25' } })).json()) as { result: { serverInfo: unknown } }
    expect(init.result.serverInfo).toEqual({ name: 'actions', version: '1.0.0' })
  })

  it('refuses an Origin, a batch, a GET and another path before anything is read', async () => {
    const w = setup()
    expect((await post(w, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(w, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status).toBe(400)
    expect((await handleActions(new Request('http://egress.internal/actions/', { method: 'GET' }), grantOf(w.turnId), w.deps)).status).toBe(405)
    expect((await handleActions(new Request('http://egress.internal/actions/x', { method: 'POST' }), grantOf(w.turnId), w.deps)).status).toBe(404)
    expect(methods(w.rpc)).toEqual([])
  })

  it('a sent answer carries the safe ref only; the request id and the body\'s ids are never trusted', async () => {
    const w = setup()
    w.onSleep = async now => {
      const row = await db.prepare("SELECT * FROM outbox_actions WHERE state IN ('waiting', 'approved') ORDER BY created_at_ms DESC LIMIT 1").first<{ id: string; rev: number; state: string; send_at_ms: number | null }>()
      if (row?.state === 'waiting') await outbox(db, () => now).answer({ memberId: ASKER, role: 'member' }, row.id, { choice: 'once', ifRev: row.rev })
      else if (row?.state === 'approved' && now >= row.send_at_ms!) await send(row.id, now)
    }
    const res = await post(w, { jsonrpc: '2.0', id: 'x', method: 'tools/call', params: { name: 'shopify_order_tag_add', arguments: tagArgs(7, 'vip'), toolUseId: 'toolu_forged', chatId: 'c_forged' } })
    const body = (await res.json()) as { id: string; result: { content: { text: string }[]; structuredContent: { approval_id: string } } }
    expect(body.id).toBe('x')
    expect(body.result.content[0]!.text).toBe(`Done. It went out: vip. (approval_id: ${body.result.structuredContent.approval_id})`)
    const row = (await rowOf(db, body.result.structuredContent.approval_id))!
    expect(row.chat_id).toBe(CHAT)
    expect(row.tool_use_id).not.toBe('toolu_forged')
  })
})
