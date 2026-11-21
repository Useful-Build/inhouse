// A.7.6's deadline case on workerd, alone in its file (P5 W2). A script awaiting a never-settling promise leaves its
// RPC into the Dynamic Worker pending after the hub's 20 s deadline answers; disposing the call and the entrypoint stub
// doesn't cancel it locally, and a `reset()` or any later test in the same file then crashes workerd ("Promise callback
// destroyed itself"). So this file holds exactly one test, with nothing after it.
import { env, reset } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { testUpstreams } from '../testing/index'
import { readyGatewayDeps } from '../signin/signin'
import type { HubResult } from '../index/contract'
import { RECORD_PRODUCTS } from '../connectors/shopify/documents'
import { createShopifyUpstream } from '../../test/upstreams/shopify/server'
import { dataset } from '../../test/upstreams/shopify/recordings/fixture/dataset'
import { createCodeMode } from './run'
import { codeModeConnector, shopifyScriptRun } from './route'

vi.setConfig({ testTimeout: 10_000 })

const HOST = 'example-fixture.myshopify.com'
const LOADER = (env as unknown as { LOADER: WorkerLoader }).LOADER

it('a never-settling promise ends at the deadline (injected timer)', async () => {
  await reset()
  let fire: () => void = () => {}
  const fired = new Promise<void>(resolve => {
    fire = resolve
  })
  // The deadline fires once the script has made its one call.
  const base = createShopifyUpstream(dataset)
  testUpstreams.set(HOST, async req => {
    const res = await base(req)
    if (new URL(req.url).pathname.endsWith('/graphql.json')) fire()
    return res
  })
  const codemode = createCodeMode({
    loader: LOADER,
    bumpCounter: async (k, l, t) =>
      (await env.SIGNIN.get(env.SIGNIN.idFromName(codeModeConnector.accountId)).bumpCounter(k, l, t)) as HubResult<{ ok: boolean; count: number }>,
    setTimer: (ms, fn) => {
      expect(ms).toBe(20_000)
      void fired.then(fn)
      return () => {}
    },
  })
  const deps = await readyGatewayDeps(env)
  const ctx = { shopify: deps.shopifyFor(codeModeConnector), scope: { kind: 'run' as const, runId: 'run-deadline', principalId: 'p-1', requestId: 'r-1' }, nowMs: Date.now(), codemode }
  const r = await shopifyScriptRun.run(ctx, { code: `await shop.graphql(${JSON.stringify(RECORD_PRODUCTS)}, { first: 1 }); await new Promise(() => {})` })
  testUpstreams.set(HOST, createShopifyUpstream(dataset))
  expect(r).toMatchObject({ ok: true, value: { error: expect.stringMatching(/ran past 20 s/), calls: 1 } })
})
