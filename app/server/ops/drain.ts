// Drain for a deploy (P3, p3-design sections 3 and 7): routes 46 and 47, the `release` service token only. Owner: W2.
// The BrandAgent does the work in one synchronous step (pool.ts `drain`): nothing is admitted after it, and it undoes
// itself after 30 minutes. The release job polls route 47 until `live`, `starting` and `ending` are 0.
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { brandAgent } from '../do/brand-agent/client.ts'

/** Route 46, `POST /api/ops/drain`: the drain state after it. */
export const startDrain: Handler = async c => apiJson(await brandAgent(c.env).drain())
/** Route 47, `GET /api/ops/drain`: `{ live, starting, ending, queued, drainingUntilMs }`. */
export const drainState: Handler = async c => apiJson(await brandAgent(c.env).drainState())

declare const __INHOUSE_TEST_BUILD__: boolean

/**
 * `DELETE /api/ops/drain`, the TEST BUILD's undrain: the e2e drain case would otherwise leave the shared test-build brand
 * drained for 30 minutes (the test build has no containers, so warm-up can't clear it). Only when the test build is
 * compiled in (`__INHOUSE_TEST_BUILD__`, a build-time constant: the product bundle has this branch dead) AND switched on
 * (`INHOUSE_TEST_BUILD === '1'`), the pattern of the test issuer (auth/authenticate.ts). Anywhere else: 404, as if the
 * route weren't there (the access matrix still answers 403 to anyone but the release token).
 */
export function undrainHandler(compiledTestBuild: boolean = __INHOUSE_TEST_BUILD__): Handler {
  return async c => {
    const on = compiledTestBuild && (c.env as { INHOUSE_TEST_BUILD?: unknown }).INHOUSE_TEST_BUILD === '1'
    if (!on) return apiError('not_found')
    return apiJson(await brandAgent(c.env).undrain())
  }
}
export const undrain: Handler = undrainHandler()
