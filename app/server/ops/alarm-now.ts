// Route 67, `POST /api/ops/alarm`, the TEST BUILD's alarm-now control (P4 wave 4, p4-w6.md OC 2): runs one pass of
// the BrandAgent's due-task scheduler now, as its alarm would, so a spec can drive a routine slot without waiting on the
// runtime's alarm. Release token only (the access matrix). Only when the test build is compiled in
// (`__INHOUSE_TEST_BUILD__`, `false` in the product build, so the branch is never reachable there) AND switched on
// (`INHOUSE_TEST_BUILD === '1'`), the pattern of the undrain (drain.ts). Anywhere else: 404, as if the route weren't
// there. The object's method runs `@test-controls`, which is the off module outside the test build.
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { brandAgent } from '../do/brand-agent/client.ts'

declare const __INHOUSE_TEST_BUILD__: boolean

/** The flag is a parameter so the unit tests can stand in for each build mode (vitest compiles it `false`). */
export function alarmNowHandler(compiledTestBuild: boolean = __INHOUSE_TEST_BUILD__): Handler {
  return async c => {
    const on = compiledTestBuild && (c.env as { INHOUSE_TEST_BUILD?: unknown }).INHOUSE_TEST_BUILD === '1'
    if (!on) return apiError('not_found')
    return apiJson(await brandAgent(c.env).testRunAlarm())
  }
}
export const alarmNow: Handler = alarmNowHandler()
