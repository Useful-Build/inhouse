// The morning-check outage shops through ConnectGateway.listAccounts (the hub's test build on workerd). The graded run's
// store check reads route 70 after each case's shop is set (evals/shopify-served.ts), and route 70 and the turn's prompt
// both take the Shopify row from listAccounts with the case's test shop (entry.ts: the test shop's own SignIn object,
// granted first). Failure mode: an outage shop's fault stops that first grant, so the row has no connect date, route 70
// lists Shopify as not connected and the run stops before the case (the 2026-11-26 eval run stopped at outage-all).
// Every outage case must read as a connected store that's down: active, with a connect date, not paused.
import { reset } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountSummary, CallerScope, ConnectGateway, HubResult } from '../index/contract'
import { META, hostOf } from '../../evals/morning-check/expected'

const server: CallerScope = { kind: 'server', job: 'test', requestId: 'req-outage' }
const gateways = exports as unknown as { ConnectGateway: ConnectGateway }

beforeEach(async () => {
  await reset()
})

describe('listAccounts with a morning-check outage shop', () => {
  const outages = META.filter(c => c.group === 'outage')

  it('covers the three outage cases', () => {
    expect(outages.map(c => c.id)).toEqual(['outage-all', 'outage-credentials', 'outage-too-large'])
  })

  for (const c of outages) {
    it(`${c.id}: Shopify reads active with a connect date, so route 70 lists it connected and readable`, async () => {
      const r = (await gateways.ConnectGateway.listAccounts(server, { testShopHost: hostOf(c.id) })) as HubResult<AccountSummary[]>
      if (!r.ok) throw new Error(`${c.id}: ${r.error.code}`)
      const shopify = r.value.find(a => a.accountId === 'shopify:store')
      expect(shopify, c.id).toMatchObject({ configured: true, status: { state: 'active', paused: false, needsReconnect: false, lastError: null, connectedAt: { ms: expect.any(Number) } } })
    })
  }
})
