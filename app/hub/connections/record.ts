// A connection's record (Stage 1 M4-R1, N35): version 3, `kind: 'mcp_runtime'`, one per `mcp:<slug>` SignIn object,
// under the object's one `record` key. The hub's record is the truth for everything the hub enforces; the product's D1
// copy (M4-R2) is never an input to a decision.
//
// Rules this module keeps (the SignIn core writes through `checkRecord` only):
// - A record is written whole, by one put: every field below is present on every write (the strict schema).
// - `generation` is new on prepare and on any binding or credential change, and never reused after a remove: a remove
//   leaves a tombstone holding the last generation, and a removed slug is never prepared again (contract.ts).
// - `policyRev` only rises: a confirm, a trust flip, pause, a settings or Admin-right change.
// - A changed binding drops every credential (a key, a sign-in's tokens, a client) and never widens what was confirmed:
//   confirms are pinned to the generation they were made in (`confirmedGen`), so a new generation needs a new confirm.
// - The caps (CONNECTION_CAPS): 200 tools in a snapshot, 100 confirmed tools. The index holds the 20 a brand.
import { z } from 'zod'
import type {
  ConnectionBindingInput, ConnectionDestinations, ConnectionEra, ConnectionKeyPlace, ConnectionListFreshness, ConnectionPath, ConnectionState,
  ConnectionSummary, ConnectionToolHidden, ConnectionToolMode, ConnectionTransport, ConnectionView, HubErrorCode,
} from '../index/contract'
import { CONNECTION_CAPS } from '../index/contract'
import type { Envelope } from '../crypto/envelope'
import { hrefOf } from './destinations'
import {
  CONNECTION_ACCOUNT_ID, CONNECTION_SLUG, ConnectionDestinationsSchema, ConnectionEraSchema, ConnectionListFreshnessSchema, ConnectionPathSchema,
  ConnectionStateSchema, ConnectionToolHiddenSchema, ConnectionToolModeSchema, ConnectionTransportSchema, HubErrorCodeSchema, HUB_TOOL_NAME,
  MemberIdSchema, ServerToolNameSchema,
} from '../index/schemas'

/** What the hub reaches and how (N35). Settings are policy, not binding: a settings change bumps `policyRev` only. */
export type ConnectionBinding = {
  transport: ConnectionTransport
  path: ConnectionPath
  /** A built connector's id (`transport: 'connector'`, N50), else null. */
  connector: string | null
  /** An address's destinations, by purpose, each exact; null for a built connector. */
  destinations: ConnectionDestinations | null
  /** Where a key goes (N42); only on the `key` path. */
  key: ConnectionKeyPlace | null
  /** Learned from the first answer (N36); not part of what a change of binding compares. */
  era: ConnectionEra | null
  settings: Record<string, string>
}

/** One tool of the snapshot (N43). `confirmedGen`: the generation the mode was confirmed in. */
export type ConnectionToolRecord = {
  name: string
  hubName: string
  title: string | null
  description: string
  inputSchema: Record<string, unknown>
  readOnlyHint: boolean | null
  defHash: string
  mode: ConnectionToolMode
  confirmedHash: string | null
  confirmedGen: number | null
  hidden: ConnectionToolHidden | null
}

export type ConnectionRecord = {
  v: 3
  kind: 'mcp_runtime'
  accountId: string
  slug: string
  removed: false
  generation: number
  policyRev: number
  binding: ConnectionBinding
  /** A key (N42), sealed under field `key`. */
  key: Envelope | null
  /** A hand-registered app's secret or a registration (N40), sealed under field `client`. */
  client: Envelope | null
  /** A sign-in's tokens (M4-O1a), sealed under `token` and `refresh`. */
  token: Envelope | null
  refresh: Envelope | null
  tools: ConnectionToolRecord[]
  list: ConnectionListFreshness | null
  trusted: boolean
  adminMaySignIn: boolean
  paused: boolean
  state: ConnectionState
  preparedBy: string
  preparedAtMs: number
  lastError: { code: HubErrorCode; atMs: number } | null
}

/**
 * What a remove leaves (N35): the last generation and policy revision, so neither is ever reused, and no credential.
 * `abandoned`: a prepare the index refused (the cap) before anything was listed or held; only that slug may be prepared
 * again, its generation continuing. A `removed` slug never is.
 */
export type ConnectionTombstone = {
  v: 3
  kind: 'mcp_runtime'
  accountId: string
  slug: string
  removed: true
  reason: 'removed' | 'abandoned'
  generation: number
  policyRev: number
  removedAtMs: number
  /** Whether what it held was revoked (or there was nothing to revoke). */
  revoked: boolean
}

export type StoredConnection = ConnectionRecord | ConnectionTombstone

const envelope = z.strictObject({ kid: z.string().min(1).max(64), iv: z.string().min(1).max(64), ct: z.string().min(1).max(65_536) }).nullable()
const gen = z.int().min(1).max(Number.MAX_SAFE_INTEGER)
const settings = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().max(200)).refine(r => Object.keys(r).length <= 20)
const DEF_HASH = /^[0-9a-f]{64}$/

const BindingSchema = z.strictObject({
  transport: ConnectionTransportSchema,
  path: ConnectionPathSchema,
  connector: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).nullable(),
  destinations: ConnectionDestinationsSchema.nullable(),
  key: z.strictObject({ header: z.string().min(1).max(64), prefix: z.string().max(32) }).nullable(),
  era: ConnectionEraSchema.nullable(),
  settings,
}).refine(b => (b.transport === 'https') === (b.destinations !== null) && (b.transport === 'connector') === (b.connector !== null), 'transport and its target')
  .refine(b => (b.path === 'key') === (b.key !== null) || b.transport === 'connector', 'a key place only on the key path')

const ToolSchema = z.strictObject({
  name: ServerToolNameSchema,
  hubName: z.string().regex(HUB_TOOL_NAME),
  title: z.string().max(200).nullable(),
  description: z.string().max(1024),
  inputSchema: z.record(z.string(), z.unknown()),
  readOnlyHint: z.boolean().nullable(),
  defHash: z.string().regex(DEF_HASH),
  mode: ConnectionToolModeSchema,
  confirmedHash: z.string().regex(DEF_HASH).nullable(),
  confirmedGen: gen.nullable(),
  hidden: ConnectionToolHiddenSchema.nullable(),
})

/** The stored record, strictly: every field, nothing more (a record is written whole). */
export const ConnectionRecordSchema = z.strictObject({
  v: z.literal(3),
  kind: z.literal('mcp_runtime'),
  accountId: z.string().regex(CONNECTION_ACCOUNT_ID),
  slug: z.string().regex(CONNECTION_SLUG),
  removed: z.literal(false),
  generation: gen,
  policyRev: gen,
  binding: BindingSchema,
  key: envelope,
  client: envelope,
  token: envelope,
  refresh: envelope,
  tools: z.array(ToolSchema).max(CONNECTION_CAPS.snapshotTools),
  list: ConnectionListFreshnessSchema.nullable(),
  trusted: z.boolean(),
  adminMaySignIn: z.boolean(),
  paused: z.boolean(),
  state: ConnectionStateSchema,
  preparedBy: MemberIdSchema,
  preparedAtMs: z.int().nonnegative(),
  lastError: z.strictObject({ code: HubErrorCodeSchema, atMs: z.int().nonnegative() }).nullable(),
})
  .refine(r => r.accountId === `mcp:${r.slug}`, 'account and slug')
  .refine(r => confirmedCount(r.tools) <= CONNECTION_CAPS.confirmedTools, 'too many confirmed tools')
  .refine(r => new Set(r.tools.map(t => t.name)).size === r.tools.length && new Set(r.tools.map(t => t.hubName)).size === r.tools.length, 'each tool once')

export const ConnectionTombstoneSchema = z.strictObject({
  v: z.literal(3),
  kind: z.literal('mcp_runtime'),
  accountId: z.string().regex(CONNECTION_ACCOUNT_ID),
  slug: z.string().regex(CONNECTION_SLUG),
  removed: z.literal(true),
  reason: z.enum(['removed', 'abandoned']),
  generation: gen,
  policyRev: gen,
  removedAtMs: z.int().nonnegative(),
  revoked: z.boolean(),
}).refine(r => r.accountId === `mcp:${r.slug}`, 'account and slug')

/** A confirmed tool: a `read` or `write` mode the Inhouse team set for a hash (N43). */
export function confirmedCount(tools: readonly Pick<ConnectionToolRecord, 'mode' | 'confirmedHash'>[]): number {
  return tools.filter(t => (t.mode === 'read' || t.mode === 'write') && t.confirmedHash !== null).length
}

/** Whether a stored value is a version 3 record or tombstone (any other record is a version 1 or 2 SignIn record). */
export const isStoredConnection = (raw: unknown): raw is StoredConnection =>
  typeof raw === 'object' && raw !== null && (raw as { v?: unknown }).v === 3 && (raw as { kind?: unknown }).kind === 'mcp_runtime'

export type RecordCheck = { ok: true } | { ok: false; reason: string }

/** The one check every write passes (the core refuses to put anything that fails it). */
export function checkRecord(r: StoredConnection): RecordCheck {
  const parsed = r.removed ? ConnectionTombstoneSchema.safeParse(r) : ConnectionRecordSchema.safeParse(r)
  if (parsed.success) return { ok: true }
  return { ok: false, reason: parsed.error.issues[0]?.message ?? 'record' }
}

/** The state a binding starts in, or returns to when its credential is dropped (N35, N40, N42). */
export function waitingState(b: Pick<ConnectionBinding, 'path'>): ConnectionState {
  return b.path === 'signin' ? 'waiting_signin' : b.path === 'key' ? 'waiting_key' : 'needs_review'
}

/**
 * The binding the Inhouse team confirmed at prepare. A built connector takes a key (N50: the capability attaches it);
 * M4-P1 refines that when it builds the transport.
 */
export function bindingOf(input: ConnectionBindingInput): ConnectionBinding {
  if (input.transport === 'connector') {
    return { transport: 'connector', path: 'key', connector: input.connector, destinations: null, key: null, era: null, settings: { ...input.settings } }
  }
  return {
    transport: 'https',
    path: input.path,
    connector: null,
    destinations: normalised(input.destinations),
    key: input.key ? { ...input.key } : null,
    era: null,
    settings: { ...input.settings },
  }
}

/** Each address in its one spelling (a WHATWG URL's `href`), so the destination rule compares exact strings. */
function normalised(d: ConnectionDestinations): ConnectionDestinations {
  const one = (a: string) => hrefOf(a) ?? a
  const opt = (a: string | null) => (a === null ? null : one(a))
  return { mcp: one(d.mcp), metadata: d.metadata.map(one), issuer: opt(d.issuer), authorize: opt(d.authorize), token: opt(d.token), registration: opt(d.registration), revoke: opt(d.revoke) }
}

/** What a change of binding compares: everything but the learned era and the settings (policy). */
const bindingKey = (b: ConnectionBinding) =>
  JSON.stringify([b.transport, b.path, b.connector, b.destinations && [b.destinations.mcp, [...b.destinations.metadata].sort(), b.destinations.issuer, b.destinations.authorize, b.destinations.token, b.destinations.registration, b.destinations.revoke], b.key && [b.key.header, b.key.prefix]])

export const sameBinding = (a: ConnectionBinding, b: ConnectionBinding): boolean => bindingKey(a) === bindingKey(b)

/** A new connection: the first generation after any earlier one (an abandoned prepare's), untrusted, no credential. */
export function preparedRecord(p: { slug: string; input: ConnectionBindingInput; adminMaySignIn: boolean; memberId: string; nowMs: number; after: ConnectionTombstone | null }): ConnectionRecord {
  const binding = bindingOf(p.input)
  return {
    v: 3,
    kind: 'mcp_runtime',
    accountId: `mcp:${p.slug}`,
    slug: p.slug,
    removed: false,
    generation: (p.after?.generation ?? 0) + 1,
    policyRev: (p.after?.policyRev ?? 0) + 1,
    binding,
    key: null,
    client: null,
    token: null,
    refresh: null,
    tools: [],
    list: null,
    trusted: false,
    adminMaySignIn: p.adminMaySignIn,
    paused: false,
    state: waitingState(binding),
    preparedBy: p.memberId,
    preparedAtMs: p.nowMs,
    lastError: null,
  }
}

/**
 * A changed binding (N35): a new generation, every credential dropped, the list no longer fresh, back to waiting for its
 * credential. The confirms stay in the snapshot but are pinned to the old generation, so none holds until confirmed again.
 * The same binding changes nothing.
 */
export function rebound(r: ConnectionRecord, next: ConnectionBinding): ConnectionRecord {
  if (sameBinding(r.binding, next)) return r
  return {
    ...r,
    binding: { ...next, era: null, settings: { ...r.binding.settings } },
    generation: r.generation + 1,
    policyRev: r.policyRev + 1,
    key: null,
    client: null,
    token: null,
    refresh: null,
    list: null,
    state: waitingState(next),
  }
}

/** A credential set or replaced (N35): a new generation. `state` is the caller's (the check decides it, N39). */
export function withCredential(r: ConnectionRecord, field: 'key' | 'client' | 'token' | 'refresh', sealed: Envelope | null, state: ConnectionState): ConnectionRecord {
  return { ...r, [field]: sealed, generation: r.generation + 1, state }
}

/** Every credential dropped (a disconnect): a new generation, back to waiting for one. */
export function withoutCredential(r: ConnectionRecord): ConnectionRecord {
  return { ...r, key: null, client: null, token: null, refresh: null, generation: r.generation + 1, list: null, state: waitingState(r.binding) }
}

/** A policy change: pause, trust, the Admin's right or the settings. Bumps `policyRev` only when something changed. */
export function withPolicy(r: ConnectionRecord, change: { paused?: boolean; trusted?: boolean; adminMaySignIn?: boolean; settings?: Record<string, string> }): ConnectionRecord {
  const next: ConnectionRecord = {
    ...r,
    paused: change.paused ?? r.paused,
    trusted: change.trusted ?? r.trusted,
    adminMaySignIn: change.adminMaySignIn ?? r.adminMaySignIn,
    binding: change.settings ? { ...r.binding, settings: { ...change.settings } } : r.binding,
  }
  const changed = next.paused !== r.paused || next.trusted !== r.trusted || next.adminMaySignIn !== r.adminMaySignIn || JSON.stringify(sortedEntries(next.binding.settings)) !== JSON.stringify(sortedEntries(r.binding.settings))
  return changed ? { ...next, policyRev: r.policyRev + 1 } : r
}

const sortedEntries = (o: Record<string, string>) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

/** A snapshot stored (M4-H's caller): refused past 200 tools or 100 confirmed. */
export function withSnapshot(r: ConnectionRecord, tools: ConnectionToolRecord[], list: ConnectionListFreshness): { ok: true; record: ConnectionRecord } | { ok: false; reason: 'snapshot_cap' | 'confirmed_cap' } {
  if (tools.length > CONNECTION_CAPS.snapshotTools) return { ok: false, reason: 'snapshot_cap' }
  if (confirmedCount(tools) > CONNECTION_CAPS.confirmedTools) return { ok: false, reason: 'confirmed_cap' }
  return { ok: true, record: { ...r, tools: tools.map(t => ({ ...t })), list: { ...list } } }
}

/** What a remove leaves: a new generation and policy revision past every in-flight call's, and no credential. */
export function tombstoneOf(r: ConnectionRecord, reason: ConnectionTombstone['reason'], nowMs: number, revoked: boolean): ConnectionTombstone {
  return { v: 3, kind: 'mcp_runtime', accountId: r.accountId, slug: r.slug, removed: true, reason, generation: r.generation + 1, policyRev: r.policyRev + 1, removedAtMs: nowMs, revoked }
}

/** The connection with no credential (contract.ts ConnectionView). */
export function viewOf(r: ConnectionRecord): ConnectionView {
  const b = r.binding
  return {
    accountId: r.accountId,
    slug: r.slug,
    generation: r.generation,
    policyRev: r.policyRev,
    transport: b.transport,
    path: b.path,
    connector: b.connector,
    destinations: b.destinations ? { ...b.destinations, metadata: [...b.destinations.metadata] } : null,
    era: b.era,
    settings: { ...b.settings },
    trusted: r.trusted,
    adminMaySignIn: r.adminMaySignIn,
    paused: r.paused,
    state: r.state,
    list: r.list ? { ...r.list } : null,
  }
}

/** The sync's read (N35): the view, and each tool by name and hash only. */
export function summaryOf(r: ConnectionRecord): ConnectionSummary {
  return { ...viewOf(r), tools: r.tools.map(t => ({ name: t.name, hubName: t.hubName, defHash: t.defHash, mode: t.mode, hidden: t.hidden })) }
}
