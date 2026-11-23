// Route 67, `POST /api/ops/alarm`, the TEST BUILD's alarm-now control (P4 wave 4, p4-w6.md OC 2): runs one pass of
// the BrandAgent's due-task scheduler now, as its alarm would, so a spec can drive a routine slot without waiting on the
// runtime's alarm. Release token only (the access matrix). Only when the test build is compiled in
// (`__INHOUSE_TEST_BUILD__`, `false` in the product build, so the branch is never reachable there) AND switched on
// (`INHOUSE_TEST_BUILD === '1'`), the pattern of the undrain (drain.ts). Anywhere else: 404, as if the route weren't
// there. The object's method runs `@test-controls`, which is the off module outside the test build.
// The body picks the control (p4-w6.md section 3), each run on the BrandAgent so its state sits where the tick runs:
//   none, `{}` or `{ action: 'alarm', pokeTick?: true }`: one scheduler pass (with `pokeTick`, the routine tick made due
//     first) -> `{ ran: true }`;
//   `{ action: 'stopAfterBatch' }`: the next routine tick pass throws right after its decide batches commit, once ->
//     `{ armed: true }`;
//   `{ action: 'seedCursor', routineId, checkedUntilMs }`: a live routine's `checked_until_ms`, a past instant ->
//     `{ seeded: true }`, or 404 `not_found` with reason `routine` when no live routine has that id.
import { z } from 'zod'
import { RoutineIdSchema } from '../../shared/contract/audit.ts'
import { MAX_BODY_BYTES, readCapped } from '../db/handler-kit.ts'
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { brandAgent } from '../do/brand-agent/client.ts'

declare const __INHOUSE_TEST_BUILD__: boolean

const ControlSchema = z.union([
  z.strictObject({ action: z.literal('alarm').optional(), pokeTick: z.literal(true).optional() }),
  z.strictObject({ action: z.literal('stopAfterBatch') }),
  z.strictObject({ action: z.literal('seedCursor'), routineId: RoutineIdSchema, checkedUntilMs: z.number().int().nonnegative() }),
])

/** The control the body names; no body, or an empty or whitespace-only one, is the plain alarm. `null` when invalid. */
async function readControl(request: Request): Promise<z.infer<typeof ControlSchema> | null> {
  if (request.body === null) return {}
  const bytes = await readCapped(request, MAX_BODY_BYTES)
  if (bytes === null) return null
  let json: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.trim() === '') return {}
    json = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = ControlSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** The flag is a parameter so the unit tests can stand in for each build mode (vitest compiles it `false`). */
export function alarmNowHandler(compiledTestBuild: boolean = __INHOUSE_TEST_BUILD__): Handler {
  return async c => {
    const on = compiledTestBuild && (c.env as { INHOUSE_TEST_BUILD?: unknown }).INHOUSE_TEST_BUILD === '1'
    if (!on) return apiError('not_found')
    const body = await readControl(c.request)
    if (body === null) return apiError('invalid')
    const agent = brandAgent(c.env)
    if (body.action === 'stopAfterBatch') return apiJson(await agent.testStopAfterBatch())
    if (body.action === 'seedCursor') {
      if (body.checkedUntilMs >= c.nowMs) return apiError('invalid', { reason: 'not_past' })
      const { seeded } = await agent.testSeedCursor(body.routineId, body.checkedUntilMs)
      return seeded ? apiJson({ seeded: true }) : apiError('not_found', { reason: 'routine' })
    }
    return apiJson(await agent.testRunAlarm({ pokeTick: body.pokeTick === true }))
  }
}
export const alarmNow: Handler = alarmNowHandler()
