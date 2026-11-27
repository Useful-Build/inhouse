// The operation table (N9): the one catalogue of writes. Typed as `OperationTable`, so it and the hub's
// `WRITE_OPERATIONS` can't drift: a key missing here, or an entry under another key, fails the typecheck.
import { shopifyOrderTagAdd } from './shopify-order-tag-add.ts'
import { slackChannelPost } from './slack-channel-post.ts'
import type { GrantDefaults, OperationEntry, OperationTable, WriteOperationKey } from './types.ts'

export const OPERATIONS: OperationTable = {
  'shopify.order.tag_add': shopifyOrderTagAdd,
  'slack.channel.post': slackChannelPost,
}

export const OPERATION_KEYS = Object.keys(OPERATIONS) as WriteOperationKey[]

/** The entry for a key that may come from outside (a stored row, a cast): null when it names no operation. */
export function operationEntry(key: string): OperationEntry | null {
  return Object.hasOwn(OPERATIONS, key) ? OPERATIONS[key as WriteOperationKey] : null
}

/**
 * Stage 1 M3-A: a grant's default limits. Only an operation with no effect flag has them; any caller asking for another's
 * is a bug (an exact-only operation never gets "Always allow"), so it fails loud.
 */
export function grantDefaults(key: WriteOperationKey): GrantDefaults {
  const grant = OPERATIONS[key].defaults.grant
  if (!grant) throw new Error(`${key}: no grant defaults (every call is an exact approval)`)
  return grant
}

/** The operation the agent's tool name names (`shopify_order_tag_add`), or null. */
export function operationForTool(tool: string): WriteOperationKey | null {
  return OPERATION_KEYS.find(k => OPERATIONS[k].tool === tool) ?? null
}
