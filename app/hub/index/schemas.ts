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
})

/** A connector id or account id: `shopify`, `shopify:store`. */
export const ACCOUNT_ID = /^[a-z]+(:[a-z0-9-]{1,40})?$/
export const AccountIdSchema = z.string().regex(ACCOUNT_ID)
export const ToolNameSchema = z.string().min(1).max(200)
