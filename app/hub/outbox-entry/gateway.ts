// WriteGateway's logic (Stage 1 M2-C, N13) as plain functions over injected deps so the Node project tests every path
// without workerd. entry.ts is the thin WorkerEntrypoint<Env> wrapper over this.
//
// The binding (`HUB_WRITE`) is the boundary: there is no caller-supplied scope to trust. Every request is checked by
// `WriteRequestSchema` strictly at run time; an unknown operation or malformed request is refused with `sent: 'no'`.
import { WRITE_OPERATIONS, type WriteRequest, type WriteResult } from '../index/contract'
import { hubError } from '../index/errors'
import { log } from '../index/log'
import { WriteRequestSchema } from '../index/schemas'

export type WriteOperationInput = {
  accountId: string
  expect: { connectedAtMs: number }
  args: unknown
}

export type WriteGatewayDeps = {
  shopifyOrderTagAdd(input: WriteOperationInput): Promise<WriteResult>
  slackChannelPost(input: WriteOperationInput): Promise<WriteResult>
  now?: () => number
}

const isUnknownOperation = (req: unknown): boolean => {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) return false
  const op = (req as Record<string, unknown>).operation
  return typeof op === 'string' && !(WRITE_OPERATIONS as readonly string[]).includes(op)
}

export async function runWriteAction(deps: WriteGatewayDeps, req: WriteRequest): Promise<WriteResult> {
  const now = deps.now ?? (() => Date.now())
  const started = now()

  const parsed = WriteRequestSchema.safeParse(req)
  if (!parsed.success) {
    const unknown = isUnknownOperation(req)
    const detail = unknown ? undefined : parsed.error.issues[0]?.path.join('.') || 'request'
    const result: WriteResult = {
      ok: false,
      error: hubError(unknown ? 'unknown_tool' : 'invalid_args', detail),
      sent: 'no',
    }
    log('hub_call', { tool: 'write_invalid', code: result.error.code, outcome: result.sent, ms: now() - started })
    return result
  }

  const { requestId, accountId, expect, operation, args } = parsed.data
  let result: WriteResult
  switch (operation) {
    case 'shopify.order.tag_add':
      result = await deps.shopifyOrderTagAdd({ accountId, expect, args })
      break
    case 'slack.channel.post':
      result = await deps.slackChannelPost({ accountId, expect, args })
      break
  }

  log('hub_call', {
    requestId,
    accountId,
    tool: operation,
    code: result.ok ? 'ok' : result.error.code,
    outcome: result.ok ? 'sent' : result.sent,
    ms: now() - started,
  })
  return result
}
