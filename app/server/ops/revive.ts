// Revive one quarantined due task (P3 W1 PR 6, A7): route 51, `POST /api/ops/tasks/revive { kind, id }`, the `release`
// service token only (class `open`, like drain: a runbook action, in the product build too). P4's and P6's runbooks
// point here: an exhausted routine or outbox task after its fix is deployed, a quarantined `deferred-hook:<questionId>`.
// The BrandAgent clears that one task's quarantine (attempts 0, due now, its payload kept byte for byte: `revive` in
// task-ops.ts); nothing else, never in bulk. Every call writes ONE audit line `ops_task_revive { kind, id, result }`.
import { z } from 'zod'
import { TaskIdSchema, TaskKindSchema } from '../../shared/contract/audit.ts'
import { apiError, apiJson } from '../http.ts'
import { readBody, storesOf } from '../db/handler-kit.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { taskHandlers } from '../do/brand-agent/tasks/index.ts'
import type { Handler } from '../routes.ts'

const ReviveBody = z.object({ kind: TaskKindSchema, id: TaskIdSchema }).strict()

/** Route 51: `{ result }`; an unregistered kind is 400 `invalid` (the object would refuse it) and writes no line. */
export const reviveTask: Handler = async c => {
  const body = await readBody(c.request, ReviveBody)
  if ('error' in body) return body.error
  const { kind, id } = body.ok
  if (!Object.hasOwn(taskHandlers, kind)) return apiError('invalid')
  const result = await brandAgent(c.env).revive({ kind, id })
  // The line follows the change: a failed write answers 5xx with the task revived (a retry answers `not_quarantined`
  // and writes its own line).
  await storesOf(c).chats.recordTaskRevive({ kind, id, result }, { nowMs: c.nowMs, requestId: c.requestId })
  return apiJson({ result })
}
