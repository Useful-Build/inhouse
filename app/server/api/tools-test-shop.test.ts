// #337 round 3 (M4, L6): route 70's account read (the graded runners' store check) and a turn's prompt resolve the same
// account. Ways it can fail: only one of the two carries the test shop override (the check would then pass on an account
// the turns don't use, or the reverse); the override rides in a build that isn't switched on; the wrapper drops the
// binding's own writes (pause, disconnect). Here, not beside test-shop.test.ts: the egress may not import the tools code.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountSummary, CallToolOptions, CallerScope, HubResult } from '../../hub/index/contract.ts'
import { reset } from '../db/test-support.ts'
import { TEST_SHOP_KEY, TEST_SHOP_OWNER } from '../egress/test-shop.ts'
import { turnPromptDeps } from '../prompt/connected.ts'
import { toolsDepsOf } from './tools.ts'

const HOST = 'example-mc-late-orders.myshopify.com'
const server: CallerScope = { kind: 'server', job: 'prompt.turn', requestId: 't_1' }
const setRow = (valueJson: string) =>
  env.DB.prepare('INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES (?, ?, ?, 1, 0, ?, ?)')
    .bind(TEST_SHOP_OWNER, TEST_SHOP_KEY, valueJson, 'eval', 'eval').run()

function recordingConnect() {
  const calls: (CallToolOptions | undefined)[] = []
  const gateway = {
    listAccounts: async (...a: [CallerScope, CallToolOptions?]) => {
      calls.push(a[1])
      return { ok: true, value: [] } satisfies HubResult<AccountSummary[]>
    },
  }
  return { gateway, calls }
}

beforeEach(async () => {
  await reset(env.DB)
})

describe('route 70 and the turn prompt read the same account', () => {
  // #337 round 3 (M4, L6): the Tools route's precheck and a turn's prompt resolve the same account. With the build switched on
  // and a row set, both reads reach HUB_CONNECT with the same override; with none, neither carries one. The writes (pause,
  // disconnect) are the binding's own.
  it('route 70\'s gateway and the turn prompt\'s deps both carry the override to HUB_CONNECT (the same account)', async () => {
    const { gateway, calls } = recordingConnect()
    const writes: string[] = []
    const hub = { ...gateway, setPaused: async () => { writes.push('setPaused'); return { ok: true, value: { paused: true } } }, disconnect: async () => { writes.push('disconnect'); return { ok: true, value: { revoked: true } } } }
    const envOn = { DB: env.DB, HUB_CONNECT: hub, INHOUSE_TEST_BUILD: '1' }
    await toolsDepsOf(envOn).listView.listAccounts(server)
    await turnPromptDeps(envOn).gateway!.listAccounts(server)
    await setRow(JSON.stringify(HOST))
    await toolsDepsOf(envOn).listView.listAccounts(server)
    await turnPromptDeps(envOn).gateway!.listAccounts(server)
    expect(calls).toEqual([undefined, undefined, { testShopHost: HOST }, { testShopHost: HOST }])
    // Pause and disconnect act on the hub's own accounts, and their "before" read is the binding's (#337 round 4).
    const binding = toolsDepsOf(envOn).gateway
    expect(binding).toBe(hub)
    await binding.listAccounts(server)
    expect(calls.at(-1), 'the binding\'s own read carries no override').toBeUndefined()
    await binding.setPaused(server, 'shopify:store', true)
    await binding.disconnect(server, 'shopify:store')
    expect(writes).toEqual(['setPaused', 'disconnect'])
    calls.pop()
    // A build that isn't switched on: neither read carries it, even with the row set.
    const envOff = { DB: env.DB, HUB_CONNECT: hub }
    await toolsDepsOf(envOff).listView.listAccounts(server)
    await turnPromptDeps(envOff).gateway!.listAccounts(server)
    expect(calls.slice(4)).toEqual([undefined, undefined])
  })

})
