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
  // Stage 1 M4 (M4-A)
  'needs_key',
  'definition_changed',
  'needs_input',
  'leak',
  'client_fault',
  'not_built',
  'connections_off',
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

export const ToolTrustSchema = z.enum(['own', 'trusted', 'untrusted'])

export const ToolInfoSchema = z.strictObject({
  name: z.string(),
  connector: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  // Stage 1 M4 (N44, N49): the hub account it reads and the hub's word on it.
  source: z.string().optional(),
  trust: ToolTrustSchema.optional(),
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
  kind: z.enum(['client_credentials', 'oauth_mcp', 'mcp_runtime']),
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
export const CallToolOptionsSchema = z.strictObject({
  testShopHost: z.string().regex(SHOP_HOST).optional(),
  // Stage 1 M4 (N48, N44): a script's proposals (M4-K3) and one tool's lookup (M4-T).
  propose: z.boolean().optional(),
  name: ToolNameSchema.optional(),
})

// Stage 1 M4 (N48): a script's proposals, in their own field of a call's answer (contract.ts CallToolValue).
export const ScriptProposalSchema = z.strictObject({ tool: ToolNameSchema, args: z.unknown() })
export const CallToolValueSchema = z.strictObject({ data: z.unknown(), proposals: z.array(ScriptProposalSchema).max(50).optional() })

// Stage 1 M2 (W0-A): the write entrypoint's request and result (contract.ts WriteRequest, WriteResult).
// Written out, as HubErrorCodeSchema is (this file imports nothing from contract.ts); schemas.test.ts checks it equals
// WRITE_OPERATIONS.
export const WriteOperationKeySchema = z.enum(['shopify.order.tag_add', 'slack.channel.post', 'shopify.order.tag_remove', 'shopify.draft_order.create',
  'shopify.inventory.restock', 'shopify.inventory.reduce', 'shopify.refund.create'])

/** Stage 1 M4 (N46): the write operations whose request carries an MCP write's pins. M4-W2 adds `mcp.tool.call`. */
export const PINNED_OPERATIONS: readonly string[] = []

/** Stage 1 M4 (N43): a tool definition's hash, SHA-256 in lower-case hex. */
export const DEF_HASH = /^[0-9a-f]{64}$/

export const WriteRequestSchema = z.strictObject({
  actionId: id,
  attempt: z.int().min(1),
  requestId: id,
  accountId: AccountIdSchema,
  // Stage 1 M4 (N46): an MCP write's pins, all three or none.
  expect: z.strictObject({
    connectedAtMs: z.int().nonnegative(),
    shop: z.string().regex(SHOP_HANDLE).optional(),
    generation: z.int().min(1).optional(),
    defHash: z.string().regex(DEF_HASH).optional(),
    policyRev: z.int().min(1).optional(),
  }).refine(e => [e.generation, e.defHash, e.policyRev].every(v => v === undefined) || [e.generation, e.defHash, e.policyRev].every(v => v !== undefined), 'An MCP write pins generation, defHash and policyRev together'),
  operation: WriteOperationKeySchema,
  args: z.unknown(),
  // Stage 1 M3 (N22, N21): a batch item, `n` of `of`, at most the ceiling's largest batch (500); the upstream
  // idempotency key (`<actionId>:<n>`).
  item: z.strictObject({ n: z.int().min(1).max(500), of: z.int().min(1).max(500) }).refine(i => i.n <= i.of, 'An item is at most the last one').optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/).optional(),
}).superRefine((r, ctx) => {
  // Stage 1 M4 (#673): an MCP write's pins only on an operation that reads them, and always there. None does yet (M4-W2
  // adds `mcp.tool.call` here with its entry), so a request carrying them is refused, `sent: 'no'`, as before M4-A.
  const pinned = r.expect.generation !== undefined
  if (pinned !== (PINNED_OPERATIONS as readonly string[]).includes(r.operation)) ctx.addIssue({ code: 'custom', path: ['expect', 'generation'], message: 'Pins only on an operation that reads them' })
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

// ---- Stage 1 M4 (M4-A): connections by address (contract.ts, N35 to N46). Each request is parsed with these at the
// entrypoint; bad input is `invalid_args`. ----

/** A connection's slug: lower case letters and digits, a letter first, 2 to 24 (it starts each tool's `hubName`, N45). */
export const CONNECTION_SLUG = /^[a-z][a-z0-9]{1,23}$/
/** A connection's account id: `mcp:<slug>` (a hub `ACCOUNT_ID`). */
export const CONNECTION_ACCOUNT_ID = /^mcp:[a-z][a-z0-9]{1,23}$/
/**
 * Slugs no connection may take (N35): the compiled connectors' and the hub's own names. The hub also refuses every
 * compiled connector id its registry holds.
 */
export const RESERVED_CONNECTION_SLUGS = ['shopify', 'slack', 'code', 'inhouse', 'member', 'index'] as const
/**
 * An exact https address (N35): no user part, no query, no fragment; a port and a path allowed. Whether it's public is
 * the hub's address check's, not this pattern's.
 */
export const HTTPS_ADDRESS = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/
const address = z.string().max(2048).regex(HTTPS_ADDRESS)
/** Our tool name for a connection's tool (N45): `<slug>_<tool>`, lower case, at most 50. */
export const HUB_TOOL_NAME = /^[a-z][a-z0-9_]{0,49}$/
/** A server's own tool name, as the wire carries it (MCP's tool name rule, bounded). */
export const ServerToolNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/)
const ifRev = z.int().min(1).max(999_999_999)
const settings = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().max(200)).refine(r => Object.keys(r).length <= 20, 'At most 20 settings')

export const ConnectionAccountIdSchema = z.string().regex(CONNECTION_ACCOUNT_ID)
export const ConnectionActorKindSchema = z.enum(['inhouse', 'admin'])
export const ConnectionActorSchema = z.strictObject({ kind: ConnectionActorKindSchema, memberId: MemberIdSchema })
export const ConnectionStateSchema = z.enum(['waiting_signin', 'waiting_key', 'needs_review', 'live', 'sign_in_again', 'needs_key', 'unavailable'])
export const ConnectionTransportSchema = z.enum(['https', 'connector'])
export const ConnectionPathSchema = z.enum(['none', 'signin', 'key'])
export const ConnectionEraSchema = z.enum(['modern', 'legacy'])
export const ConnectionDestinationsSchema = z.strictObject({
  mcp: address,
  metadata: z.array(address).max(4),
  issuer: address.nullable(),
  authorize: address.nullable(),
  token: address.nullable(),
  registration: address.nullable(),
  revoke: address.nullable(),
})
export const DetectOutcomeSchema = z.enum(['open', 'signin', 'signin_needs_app', 'key', 'blocked', 'not_mcp'])
export const DetectResultSchema = z.strictObject({
  outcome: DetectOutcomeSchema,
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  era: ConnectionEraSchema.nullable(),
  destinations: ConnectionDestinationsSchema,
})
export const DetectRequestSchema = z.strictObject({ actor: ConnectionActorSchema, url: address })

// ---- The one list of headers a key may never take and a request to a connection may never carry (Stage 1 M4-R1, N42;
// #731). Here, beside the key place's schema, because this file may import only zod (the product reads it too);
// connections/headers.ts re-exports it for oauth/http.ts `validCredential` and the senders (connections/send.ts). ----

/** Set by the transport itself: a key in one would break or forge the request's framing or the MCP headers. */
export const TRANSPORT_HEADERS: readonly string[] = ['accept', 'connection', 'content-length', 'content-type', 'expect', 'host', 'keep-alive', 'last-event-id', 'te', 'transfer-encoding', 'upgrade']
/** Never sent to a connection at all: a cookie, proxy credentials, and anything that claims where a request came from. */
export const NEVER_SENT_HEADERS: readonly string[] = ['cookie', 'forwarded', 'proxy-authorization', 'x-real-ip']
const TRANSPORT_PREFIXES = ['mcp-']
const NEVER_SENT_PREFIXES = ['x-forwarded-']

/** A header no request to a connection carries. */
export function neverSentHeader(name: string): boolean {
  const n = name.toLowerCase()
  return NEVER_SENT_HEADERS.includes(n) || NEVER_SENT_PREFIXES.some(p => n.startsWith(p))
}

/** A header a key may never take (`Authorization` is allowed, with a scheme prefix: schemas.ts checks the prefix). */
export function forbiddenKeyHeader(name: string): boolean {
  const n = name.toLowerCase()
  return TRANSPORT_HEADERS.includes(n) || TRANSPORT_PREFIXES.some(p => n.startsWith(p)) || neverSentHeader(n)
}

/** The first never-sent header a request carries, or null. */
export function firstNeverSent(headers: Headers): string | null {
  for (const [name] of headers) if (neverSentHeader(name)) return name
  return null
}

/**
 * A key's header (N42): a header token, never one on the shared denylist (connections/headers.ts: the transport's own
 * headers, any `Mcp-*`, cookies, proxy and forwarding headers; #731); `Authorization` only with a scheme prefix. The
 * prefix has no CR, LF or other control character.
 */
export const ConnectionKeyPlaceSchema = z.strictObject({
  header: z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/).refine(h => !forbiddenKeyHeader(h), 'Not a header a key may use'),
  prefix: z.string().max(32).regex(/^[\x20-\x7e]*$/),
}).refine(k => k.header.toLowerCase() !== 'authorization' || /^[A-Za-z][A-Za-z0-9-]* $/.test(k.prefix), 'Authorization takes a scheme prefix')
export const ConnectionBindingInputSchema = z.discriminatedUnion('transport', [
  z.strictObject({ transport: z.literal('https'), path: ConnectionPathSchema, destinations: ConnectionDestinationsSchema, key: ConnectionKeyPlaceSchema.optional(), settings }),
  z.strictObject({ transport: z.literal('connector'), connector: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), settings }),
])
export const PrepareConnectionRequestSchema = z.strictObject({
  actor: ConnectionActorSchema,
  slug: z.string().regex(CONNECTION_SLUG).refine(s => !(RESERVED_CONNECTION_SLUGS as readonly string[]).includes(s), 'A reserved slug'),
  adminMaySignIn: z.boolean(),
  binding: ConnectionBindingInputSchema,
})
export const ConnectionRefRequestSchema = z.strictObject({ actor: ConnectionActorSchema, accountId: ConnectionAccountIdSchema })
export const UpdateConnectionRequestSchema = z.strictObject({
  actor: ConnectionActorSchema,
  accountId: ConnectionAccountIdSchema,
  ifRev,
  adminMaySignIn: z.boolean().optional(),
  settings: settings.optional(),
})
export const SetTrustedRequestSchema = z.strictObject({ actor: ConnectionActorSchema, accountId: ConnectionAccountIdSchema, trusted: z.boolean(), ifRev })
export const ConnectionCredentialSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('key'), key: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/) }),
  z.strictObject({ kind: z.literal('client'), clientId: z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/), clientSecret: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/).nullable() }),
])
export const SetCredentialRequestSchema = z.strictObject({ actor: ConnectionActorSchema, accountId: ConnectionAccountIdSchema, credential: ConnectionCredentialSchema })
export const ConnectionListFreshnessSchema = z.strictObject({ fetchedAtMs: z.int().nonnegative(), ttlMs: z.int().min(0).max(3_600_000), complete: z.boolean() })
export const ConnectionViewSchema = z.strictObject({
  accountId: ConnectionAccountIdSchema,
  slug: z.string().regex(CONNECTION_SLUG),
  generation: z.int().min(1),
  policyRev: z.int().min(1),
  transport: ConnectionTransportSchema,
  path: ConnectionPathSchema,
  connector: z.string().nullable(),
  destinations: ConnectionDestinationsSchema.nullable(),
  era: ConnectionEraSchema.nullable(),
  settings,
  trusted: z.boolean(),
  adminMaySignIn: z.boolean(),
  paused: z.boolean(),
  state: ConnectionStateSchema,
  list: ConnectionListFreshnessSchema.nullable(),
})
export const ConnectionToolModeSchema = z.enum(['new', 'read', 'write', 'off'])
export const ConnectionToolHiddenSchema = z.enum(['changed', 'gone', 'rejected'])
export const ConnectionToolSchema = z.strictObject({
  name: ServerToolNameSchema,
  hubName: z.string().regex(HUB_TOOL_NAME),
  title: z.string().max(200).nullable(),
  description: z.string().max(1024),
  inputSchema: z.record(z.string(), z.unknown()),
  defHash: z.string().regex(DEF_HASH),
  mode: ConnectionToolModeSchema,
  confirmedHash: z.string().regex(DEF_HASH).nullable(),
  hidden: ConnectionToolHiddenSchema.nullable(),
  readOnlyHint: z.boolean().nullable(),
})
export const ConnectionToolsSchema = z.strictObject({
  generation: z.int().min(1),
  policyRev: z.int().min(1),
  list: ConnectionListFreshnessSchema.nullable(),
  tools: z.array(ConnectionToolSchema).max(200),
})
export const ConfirmToolsRequestSchema = z.strictObject({
  actor: ConnectionActorSchema,
  accountId: ConnectionAccountIdSchema,
  generation: z.int().min(1),
  ifRev,
  tools: z.array(z.strictObject({ name: ServerToolNameSchema, defHash: z.string().regex(DEF_HASH), mode: z.enum(['read', 'write', 'off']) }))
    .min(1).max(200).refine(t => new Set(t.map(x => x.name)).size === t.length, 'Each tool once'),
})
export const ConnectionSummarySchema = ConnectionViewSchema.extend({
  tools: z.array(z.strictObject({
    name: ServerToolNameSchema,
    hubName: z.string().regex(HUB_TOOL_NAME),
    defHash: z.string().regex(DEF_HASH),
    mode: ConnectionToolModeSchema,
    hidden: ConnectionToolHiddenSchema.nullable(),
  })).max(200),
})
export const WriteToolInfoSchema = z.strictObject({
  accountId: ConnectionAccountIdSchema,
  name: ServerToolNameSchema,
  hubName: z.string().regex(HUB_TOOL_NAME),
  description: z.string().max(1024),
  inputSchema: z.record(z.string(), z.unknown()),
  defHash: z.string().regex(DEF_HASH),
  generation: z.int().min(1),
  policyRev: z.int().min(1),
  trusted: z.boolean(),
})
/** N40: every `iss` value a sign-in's return carried, in order, or null for none; two or more is a doubled `iss` (refused by the hub). */
export const ReturnIssSchema = z.array(z.string().max(2048)).min(1).max(4).nullable()
/** #674: a return's forwarded fields, both required (contract.ts `ConnectReturn`). */
export const ConnectReturnSchema = z.strictObject({ actorKind: ConnectionActorKindSchema, iss: ReturnIssSchema })
