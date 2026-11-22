// Route 76, `POST /api/ops/test-fakes`, the TEST BUILD's hook for W5's API specs: reads and flips the fake upstreams,
// fires the hub's SignIn alarm, flips a hub var, sends a system notice, calls notification_send as a named member and
// the hub's ReadGateway as a run, reads the turn's system prompt and the captured logs (server/ops/test-fakes.ts has
// the ops). Gated exactly as route 67 (alarm-now.ts): release token only (the access matrix), and only when the test
// build is compiled in AND switched on (`INHOUSE_TEST_BUILD === '1'`); the eval build is excluded too, since it's
// deployed (`__INHOUSE_EVAL_BUILD__`). Anywhere else: 404, as if the route weren't there. The ops run here, in the
// Worker request, through `@test-fakes`, which is the off module outside the test build. Not in the BrandAgent: its
// service-binding calls to the hub kept the local object from hibernating, so a closed member's socket never saw its
// TCP close (e2e/api/socket.spec.ts). The Worker's env is the object's (one script); the handler's env lacks DB and
// FILES (stores only), so runTestFakesInWorker, test-build-only, takes those two from the Worker's own env.
import { readCapped } from '../db/handler-kit.ts'
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { runTestFakesInWorker } from '@test-fakes'

declare const __INHOUSE_TEST_BUILD__: boolean
declare const __INHOUSE_EVAL_BUILD__: boolean

/** The largest body the hook reads. */
const MAX_BODY_BYTES = 256 * 1024

/** Whether a build with these two defines compiles the hook in: the test build only, never the (deployed) eval build. */
export const compiledIn = (testBuild: boolean, evalBuild: boolean): boolean => testBuild && !evalBuild

/** The flag is a parameter so the unit tests can stand in for each build mode (vitest compiles both defines `false`). */
export function testFakesHandler(compiledTestBuild: boolean = compiledIn(__INHOUSE_TEST_BUILD__, __INHOUSE_EVAL_BUILD__)): Handler {
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
    const answer = await runTestFakesInWorker(body, c.env)
    return apiJson(answer.body, answer.status)
  }
}
export const testFakes: Handler = testFakesHandler()
