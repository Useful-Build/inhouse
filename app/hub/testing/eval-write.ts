// EvalWriteGateway (Stage 1 M3-R, N30; Q3 = D): the eval deployment's write entrypoint. The eval product Worker binds
// HUB_WRITE to it (app/wrangler.eval.jsonc), so the paid write-injection run's approved writes land here and nowhere
// else. It holds no credential and makes no outside request: it parses the request as WriteGateway does, writes it to
// `eval_write_log` (migration 0780) on the D1 the eval hub binds as EVAL_WRITE_LOG, and answers it, `sent` or the fault
// the eval door set for that operation (`eval_write_fault`: refuse, unknown or throttle).
//
// Rules:
// - Only the hub's TEST build exports it (hub/testing/entry/index.ts, wrangler.hub.test.jsonc's `main`). The deployable
//   bundle (wrangler.hub.jsonc, main hub/index/index.ts) never reaches this file: scripts/check-hub-build.mjs fails a
//   deployable bundle that names EvalWriteGateway, and requires the name in the test bundle.
// - Only the eval deployment binds it: scripts/check-product-config.mjs allows HUB_WRITE -> EvalWriteGateway in the
//   eval product config alone (the product, per-PR and candidate configs bind HUB_WRITE -> WriteGateway or nothing), and
//   the EVAL_WRITE_LOG D1 in the eval hub config alone. A hub without that D1 answers `not_configured`, writing nothing.
// - Imports: the contract's types and its request schema only (eval-write.test.ts reads this file: no outside request,
//   no other binding, no credential name). Written with `.js` so the server tests can import this file too (the app's
//   node16 resolution needs an extension, the hub's bundler resolution refuses `.ts`; both map `.js` to the source). The
//   error texts are index/errors.ts's, copied (that module's own imports don't resolve in the app); a test pins them.
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { HubError, HubErrorCode, WriteGateway as WriteApi, WriteOperationKey, WriteRequest, WriteResult } from '../index/contract.js'
import { WriteRequestSchema } from '../index/schemas.js'

/** The one binding this gateway reads: the eval deployment's own D1 (scripts/check-product-config.mjs EVAL_WRITE_LOG_BINDING). */
export interface EvalWriteEnv {
  EVAL_WRITE_LOG?: D1Database
}

export type EvalWriteFault = 'refuse' | 'unknown' | 'throttle'

/** index/errors.ts's `hubError` for the codes this gateway answers (eval-write.test.ts pins each equal). */
export const EVAL_ERROR_TEXT = {
  not_configured: 'connector not configured',
  invalid_args: 'invalid arguments',
  upstream_rejected: 'upstream rejected the request',
  upstream_unavailable: 'upstream unavailable',
  rate_limited: 'rate limited by the upstream',
  internal: 'internal error',
} as const satisfies Partial<Record<HubErrorCode, string>>
type EvalErrorCode = keyof typeof EVAL_ERROR_TEXT
export function hubError(code: EvalErrorCode, detail?: string, retryAfterMs?: number): HubError {
  const error: HubError = { code, message: detail ? `${EVAL_ERROR_TEXT[code]}: ${detail}` : EVAL_ERROR_TEXT[code] }
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs
  return error
}

/** The ref a logged write answers with: the log row's number. Safe (no argument value). */
export const evalWriteRef = (n: number): string => `eval-write:${n}`

/** One fault's answer. Every fault is a definite `no` but `unknown`, which is an unclear answer. */
function faultResult(fault: EvalWriteFault, retryAfterMs: number | null): WriteResult {
  switch (fault) {
    case 'refuse': return { ok: false, error: hubError('upstream_rejected', 'eval_fault'), sent: 'no' }
    case 'unknown': return { ok: false, error: hubError('upstream_unavailable', 'eval_fault'), sent: 'unknown' }
    case 'throttle': return { ok: false, error: hubError('rate_limited', 'eval_fault', retryAfterMs ?? undefined), sent: 'no' }
  }
}

/**
 * Logs one write request on `db` at `nowMs` and answers it. A request the contract's schema refuses is `invalid_args`
 * and isn't logged (the real gateway refuses it the same way, so nothing would have gone out). With no database bound,
 * `not_configured` and nothing written.
 */
export async function evalWrite(db: D1Database | undefined, raw: unknown, nowMs: number): Promise<WriteResult> {
  if (!db) return { ok: false, error: hubError('not_configured', 'eval_write_log'), sent: 'no' }
  const parsed = WriteRequestSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: hubError('invalid_args', 'request'), sent: 'no' }
  const req: WriteRequest = parsed.data
  const operation: WriteOperationKey = req.operation
  // One statement takes the operation's fault, if one is left: two requests never play the same last one.
  const fault = await db
    .prepare('UPDATE eval_write_fault SET remaining = remaining - 1 WHERE operation = ? AND remaining > 0 RETURNING fault, retry_after_ms')
    .bind(operation)
    .first<{ fault: EvalWriteFault; retry_after_ms: number | null }>()
  const outcome = fault?.fault ?? 'sent'
  const row = await db
    .prepare(
      `INSERT INTO eval_write_log (at_ms, action_id, attempt, request_id, account_id, operation, args_json, expect_json, item_n, item_of, idempotency_key, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING n`,
    )
    .bind(
      nowMs, req.actionId, req.attempt, req.requestId, req.accountId, operation, JSON.stringify(req.args ?? null), JSON.stringify(req.expect),
      req.item?.n ?? null, req.item?.of ?? null, req.idempotencyKey ?? null, outcome,
    )
    .first<{ n: number }>()
  if (!row) throw new Error('eval_write_log: the insert returned no row')
  return fault ? faultResult(fault.fault, fault.retry_after_ms) : { ok: true, value: { ref: evalWriteRef(row.n) } }
}

export class EvalWriteGateway extends WorkerEntrypoint<EvalWriteEnv> implements WriteApi {
  async runAction(req: WriteRequest): Promise<WriteResult> {
    try {
      return await evalWrite(this.env.EVAL_WRITE_LOG, req, Date.now())
    } catch {
      // As WriteGateway: an unexpected failure is `internal`, and whether the log took the row is unknown.
      return { ok: false, error: hubError('internal'), sent: 'unknown' }
    }
  }
}
