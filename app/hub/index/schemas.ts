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

/** A Shopify store's handle (`<handle>.myshopify.com` without the domain), as the hub's config parsers take it. */
export const SHOP_HANDLE = /^[a-z0-9][a-z0-9-]{0,59}$/

export const AccountSummarySchema = z.strictObject({
  accountId: z.string(),
  connector: z.string(),
  configured: z.boolean(),
  status: AccountStatusSchema,
  shop: z.string().regex(SHOP_HANDLE).optional(),
  // Stage 1 M3-S2 (N21): the write store's currency, ISO 4217.
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
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
export const WriteOperationKeySchema = z.enum(['shopify.order.tag_add', 'slack.channel.post', 'shopify.order.tag_remove', 'shopify.draft_order.create',
  'shopify.inventory.restock', 'shopify.inventory.reduce', 'shopify.refund.create'])

export const WriteRequestSchema = z.strictObject({
  actionId: id,
  attempt: z.int().min(1),
  requestId: id,
  accountId: AccountIdSchema,
  expect: z.strictObject({ connectedAtMs: z.int().nonnegative(), shop: z.string().regex(SHOP_HANDLE).optional() }),
  operation: WriteOperationKeySchema,
  args: z.unknown(),
  // Stage 1 M3 (N22, N21): a batch item, `n` of `of`, at most the ceiling's largest batch (500); the upstream
  // idempotency key (`<actionId>:<n>`).
  item: z.strictObject({ n: z.int().min(1).max(500), of: z.int().min(1).max(500) }).refine(i => i.n <= i.of, 'An item is at most the last one').optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/).optional(),
})

export const WriteResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: z.strictObject({ ref: z.string().max(500) }) }),
  // Stage 1 M3 (N22): a write's `retryAfterMs` is a whole number of milliseconds up to a day (the batch clamps it).
  z.strictObject({ ok: z.literal(false), error: HubErrorSchema.extend({ retryAfterMs: z.int().min(0).max(86_400_000).optional() }), sent: z.enum(['no', 'unknown']) }),
])

// Stage 1 M3 (card details, #488): `ConnectGateway.cardFacts` (contract.ts CardFactsRequest, CardFacts). The ids are the
// write operations' own id shapes; the answer's strings are capped (CARD_FACTS_CAPS, written out here).
const ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,19}$/
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]{0,19}$/
const distinct = (ids: string[]) => new Set(ids).size === ids.length

export const CardFactsRequestSchema = z.strictObject({
  accountId: z.literal('shopify:store'),
  expect: z.strictObject({ connectedAtMs: z.int().nonnegative(), shop: z.string().regex(SHOP_HANDLE) }),
  orderIds: z.array(z.string().regex(ORDER_GID)).max(100).refine(distinct, 'Each order once'),
  variantIds: z.array(z.string().regex(VARIANT_GID)).max(20).refine(distinct, 'Each variant once'),
})

const capped = (bytes: number) => z.string().max(bytes)
export const CardFactsSchema = z.strictObject({
  orders: z.array(z.discriminatedUnion('found', [
    z.strictObject({
      id: z.string().regex(ORDER_GID), found: z.literal(true), name: capped(40), customer: capped(120).nullable(),
      total: z.strictObject({ amount: z.string().regex(/^-?\d{1,15}(?:\.\d{1,6})?$/), currencyCode: z.string().regex(/^[A-Z]{3}$/) }).nullable(),
    }),
    z.strictObject({ id: z.string().regex(ORDER_GID), found: z.literal(false) }),
  ])).max(100).nullable(),
  variants: z.array(z.discriminatedUnion('found', [
    z.strictObject({ id: z.string().regex(VARIANT_GID), found: z.literal(true), product: capped(120), variant: capped(40), sku: capped(64).nullable() }),
    z.strictObject({ id: z.string().regex(VARIANT_GID), found: z.literal(false) }),
  ])).max(20).nullable(),
})
