// Route 76, `POST /api/ops/test-fakes`, the TEST BUILD's hook for W5's API specs: reads and flips the fake upstreams,
// fires the hub's SignIn alarm, flips a hub var, sends a system notice, calls notification_send as a named member and
// the hub's ReadGateway as a run, reads the turn's system prompt and the captured logs (server/ops/test-fakes.ts has
// the ops). Gated exactly as route 67 (alarm-now.ts): release token only (the access matrix), and only when the test
// build is compiled in AND switched on (`INHOUSE_TEST_BUILD === '1'`); the eval build is excluded too, since it's
// deployed (`__INHOUSE_EVAL_BUILD__`). Anywhere else: 404, as if the route weren't there. The ops run in the
// BrandAgent through `@test-fakes`, which is the off module outside the test build.
import { readCapped } from '../db/handler-kit.ts'
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { brandAgent } from '../do/brand-agent/client.ts'

declare const __INHOUSE_TEST_BUILD__: boolean
declare const __INHOUSE_EVAL_BUILD__: boolean

/** The largest body the hook reads. */
const MAX_BODY_BYTES = 256 * 1024

/** The flag is a parameter so the unit tests can stand in for each build mode (vitest compiles both defines `false`). */
export function testFakesHandler(compiledTestBuild: boolean = __INHOUSE_TEST_BUILD__ && !__INHOUSE_EVAL_BUILD__): Handler {
  return async c => {
    const on = compiledTestBuild && (c.env as { INHOUSE_TEST_BUILD?: unknown }).INHOUSE_TEST_BUILD === '1'
    if (!on) return apiError('not_found')
    const bytes = await readCapped(c.request, MAX_BODY_BYTES)
    if (bytes === null) return apiJson({ error: { code: 'invalid', detail: 'body too large' } }, 400)
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      return apiJson({ error: { code: 'invalid', detail: 'the body is not JSON' } }, 400)
    }
    const answer = await brandAgent(c.env).testFakes(body)
    return apiJson(JSON.parse(answer.json), answer.status)
  }
}
export const testFakes: Handler = testFakesHandler()
