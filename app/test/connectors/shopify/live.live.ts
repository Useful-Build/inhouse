// The nightly connector check against the read fixture store (brief section 8). Runs only from a trusted workflow
// with the store's secret, never in ci.yml:
//   SHOPIFY_SHOP=… SHOPIFY_CLIENT_ID=… SHOPIFY_CLIENT_SECRET=… npm --prefix app/hub run test:live -- live
// A missing variable fails the run. Prints case names and outcomes only.
import { expect, test } from 'vitest'
import { loadCommittedFixture, runLive } from './live-run'

test('shopify live', { timeout: 300_000 }, async () => {
  const { failures } = await runLive(process.env, { upstream: req => fetch(req), committed: await loadCommittedFixture() })
  expect(failures).toEqual([])
})
