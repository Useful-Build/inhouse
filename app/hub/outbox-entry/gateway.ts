// WriteGateway's logic (Stage 1 M2-C, N13) as plain functions over injected deps so the Node project tests every path
// without workerd. entry.ts is the thin WorkerEntrypoint<Env> wrapper over this.
//
// The binding (`HUB_WRITE`) is the boundary: there is no caller-supplied scope to trust. Every request is checked by
// `WriteRequestSchema` strictly at run time; an unknown operation or malformed request is refused with `sent: 'no'`.
import { WRITE_OPERATIONS, type WriteRequest, type WriteResult } from '../index/contract'
import { hubError } from '../index/errors'
import { log } from '../index/log'
import { WriteRequestSchema } from '../index/schemas'
import { settledAnswer } from '../../shared/rpc-answer'
import type { ShopifyWriteKey } from '../connectors/shopify/write/ops/index'

export type WriteOperationInput = {
  accountId: string
  expect: { connectedAtMs: number; shop?: string }
  args: unknown
  /** Stage 1 M3-S2: the request's idempotency key, passed on to an operation whose mutation takes one. */
  idempotencyKey?: string
}

/** A Shopify write: the operation travels with the input (the write SignIn runs every `shopify.` operation, M3-S1). */
export type ShopifyWriteOperationInput = WriteOperationInput & { operation: ShopifyWriteKey }

export type WriteGatewayDeps = {
  shopifyWrite(input: ShopifyWriteOperationInput): Promise<WriteResult>
  slackChannelPost(input: WriteOperationInput): Promise<WriteResult>
  now?: () => number
}

/** The write SignIn's method the test build's `shopifyWrite` calls (entry.ts). */
export type ShopifyWriteStub = { runWrite(input: ShopifyWriteOperationInput): unknown }

/**
 * The write SignIn's `runWrite`, its answer read as plain data and released (`settledAnswer`, shared/rpc-answer.ts),
 * never passed on as is: an answer passed on carries its disposer, which keeps the call open until the caller disposes it.
 */
export async function shopifyWriteVia(stub: ShopifyWriteStub, input: ShopifyWriteOperationInput): Promise<WriteResult> {
  return (await settledAnswer(stub.runWrite(input))) as WriteResult
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

  const { requestId, accountId, expect, operation, args, idempotencyKey } = parsed.data
  let result: WriteResult
  switch (operation) {
    case 'shopify.order.tag_add':
    case 'shopify.order.tag_remove':
    case 'shopify.draft_order.create':
    case 'shopify.inventory.restock':
    case 'shopify.inventory.reduce':
    case 'shopify.refund.create':
      // One hub call per item (N22): `item` changes nothing here. The idempotency key goes on to the write core, which
      // requires it for an operation whose mutation takes one (stock and refunds, M3-S2) and ignores it elsewhere.
      result = await deps.shopifyWrite({ operation, accountId, expect, args, ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) })
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
