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

/** Found in the test bundle, never in the deployable one (the bundle scan looks for this exact value). */
export const HUB_TEST_CANARY = 'INHOUSE_HUB_TEST_CANARY_4b9e'

export type TestUpstream = (req: Request) => Promise<Response>

/** Recorded upstreams by host (for example `example-fixture.myshopify.com`). Registered by orchestrator lines below. */
export const testUpstreams = new Map<string, TestUpstream>()

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
