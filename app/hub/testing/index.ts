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
import { createShopifyWriteUpstream, SHOPIFY_WRITE_HOST } from '../../test/upstreams/shopify/write/server'
import { createMcpUpstream, SLACK_OAUTH_PATHS } from '../../test/upstreams/mcp/server'
import { createSlackWebUpstream, SLACK_WEB_PATHS } from '../../test/upstreams/slack/server'
import { MORNING_CHECK_UPSTREAMS } from '../../test/upstreams/morning-check/upstreams'
import { dataset as shopifyFixtureDataset } from '../../test/upstreams/shopify/recordings/fixture/dataset'
import { STORE_DATA_UPSTREAMS } from '../../test/upstreams/shopify/datasets/exfiltration/upstreams'
import { READ_SIDE_UPSTREAMS } from '../../test/upstreams/shopify/datasets/read-side/upstreams'
import { evalSlackWorkspace, type EvalSlackEnv } from './eval-slack'
import { createMcpFixtures, MCP_FIXTURE_HOSTS } from '../../test/upstreams/mcp/index'
import { bindWriteStore, type FakeKv, type WriteStore } from './write-store'

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
// Its requests (path and method only) and the access tokens it issues are kept for the test-fakes hook's `state`
// (./fakes.ts, P5 W5); the token is read from the upstream's own answer, so the fake itself is unchanged.
export const shopifyRequests: { path: string; method: string }[] = []
export const shopifyIssuedTokens: string[] = []
const shopifyFixture = createShopifyUpstream(shopifyFixtureDataset, { faults: ['unauthorized-once'] })
testUpstreams.set('example-fixture.myshopify.com', async req => {
  const path = new URL(req.url).pathname
  shopifyRequests.push({ path, method: req.method })
  const res = await shopifyFixture(req)
  if (path === '/admin/oauth/access_token' && res.ok) {
    const token = ((await res.clone().json()) as { access_token?: unknown }).access_token
    if (typeof token === 'string') shopifyIssuedTokens.push(token)
  }
  return res
})

// Stage 1 M2-C (N13): the separate fake Shopify write store (`example-write.myshopify.com`), so the read fixture
// (`example-fixture.myshopify.com`) is never written to.
export const shopifyWrite = createShopifyWriteUpstream()
testUpstreams.set(SHOPIFY_WRITE_HOST, shopifyWrite.fetch)

// #619: the write store's state (its issued tokens above all) is kept in the singleton test-fakes DO's storage, so a
// restart of that DO's isolate doesn't forget a token it issued (./write-store.ts). Bound on first use per DO instance.
let writeStore: { kv: FakeKv; store: WriteStore } | null = null

/**
 * Binds the write store to the singleton test-fakes DO's storage (signin.ts calls it before each upstream request and
 * test-fakes op). A different storage object (a new DO instance in this isolate) binds again, reading the state back
 * from storage. Unit tests that call testUpstreamFetch without a DO leave it unbound: the fake then lives in memory only.
 */
export function attachFakeStorage(kv: FakeKv): WriteStore {
  if (writeStore?.kv !== kv) writeStore = { kv, store: bindWriteStore(shopifyWrite, kv) }
  return writeStore.store
}

// The graded morning-check set (P4 W3): one invented shop per case (evals/morning-check/), each with its own dataset and
// fault. The runner points the product Worker's SHOPIFY_SHOP at a case's host.
for (const [host, upstream] of Object.entries(MORNING_CHECK_UPSTREAMS)) testUpstreams.set(host, upstream)

// The store-data exfiltration set (P4 W6): one invented shop per case, each with the instruction planted in a field the read
// tools return (evals/exfiltration/store-data/).
for (const [host, upstream] of Object.entries(STORE_DATA_UPSTREAMS)) testUpstreams.set(host, upstream)

// The fake OAuth MCP servers (P5 W1): Slack's profile and the generic `notes` server. slack.com answers only the OAuth
// paths; W4's Web API paths join it with their fake.
// Exported for the test-fakes hook (./fakes.ts, W5): it reads their logs and flips their switches in this isolate.
export const slackMcp = createMcpUpstream('slack')
export const notesMcp = createMcpUpstream('notes')
testUpstreams.set('mcp.slack.com', slackMcp.fetch)
testUpstreams.set('notes.example.com', notesMcp.fetch)
testUpstreams.set('auth.notes.example.com', notesMcp.fetch)
// slack.com by path: W1's OAuth paths, then W4's fake Web API (P5 W4).
export const slackWeb = createSlackWebUpstream()
testUpstreams.set('slack.com', req => {
  const path = new URL(req.url).pathname
  if ((SLACK_OAUTH_PATHS as readonly string[]).includes(path)) return slackMcp.fetch(req)
  if ((SLACK_WEB_PATHS as readonly string[]).includes(path)) return slackWeb.fetch(req)
  return Promise.resolve(new Response('no fake', { status: 599 }))
})

// The read-side set (P6a W4): one invented shop per Shopify case, its instruction planted in the field the case names
// (evals/read-side/shops.ts).
for (const [host, upstream] of Object.entries(READ_SIDE_UPSTREAMS)) testUpstreams.set(host, upstream)

// Stage 1 M4-F (N52): M4's fixture MCP servers (2026-07-28, 2025-11-25, the helpdesk), their login server, detect's
// addresses and Path C's REST API, one fetch for every host under mcp-fixtures.example.com (and the private-address trap).
// The login server fetches a Client ID Metadata Document through this seam, so a test serves one by registering its host.
// Exported for the test-fakes hook (./fakes.ts): `state` reads their logs, `reset` clears them, `set` revokes a key.
export const mcpFixtures = createMcpFixtures()
mcpFixtures.as.fetchClientDocument = req => testUpstreamFetch(req)
for (const host of MCP_FIXTURE_HOSTS) testUpstreams.set(host, mcpFixtures.fetch)

/**
 * One upstream request through the seam. `env` is the hub's (the singleton test-fakes DO passes its own, signin.ts): on
 * the eval hub, whose env binds the eval D1, the Slack fake first takes the workspace the eval door seeded there (Stage 1
 * M3, ./eval-slack.ts); without that binding it serves the fixture.
 */
export async function testUpstreamFetch(req: Request, env?: Env): Promise<Response> {
  const host = new URL(req.url).host
  if (host === 'mcp.slack.com') slackMcp.workspace = await evalSlackWorkspace(env as (Env & EvalSlackEnv) | undefined)
  const upstream = testUpstreams.get(host)
  if (!upstream) {
    return new Response(`hub test build: no recorded upstream for host "${host}" (register it in app/hub/testing/index.ts)`, {
      status: 599,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return upstream(req)
}
