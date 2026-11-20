// The hub's main module (wrangler.hub.jsonc `main`). Hub PR0's skeleton: the default export answers every request with
// 404, so the Worker has no HTTP surface. H0 replaces this file with the ReadGateway and ServerGateway entrypoints.
//
// The test upstream seam (hub/testing/) is reached only inside the guarded branch below. `__INHOUSE_HUB_TEST__` is a
// wrangler `define`: "false" in wrangler.hub.jsonc, so esbuild drops the branch and its dynamic import from the
// deployable bundle; "true" only in wrangler.hub.test.jsonc. scripts/check-hub-build.mjs proves both. Declared in
// hub/globals.d.ts.
export { SignIn } from '../signin/signin'

const notFound = (): Response =>
  new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

export default {
  async fetch(_request, env): Promise<Response> {
    if (__INHOUSE_HUB_TEST__ && (env as { INHOUSE_TEST_BUILD?: string }).INHOUSE_TEST_BUILD === '1') {
      // PR0 placeholder: loads the seam so the test bundle carries it and the bundle scan has something to catch.
      // H0 replaces this with the upstream fetch the SignIn object uses. The answer stays 404 either way.
      await import('../testing/index')
    }
    return notFound()
  },
} satisfies ExportedHandler<Env>
