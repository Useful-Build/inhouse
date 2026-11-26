// zod mirrors of contract.ts. Every gateway argument is parsed with these at the entrypoint; bad input is
// `invalid_args`. schemas.test.ts asserts each schema's inferred type equals its plain contract type.
import { z } from 'zod'

const id = z.string().min(1).max(200)

export const InstantSchema = z.strictObject({ iso: z.string(), ms: z.number() })

export const CallerScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run'), runId: id, principalId: id, requestId: id }),
  z.strictObject({ kind: z.literal('server'), job: id, requestId: id }),
])

export const HubErrorCodeSchema = z.enum([
  'invalid_args',
  'unknown_tool',
  'write_refused',
  'not_configured',
  'credentials_rejected',
  'scope_mismatch',
  'key_unavailable',
  'upstream_unavailable',
  'upstream_rejected',
  'upstream_version_mismatch',
  'rate_limited',
  'result_too_large',
  'internal',
  // P5 (p5-w1)
  'state_invalid',
  'workspace_mismatch',
  'connect_stale',
  'connect_refused',
  'paused',
])

export const HubErrorSchema = z.strictObject({
  code: HubErrorCodeSchema,
  message: z.string(),
  retryAfterMs: z.number().optional(),
})

export const hubResultSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), error: HubErrorSchema }),
  ])

export const ToolInfoSchema = z.strictObject({
  name: z.string(),
  connector: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
})

export const SignInStateSchema = z.enum(['empty', 'active', 'failed', 'disconnected'])

export const AccountStatusSchema = z.strictObject({
  accountId: z.string(),
  state: SignInStateSchema,
  kid: z.string().nullable(),
  expiresAt: InstantSchema.nullable(),
  scopes: z.array(z.string()),
  lastError: z.strictObject({ code: HubErrorCodeSchema, at: InstantSchema }).nullable(),
  // P5 (p5-w1)
  paused: z.boolean(),
  kind: z.enum(['client_credentials', 'oauth_mcp']),
  connectedBy: z.string().nullable(),
  connectedAt: InstantSchema.nullable(),
  revokeFailedAt: InstantSchema.nullable(),
  needsReconnect: z.boolean(),
})

export const AccountSummarySchema = z.strictObject({
  accountId: z.string(),
  connector: z.string(),
  configured: z.boolean(),
  status: AccountStatusSchema,
})

/** A connector id or account id: `shopify`, `shopify:store`. */
export const ACCOUNT_ID = /^[a-z]+(:[a-z0-9-]{1,40})?$/
export const AccountIdSchema = z.string().regex(ACCOUNT_ID)
export const ToolNameSchema = z.string().min(1).max(200)

// P5 (p5-w1): ConnectGateway arguments.
export const MemberIdSchema = z.string().min(1).max(200)
/** A state is base64url(accountId) + '.' + base64url(32 bytes); the bound keeps odd input out of the hash. */
export const ConnectStateSchema = z.string().min(3).max(512)
export const AuthCodeSchema = z.string().min(1).max(4096)
export const ConnectErrorSchema = z.string().max(512)

/** A Shopify shop host: `<handle>.myshopify.com`, the handle as parseShopifyConfig takes it (signin/providers/shopify.ts). */
export const SHOP_HOST = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/
export const CallToolOptionsSchema = z.strictObject({ testShopHost: z.string().regex(SHOP_HOST).optional() })

// Stage 1 M2 (W0-A): the write entrypoint's request and result (contract.ts WriteRequest, WriteResult).
// Written out, as HubErrorCodeSchema is (this file imports nothing from contract.ts); schemas.test.ts checks it equals
// WRITE_OPERATIONS.
export const WriteOperationKeySchema = z.enum(['shopify.order.tag_add', 'slack.channel.post'])

export const WriteRequestSchema = z.strictObject({
  actionId: id,
  attempt: z.int().min(1),
  requestId: id,
  accountId: AccountIdSchema,
  expect: z.strictObject({ connectedAtMs: z.int().nonnegative() }),
  operation: WriteOperationKeySchema,
  args: z.unknown(),
})

export const WriteResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: z.strictObject({ ref: z.string().max(500) }) }),
  z.strictObject({ ok: z.literal(false), error: HubErrorSchema, sent: z.enum(['no', 'unknown']) }),
])
