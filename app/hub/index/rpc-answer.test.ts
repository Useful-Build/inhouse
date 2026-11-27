// Every ConnectGateway, DeliveryGateway and WriteGateway path answers plain data and releases the SignIn object's
// answer. Workers RPC gives each object an RPC returns a disposer
// (https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/, read 2026-11-26), and a method that returns
// such an answer as is keeps its call open until the caller disposes it: a gateway that passed a SignIn answer on kept
// the product's call open, and BrandAgent then never went idle. Ways it can fail:
//  1. a method returns the SignIn answer itself (it still carries the disposer);
//  2. a method builds its own answer but never releases the SignIn's;
//  3. the copy changes what the method answered.
// The stubs here hand answers over as Workers RPC does: the data plus a counted disposer.
import { describe, expect, it } from 'vitest'
import * as G from '../oauth/gateway'
import { connectDeps, MEMBER, SERVER, SLACK, world } from '../oauth/testing/kit'
import { checkChannel, listChannels, postNotice, type DeliveryDeps } from '../connectors/slack/gateway'
import { postSlackOutboxAction } from '../connectors/slack/outbox'
import { connectSlack, deliveryWorld } from '../connectors/slack/testing/kit'
import { shopifyWriteVia } from '../outbox-entry/gateway'

const DISPOSE = (Symbol as unknown as { dispose: symbol }).dispose

type Ledger = { handed: number; released: number }

/** The stub with each method's answer handed over as Workers RPC does: with a disposer, counted in `ledger`. */
function overRpc<T extends object>(stub: T, ledger: Ledger): T {
  return new Proxy(stub, {
    get(target, key) {
      const v = Reflect.get(target, key) as unknown
      if (typeof v !== 'function') return v
      return async (...args: unknown[]) => {
        const answer = (await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)) as object
        ledger.handed++
        let done = false
        return Object.assign({}, answer, { [DISPOSE]: () => { if (!done) { done = true; ledger.released++ } } })
      }
    },
  })
}

/** No disposer anywhere in the answer, and every SignIn answer it read was released. */
function expectPlain(r: unknown, ledger: Ledger): void {
  const seen: unknown[] = [r]
  while (seen.length > 0) {
    const v = seen.pop()
    if (typeof v !== 'object' || v === null) continue
    expect(Object.getOwnPropertySymbols(v)).toEqual([])
    seen.push(...Object.values(v))
  }
  expect(ledger.handed).toBeGreaterThan(0)
  expect(ledger.released).toBe(ledger.handed)
}

describe('ConnectGateway answers plain data and releases every SignIn answer', () => {
  const setup = () => {
    const w = world()
    const ledger: Ledger = { handed: 0, released: 0 }
    const base = connectDeps(w)
    const d: G.ConnectDeps = { ...base, signIn: id => overRpc(base.signIn(id), ledger) }
    const plain: G.ConnectDeps = base
    return { d, plain, ledger }
  }
  const stateOf = (r: Awaited<ReturnType<typeof G.startConnect>>) => {
    if (!r.ok) throw new Error(r.error.code)
    return new URL(r.value.authorizeUrl).searchParams.get('state')!
  }

  it('startConnect', async () => {
    const { d, ledger } = setup()
    const r = await G.startConnect(d, SERVER, { accountId: SLACK, memberId: MEMBER })
    expect(r.ok).toBe(true)
    expectPlain(r, ledger)
  })

  it('completeConnect (the SignIn answer, passed on before the fix)', async () => {
    const { d, plain, ledger } = setup()
    const state = stateOf(await G.startConnect(plain, SERVER, { accountId: SLACK, memberId: MEMBER }))
    const r = await G.completeConnect(d, SERVER, { state, code: 'not-a-real-code', memberId: MEMBER })
    expect(r.ok).toBe(false)
    expectPlain(r, ledger)
  })

  it('failConnect (the SignIn answer, passed on before the fix)', async () => {
    const { d, plain, ledger } = setup()
    const state = stateOf(await G.startConnect(plain, SERVER, { accountId: SLACK, memberId: MEMBER }))
    const r = await G.failConnect(d, SERVER, { state, memberId: MEMBER, error: 'access_denied' })
    expect(r).toEqual({ ok: true, value: { accountId: SLACK } })
    expectPlain(r, ledger)
  })

  it('disconnect', async () => {
    const { d, ledger } = setup()
    const r = await G.disconnect(d, SERVER, SLACK)
    expectPlain(r, ledger)
  })

  it('setPaused (the SignIn answer, passed on before the fix)', async () => {
    const { d, ledger } = setup()
    const r = await G.setPaused(d, SERVER, SLACK, true)
    expect(r).toEqual({ ok: true, value: { paused: true } })
    expectPlain(r, ledger)
  })

  it('listAccounts, read whole and when a status read fails (passed on before the fix)', async () => {
    const { d, ledger } = setup()
    const rows = await G.listAccounts(d, SERVER)
    expect(rows.ok && rows.value.length).toBe(2)
    expectPlain(rows, ledger)

    const failing: Ledger = { handed: 0, released: 0 }
    const down = { ok: false, error: { code: 'internal', message: 'internal error' } } as const
    const broken: G.ConnectDeps = { ...d, signIn: id => overRpc({ ...d.signIn(id), status: async () => down }, failing) }
    const r = await G.listAccounts(broken, SERVER)
    expect(r).toEqual(down)
    expectPlain(r, failing)
  })
})

describe('DeliveryGateway answers plain data and releases every SignIn answer', () => {
  const setup = async () => {
    const w = deliveryWorld()
    await connectSlack(w)
    const ledger: Ledger = { handed: 0, released: 0 }
    const d: DeliveryDeps = { signIn: () => overRpc(w.stub, ledger) }
    return { d, ledger }
  }

  it('postNotice (the SignIn answer, passed on before the fix)', async () => {
    const { d, ledger } = await setup()
    const r = await postNotice(d, SERVER, { accountId: SLACK, noticeId: 'n_AAAAAAAAAAAAAAAAAAAAAA', channelId: 'C0TEST0001', title: 'T', text: 'x' })
    expect(r.ok).toBe(true)
    expectPlain(r, ledger)
  })

  it('listChannels (the SignIn answer, passed on before the fix)', async () => {
    const { d, ledger } = await setup()
    const r = await listChannels(d, SERVER, { accountId: SLACK })
    expect(r.ok).toBe(true)
    expectPlain(r, ledger)
  })

  it('checkChannel (the SignIn answer, passed on before the fix)', async () => {
    const { d, ledger } = await setup()
    const r = await checkChannel(d, SERVER, { accountId: SLACK, channelId: 'C0TEST0003' })
    expect(r).toEqual({ ok: true, value: { id: 'C0TEST0003', name: 'partner-shared', isMember: true, shared: true, archived: false, private: false } })
    expectPlain(r, ledger)
  })
})

describe('WriteGateway answers plain data and releases every SignIn answer', () => {
  it('the Slack outbox post: status, channel check, status again and the post, each released', async () => {
    const w = deliveryWorld()
    await connectSlack(w)
    const status = await w.core.accountStatus(SLACK)
    if (!status.ok || !status.value.connectedAt) throw new Error('expected a connected Slack account')
    const ledger: Ledger = { handed: 0, released: 0 }
    const stub = overRpc({
      status: (id: string) => w.core.accountStatus(id),
      slackChannelInfo: (id: string, ch: string) => w.core.slackChannelInfo(id, ch),
      slackPost: w.stub.slackPost,
    }, ledger)
    const r = await postSlackOutboxAction(stub, { accountId: SLACK, expect: { connectedAtMs: status.value.connectedAt.ms }, args: { channelId: 'C0TEST0001', text: 'x' } })
    expect(r).toMatchObject({ ok: true, value: { ref: expect.stringMatching(/^#ops-alerts \(\d+\.\d+\)$/) } })
    expect(ledger.handed).toBe(4)
    expectPlain(r, ledger)
  })

  it('the Slack outbox post refused at the channel check (its error read from the SignIn answer)', async () => {
    const w = deliveryWorld()
    await connectSlack(w)
    const status = await w.core.accountStatus(SLACK)
    if (!status.ok || !status.value.connectedAt) throw new Error('expected a connected Slack account')
    const ledger: Ledger = { handed: 0, released: 0 }
    const stub = overRpc({
      status: (id: string) => w.core.accountStatus(id),
      slackChannelInfo: async () => ({ ok: false as const, error: { code: 'upstream_rejected' as const, message: 'no' } }),
      slackPost: w.stub.slackPost,
    }, ledger)
    const r = await postSlackOutboxAction(stub, { accountId: SLACK, expect: { connectedAtMs: status.value.connectedAt.ms }, args: { channelId: 'C0TEST0001', text: 'x' } })
    expect(r).toEqual({ ok: false, error: { code: 'upstream_rejected', message: 'no' }, sent: 'no' })
    expectPlain(r, ledger)
  })

  it("the test build's Shopify tag add (the SignIn answer, passed on before the fix)", async () => {
    const ledger: Ledger = { handed: 0, released: 0 }
    const stub = overRpc({ runWrite: async () => ({ ok: true as const, value: { ref: 'order 9001' } }) }, ledger)
    const r = await shopifyWriteVia(stub, { operation: 'shopify.order.tag_add', accountId: 'shopify:store', expect: { connectedAtMs: 1 }, args: {} })
    expect(r).toEqual({ ok: true, value: { ref: 'order 9001' } })
    expectPlain(r, ledger)
  })
})
