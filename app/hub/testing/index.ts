// The test upstream seam (orchestrator only). Recorded upstreams register here by host; the hub's test build sends its
// upstream requests through testUpstreamFetch instead of the network.
//
// Rules:
// - Imported only inside the guarded branch `if (__INHOUSE_HUB_TEST__ && env.INHOUSE_TEST_BUILD === '1')` with a
//   dynamic import. The deployable config defines __INHOUSE_HUB_TEST__ as "false", so esbuild drops this module and
//   everything it imports. scripts/check-hub-build.mjs fails a deployable bundle that carries HUB_TEST_CANARY or any
//   module from hub/testing/ or test/upstreams/, and fails unless it finds the canary in the test bundle.
// - Code bundled into the hub from outside app/hub/ (the recorded upstreams under app/test/upstreams/) imports no npm
//   package: the hub's CI job installs only app/hub/node_modules, and esbuild resolves a bare import from the
//   importing file's directory upward, so app/test/ can't see the hub's packages. Relative imports and the
//   runtime's globals only.
// - An unregistered host answers 599 with a clear message. Never a real fetch.

import { createShopifyUpstream } from '../../test/upstreams/shopify/server'
import { MORNING_CHECK_UPSTREAMS } from '../../test/upstreams/morning-check/upstreams'
import { dataset as shopifyFixtureDataset } from '../../test/upstreams/shopify/recordings/fixture/dataset'
import { STORE_DATA_UPSTREAMS } from '../../test/upstreams/shopify/datasets/exfiltration/upstreams'

/** Found in the test bundle, never in the deployable one (the bundle scan looks for this exact value). */
export const HUB_TEST_CANARY = 'INHOUSE_HUB_TEST_CANARY_4b9e'

export type TestUpstream = (req: Request) => Promise<Response>

/** Recorded upstreams by host (for example `example-fixture.myshopify.com`). Registered by orchestrator lines below. */
export const testUpstreams = new Map<string, TestUpstream>()

// The recorded Shopify store (P4 W1): the read fixture as recorded (recordings/fixture/), for the test config's
// SHOPIFY_SHOP. Unit tests that need the planted edge cases use the hand dataset directly.
//
// P4 W6 (canary sweep, p4-w6.md section 4): the upstream answers 401 to its first GraphQL request, once per start of the hub, so the error path and the hub's refresh run before the sweep reads the logs. The hub then asks
// for a fresh token and carries on (Opus F13); a test of the hub's own that reads through this host sees only the final answer.
testUpstreams.set('example-fixture.myshopify.com', createShopifyUpstream(shopifyFixtureDataset, { faults: ['unauthorized-once'] }))

// The graded morning-check set (P4 W3): one invented shop per case (evals/morning-check/), each with its own dataset and
// fault. The runner points the product Worker's SHOPIFY_SHOP at a case's host.
for (const [host, upstream] of Object.entries(MORNING_CHECK_UPSTREAMS)) testUpstreams.set(host, upstream)

// The store-data exfiltration set (P4 W6): one invented shop per case, each with the instruction planted in a field the read
// tools return (evals/exfiltration/store-data/).
for (const [host, upstream] of Object.entries(STORE_DATA_UPSTREAMS)) testUpstreams.set(host, upstream)

export async function testUpstreamFetch(req: Request): Promise<Response> {
  const host = new URL(req.url).host
  const upstream = testUpstreams.get(host)
  if (!upstream) {
    return new Response(`hub test build: no recorded upstream for host "${host}" (register it in app/hub/testing/index.ts)`, {
      status: 599,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return upstream(req)
}
