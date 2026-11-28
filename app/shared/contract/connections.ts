// Stage 1 M4 (M4-A; N35 to N46): connecting a tool by address. What the browser and the product Worker exchange on
// routes 160 to 171; M4-R2 lands the rows, each owner fills its handler. Written out, as the client bundle imports
// nothing from the hub; the type checks at the end keep the closed lists equal to the hub's contract.ts.
// Nothing here carries a credential back: a key or a client secret goes in (route 166) and never comes out.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import type {
  ConnectionActorKind, ConnectionEra, ConnectionPath, ConnectionState, ConnectionToolHidden, ConnectionToolMode, ConnectionTransport, DetectOutcome,
} from '../../hub/index/contract.ts'

/** A connection's account id, `mcp:<slug>` (the hub's `CONNECTION_ACCOUNT_ID`): the `:id` of routes 162 to 171. */
export const ConnectionIdSchema = z.string().regex(/^mcp:[a-z][a-z0-9]{1,23}$/)
export type ConnectionId = z.infer<typeof ConnectionIdSchema>

/** Slugs no connection may take (N35), as the hub's `RESERVED_CONNECTION_SLUGS`. The hub also refuses its connectors' ids. */
export const RESERVED_CONNECTION_SLUGS = ['shopify', 'slack', 'code', 'inhouse', 'member', 'index'] as const
/** Lower case letters and digits, a letter first, 2 to 24: it starts each tool's name (N45). Never reused after a remove. */
export const ConnectionSlugSchema = z.string().regex(/^[a-z][a-z0-9]{1,23}$/)
  .refine(s => !(RESERVED_CONNECTION_SLUGS as readonly string[]).includes(s), 'That name is taken by Inhouse')

/**
 * The connection's name and about line (N45): the only text a browser types here, kept in D1 and shown to the model as
 * our words. Letters, digits, spaces and a few marks; no line break, markup, backtick or bracket.
 */
export const ConnectionNameSchema = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N} .&'-]{0,39}$/u)
export const ConnectionAboutSchema = z.string().regex(/^[\p{L}\p{N} .,&'():;!?/-]{0,160}$/u)

export const ConnectionStateSchema = z.enum(['waiting_signin', 'waiting_key', 'needs_review', 'live', 'sign_in_again', 'needs_key', 'unavailable'])
export type ConnectionStateName = z.infer<typeof ConnectionStateSchema>
export const ConnectionTransportSchema = z.enum(['https', 'connector'])
export const ConnectionPathSchema = z.enum(['none', 'signin', 'key'])
export const ConnectionEraSchema = z.enum(['modern', 'legacy'])
export const DetectOutcomeSchema = z.enum(['open', 'signin', 'signin_needs_app', 'key', 'blocked', 'not_mcp'])
export const ConnectionToolModeSchema = z.enum(['new', 'read', 'write', 'off'])
export const ConnectionToolHiddenSchema = z.enum(['changed', 'gone', 'rejected'])
/** Who acts: the Inhouse team or an Admin (N40). A Member never reaches these routes. */
export const ConnectionActorKindSchema = z.enum(['inhouse', 'admin'])

/** An exact https address (N35): no user part, query or fragment. Whether it's public is the hub's check. */
const AddressSchema = z.string().max(2048).regex(/^https:\/\/[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/)
/** A tool definition's hash (N43): SHA-256, lower-case hex. */
const DefHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
/** The server's own tool name, as the wire carries it. */
const ServerToolNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/)
/** Ours (N45): `<slug>_<tool>`, at most 50. */
const HubToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/)
const IfRevSchema = z.number().int().min(1).max(999_999_999)
const SettingsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().max(200)).refine(r => Object.keys(r).length <= 20, 'At most 20 settings')

/** Every address a connection may reach, by purpose (N35). The screen names them for the Inhouse team to confirm. */
export const ConnectionDestinationsSchema = z.object({
  mcp: AddressSchema,
  metadata: z.array(AddressSchema).max(4),
  issuer: AddressSchema.nullable(),
  authorize: AddressSchema.nullable(),
  token: AddressSchema.nullable(),
  registration: AddressSchema.nullable(),
  revoke: AddressSchema.nullable(),
}).strict()
export type ConnectionDestinations = z.infer<typeof ConnectionDestinationsSchema>

// ---- Route 160: `POST /api/tools/connections/detect` (M4-D) ----
export const DetectInputSchema = z.object({ url: AddressSchema }).strict()
export type DetectInput = z.infer<typeof DetectInputSchema>
/** `reason`: one of M4-D's fixed codes (N38; `app/shared/connect-reasons.ts` says each in words) when it refuses. */
export const DetectAnswerSchema = z.object({
  outcome: DetectOutcomeSchema,
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  era: ConnectionEraSchema.nullable(),
  destinations: ConnectionDestinationsSchema,
})
export type DetectAnswer = z.infer<typeof DetectAnswerSchema>

// ---- Route 161: `POST /api/tools/connections` (M4-R2): an address, or a built connector ----
/** Where a key goes (N42). The hub checks the header rules again; this is the screen's first check. */
export const ConnectionKeyPlaceSchema = z.object({ header: z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/), prefix: z.string().max(32).regex(/^[\x20-\x7e]*$/) }).strict()
export const ConnectionBindingSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('https'), path: ConnectionPathSchema, destinations: ConnectionDestinationsSchema, key: ConnectionKeyPlaceSchema.optional(), settings: SettingsSchema }).strict(),
  z.object({ transport: z.literal('connector'), connector: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), settings: SettingsSchema }).strict(),
])
export type ConnectionBinding = z.infer<typeof ConnectionBindingSchema>
/** `adminMaySignIn`: "an Admin may give the login" (W1): an Admin may sign in or give the key while it waits for one. */
export const PrepareConnectionInputSchema = z.object({
  slug: ConnectionSlugSchema,
  name: ConnectionNameSchema,
  about: ConnectionAboutSchema,
  adminMaySignIn: z.boolean(),
  binding: ConnectionBindingSchema,
}).strict()
export type PrepareConnectionInput = z.infer<typeof PrepareConnectionInputSchema>

// ---- Route 162: `GET /api/tools/connections/:id` (the answer of 161 and 163 too) ----
export const ListFreshnessSchema = z.object({ fetchedAt: InstantSchema, ttlMs: z.number().int().min(0).max(3_600_000), complete: z.boolean() })
/**
 * One connection: the hub's word (state, trust, pause, revisions) beside the D1 copy's name and about line. `rev` is the
 * hub's `policyRev`, the `ifRev` of 163, 164 and 169. No credential, ever.
 */
export const ConnectionDetailSchema = z.object({
  id: ConnectionIdSchema,
  slug: ConnectionSlugSchema,
  name: ConnectionNameSchema,
  about: ConnectionAboutSchema,
  generation: z.number().int().min(1),
  rev: z.number().int().min(1),
  transport: ConnectionTransportSchema,
  path: ConnectionPathSchema,
  connector: z.string().nullable(),
  destinations: ConnectionDestinationsSchema.nullable(),
  era: ConnectionEraSchema.nullable(),
  settings: SettingsSchema,
  trusted: z.boolean(),
  adminMaySignIn: z.boolean(),
  paused: z.boolean(),
  state: ConnectionStateSchema,
  list: ListFreshnessSchema.nullable(),
})
export type ConnectionDetail = z.infer<typeof ConnectionDetailSchema>

// ---- Route 163: `PUT /api/tools/connections/:id` (M4-R2). Each field left out stays as it is. ----
export const UpdateConnectionInputSchema = z.object({
  ifRev: IfRevSchema,
  name: ConnectionNameSchema.optional(),
  about: ConnectionAboutSchema.optional(),
  adminMaySignIn: z.boolean().optional(),
  settings: SettingsSchema.optional(),
}).strict()
export type UpdateConnectionInput = z.infer<typeof UpdateConnectionInputSchema>

// ---- Route 164: `PUT /api/tools/connections/:id/trusted` (M4-L), Inhouse team only ----
export const ConnectionTrustedInputSchema = z.object({ trusted: z.boolean(), ifRev: IfRevSchema }).strict()
export type ConnectionTrustedInput = z.infer<typeof ConnectionTrustedInputSchema>
export const ConnectionTrustedResultSchema = z.object({ trusted: z.boolean(), rev: z.number().int().min(1) })
export type ConnectionTrustedResult = z.infer<typeof ConnectionTrustedResultSchema>

// ---- Route 165: `POST /api/tools/connections/:id/signin/start` (M4-O1a, M4-X) ----
/** `host`: the login page's host, which the screen names before the person leaves (N40). */
export const ConnectionSignInStartSchema = z.object({ authorizeUrl: z.string().min(1), host: z.string().min(1).max(253), expiresAt: InstantSchema })
export type ConnectionSignInStart = z.infer<typeof ConnectionSignInStartSchema>

// ---- Route 166: `PUT /api/tools/connections/:id/credential` (M4-B, M4-X): write-only, answered 204 ----
/** The body is never logged, audited or echoed. `client` (a hand-registered app) is the Inhouse team's only. */
export const ConnectionCredentialInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('key'), key: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/) }).strict(),
  z.object({ kind: z.literal('client'), clientId: z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/), clientSecret: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/).nullable() }).strict(),
])
export type ConnectionCredentialInput = z.infer<typeof ConnectionCredentialInputSchema>

// ---- Route 167: `POST /api/tools/connections/:id/check` (M4-D) ----
export const ConnectionCheckResultSchema = z.object({ listed: z.number().int().min(0) })
export type ConnectionCheckResult = z.infer<typeof ConnectionCheckResultSchema>

// ---- Route 168: `GET /api/tools/connections/:id/tools` (M4-H): the stored snapshot, exactly as the model would read it ----
export const ConnectionToolSchema = z.object({
  name: ServerToolNameSchema,
  hubName: HubToolNameSchema,
  title: z.string().max(200).nullable(),
  description: z.string().max(1024),
  inputSchema: z.record(z.string(), z.unknown()),
  defHash: DefHashSchema,
  mode: ConnectionToolModeSchema,
  confirmedHash: DefHashSchema.nullable(),
  hidden: ConnectionToolHiddenSchema.nullable(),
  /** The server's own read-only label: a hint, never the authority. */
  readOnlyHint: z.boolean().nullable(),
})
export type ConnectionTool = z.infer<typeof ConnectionToolSchema>
export const ConnectionToolsAnswerSchema = z.object({
  generation: z.number().int().min(1),
  rev: z.number().int().min(1),
  list: ListFreshnessSchema.nullable(),
  tools: z.array(ConnectionToolSchema).max(200),
})
export type ConnectionToolsAnswer = z.infer<typeof ConnectionToolsAnswerSchema>

// ---- Route 169: `PUT /api/tools/connections/:id/tools` (M4-H), Inhouse team only ----
export const ConfirmToolsInputSchema = z.object({
  generation: z.number().int().min(1),
  ifRev: IfRevSchema,
  tools: z.array(z.object({ name: ServerToolNameSchema, defHash: DefHashSchema, mode: z.enum(['read', 'write', 'off']) }).strict())
    .min(1).max(200).refine(t => new Set(t.map(x => x.name)).size === t.length, 'Each tool once'),
}).strict()
export type ConfirmToolsInput = z.infer<typeof ConfirmToolsInputSchema>
export const ConfirmToolsResultSchema = z.object({ rev: z.number().int().min(1) })
export type ConfirmToolsResult = z.infer<typeof ConfirmToolsResultSchema>

// ---- Route 171: `DELETE /api/tools/connections/:id` (M4-R2), Inhouse team only ----
/** `revoked: false`: the login couldn't be revoked at its source (the team removes the app there too). */
export const RemoveConnectionResultSchema = z.object({ revoked: z.boolean() })
export type RemoveConnectionResult = z.infer<typeof RemoveConnectionResultSchema>

// ---- The closed lists equal the hub's, both ways (a typecheck failure otherwise) ----
type Same<A, B> = [A, B] extends [B, A] ? true : never
const sameLists: [
  Same<z.infer<typeof ConnectionStateSchema>, ConnectionState>,
  Same<z.infer<typeof ConnectionTransportSchema>, ConnectionTransport>,
  Same<z.infer<typeof ConnectionPathSchema>, ConnectionPath>,
  Same<z.infer<typeof ConnectionEraSchema>, ConnectionEra>,
  Same<z.infer<typeof DetectOutcomeSchema>, DetectOutcome>,
  Same<z.infer<typeof ConnectionToolModeSchema>, ConnectionToolMode>,
  Same<z.infer<typeof ConnectionToolHiddenSchema>, ConnectionToolHidden>,
  Same<z.infer<typeof ConnectionActorKindSchema>, ConnectionActorKind>,
] = [true, true, true, true, true, true, true, true]
void sameLists
