// The connection methods of ConnectGateway (Stage 1 M4-R1, N35), as plain functions over the connection objects and the
// index, so the Node project tests them without workerd. oauth/gateway.ts re-exports them; oauth/entry.ts is the
// WorkerEntrypoint over them.
// - `scope.kind` must be `server` on every method (the runner's `run` scope is refused before anything is read).
// - Every request is parsed strictly (index/schemas.ts); the actor rule is the hub's own: the Inhouse team only, except
//   where the contract lets an Admin in (read a connection, its tools, a sign-in, a key). The product checks first too.
// - Prepare writes the record, then the index; remove tombstones the record, then takes the index entry out (index.ts).
// - The methods later packages own delegate to `hooks.ts`'s `methodHooks`, which answer `not_built` until filled.
// - Every object answer is read through `settledAnswer` (copied as plain data and released).
import type {
  CallerScope, ConfirmToolsRequest, ConnectionActor, ConnectionActorKind, ConnectionCredential, ConnectionState, ConnectionSummary, ConnectionTools,
  ConnectionView, DetectResult, HubResult, Instant, PrepareConnectionRequest, UpdateConnectionRequest, WriteToolInfo,
} from '../index/contract'
import { CONNECTION_CAPS } from '../index/contract'
import { err, ok } from '../index/errors'
import { log } from '../index/log'
import {
  CallerScopeSchema, ConfirmToolsRequestSchema, ConnectionRefRequestSchema, DetectRequestSchema, PrepareConnectionRequestSchema, SetCredentialRequestSchema,
  SetTrustedRequestSchema, UpdateConnectionRequestSchema,
} from '../index/schemas'
import type { Registry } from '../registry/registry'
import { settledAnswer } from '../../shared/rpc-answer'
import { bindingRefusal } from './destinations'
import type { MethodHooks } from './hooks'
import type { IndexAdd, IndexEntry } from './index'

/** A connection's own SignIn object, as the gateway calls it. */
export type ConnectionObjectStub = {
  prepareConnection(req: { accountId: string; slug: string; adminMaySignIn: boolean; binding: PrepareConnectionRequest['binding']; memberId: string }): Promise<HubResult<{ view: ConnectionView; fresh: boolean }>>
  getConnection(accountId: string): Promise<HubResult<ConnectionView>>
  updateConnection(req: { accountId: string; ifRev: number; adminMaySignIn?: boolean; settings?: Record<string, string> }): Promise<HubResult<ConnectionView>>
  removeConnection(accountId: string): Promise<HubResult<{ revoked: boolean; generation: number }>>
  abandonConnection(accountId: string, generation: number): Promise<HubResult<{ abandoned: boolean }>>
  connectionSummary(accountId: string): Promise<HubResult<ConnectionSummary>>
  reencrypt(accountId: string): Promise<HubResult<{ kid: string; changed: boolean }>>
}

/** The `__connections__` object. */
export type IndexStub = {
  indexAdd(entry: { accountId: string; slug: string; generation: number }): Promise<HubResult<IndexAdd>>
  indexRemove(accountId: string, upTo: number | null): Promise<HubResult<{ removed: boolean }>>
  indexList(): Promise<HubResult<IndexEntry[]>>
}

export type ConnectionGatewayDeps = {
  registry: Registry
  object(accountId: string): ConnectionObjectStub
  index(): IndexStub
  hooks: MethodHooks
}

const serverScope = (scope: unknown): boolean => {
  const parsed = CallerScopeSchema.safeParse(scope)
  return parsed.success && parsed.data.kind === 'server'
}

/** The scope, the request's shape and the actor's kind, in that order. Null when all hold. */
function refusal<T>(scope: unknown, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, req: unknown, actors: readonly ConnectionActorKind[]): { ok: false; error: HubResult<never> } | { ok: true; req: T } {
  if (!serverScope(scope)) return { ok: false, error: err('invalid_args', 'scope') }
  const parsed = schema.safeParse(req)
  if (!parsed.success) return { ok: false, error: err('invalid_args', 'req') }
  const actor = (parsed.data as { actor: ConnectionActor }).actor
  if (!actors.includes(actor.kind)) return { ok: false, error: err('invalid_args', 'actor') }
  return { ok: true, req: parsed.data }
}

const INHOUSE: readonly ConnectionActorKind[] = ['inhouse']
const ADMIN_OR_INHOUSE: readonly ConnectionActorKind[] = ['admin', 'inhouse']

/** A compiled connector's id or account names the slug (N35's reserved slugs; the schema holds the hub's own names). */
const reservedByRegistry = (registry: Registry, slug: string) => registry.modules.some(m => m.id === slug || m.accountId === slug || m.accountId.split(':')[0] === slug)

/** Route 161: the record (a new generation, untrusted, no credential), then the index (N35). */
export async function prepareConnection(deps: ConnectionGatewayDeps, scope: CallerScope, req: PrepareConnectionRequest): Promise<HubResult<ConnectionView>> {
  const r = refusal(scope, PrepareConnectionRequestSchema, req, INHOUSE)
  if (!r.ok) return r.error
  const { slug, binding, adminMaySignIn, actor } = r.req
  if (reservedByRegistry(deps.registry, slug)) return err('invalid_args', 'slug')
  // M4-P1 builds the connector transport; until then nothing records a binding the hub can't call or check.
  if (binding.transport === 'connector') return err('not_built', 'connector')
  if ((binding.path === 'key') !== (binding.key !== undefined)) return err('invalid_args', 'key')
  const bad = bindingRefusal(binding.destinations)
  if (bad) return err('invalid_args', `destination_${bad.refusal}`)
  const accountId = `mcp:${slug}`
  // A soft check first, so a full brand writes nothing; the index's own transaction is the hard one.
  const listed = await settledAnswer(deps.index().indexList())
  if (!listed.ok) return listed
  if (listed.value.length >= CONNECTION_CAPS.perBrand && !listed.value.some(e => e.accountId === accountId)) return err('invalid_args', 'connections_cap')
  const object = deps.object(accountId)
  const prepared = await settledAnswer(object.prepareConnection({ accountId, slug, adminMaySignIn, binding, memberId: actor.memberId }))
  if (!prepared.ok) return prepared
  const generation = prepared.value.view.generation
  const added = await settledAnswer(deps.index().indexAdd({ accountId, slug, generation }))
  if (!added.ok) return added
  if (added.value === 'cap') {
    // Never listed, never credentialed: abandoned, so the slug may be prepared again later (its generation continues).
    await settledAnswer(object.abandonConnection(accountId, generation))
    return err('invalid_args', 'connections_cap')
  }
  // A remove that landed between the record and the index left a tombstone this listing would show: take it back out
  // (only up to this prepare's generation, so a newer prepare's entry stays).
  const now = await settledAnswer(object.getConnection(accountId))
  if (!now.ok || now.value.generation !== generation) {
    if (!now.ok) await settledAnswer(deps.index().indexRemove(accountId, generation))
    return err('connect_stale', 'removed')
  }
  return ok(prepared.value.view)
}

/** Route 162. */
export async function getConnection(deps: ConnectionGatewayDeps, scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<ConnectionView>> {
  const r = refusal(scope, ConnectionRefRequestSchema, req, ADMIN_OR_INHOUSE)
  if (!r.ok) return r.error
  return settledAnswer(deps.object(r.req.accountId).getConnection(r.req.accountId))
}

/** Route 163: the settings and the Admin's right, against the `policyRev` last read. */
export async function updateConnection(deps: ConnectionGatewayDeps, scope: CallerScope, req: UpdateConnectionRequest): Promise<HubResult<ConnectionView>> {
  const r = refusal(scope, UpdateConnectionRequestSchema, req, INHOUSE)
  if (!r.ok) return r.error
  const { accountId, ifRev, adminMaySignIn, settings } = r.req
  return settledAnswer(deps.object(accountId).updateConnection({ accountId, ifRev, ...(adminMaySignIn !== undefined ? { adminMaySignIn } : {}), ...(settings !== undefined ? { settings } : {}) }))
}

/** Route 171: revokes what it can and tombstones the record, then takes the index entry out (N35). */
export async function removeConnection(deps: ConnectionGatewayDeps, scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<{ revoked: boolean }>> {
  const r = refusal(scope, ConnectionRefRequestSchema, req, INHOUSE)
  if (!r.ok) return r.error
  return removeOne(deps, r.req.accountId)
}

async function removeOne(deps: ConnectionGatewayDeps, accountId: string): Promise<HubResult<{ revoked: boolean }>> {
  const removed = await settledAnswer(deps.object(accountId).removeConnection(accountId))
  if (!removed.ok) return removed
  // Whatever is listed: the object now holds a `removed` tombstone, which no prepare gets past, so no newer entry exists.
  const unlisted = await settledAnswer(deps.index().indexRemove(accountId, null))
  if (!unlisted.ok) return unlisted
  return ok({ revoked: removed.value.revoked })
}

/** The sync's read: every listed connection's summary. A broken or missing one is skipped, never a failed list. */
export async function listConnections(deps: ConnectionGatewayDeps, scope: CallerScope): Promise<HubResult<ConnectionSummary[]>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  const listed = await settledAnswer(deps.index().indexList())
  if (!listed.ok) return listed
  const out: ConnectionSummary[] = []
  for (const e of listed.value) {
    try {
      const s = await settledAnswer(deps.object(e.accountId).connectionSummary(e.accountId))
      if (s.ok) out.push(s.value)
      else log('hub_internal', { accountId: e.accountId, code: `connection_skipped_${s.error.code}` })
    } catch {
      log('hub_internal', { accountId: e.accountId, code: 'connection_skipped_internal' })
    }
  }
  return ok(out)
}

// ---- The methods later packages own (contract.ts names each); each delegates to its hook ----

export async function detectConnection(deps: ConnectionGatewayDeps, scope: CallerScope, req: { actor: ConnectionActor; url: string }): Promise<HubResult<DetectResult>> {
  const r = refusal(scope, DetectRequestSchema, req, INHOUSE)
  return r.ok ? deps.hooks.detectConnection({ deps }, r.req) : r.error
}

export async function setTrusted(deps: ConnectionGatewayDeps, scope: CallerScope, req: { actor: ConnectionActor; accountId: string; trusted: boolean; ifRev: number }): Promise<HubResult<{ trusted: boolean; policyRev: number }>> {
  const r = refusal(scope, SetTrustedRequestSchema, req, INHOUSE)
  return r.ok ? deps.hooks.setTrusted({ deps }, r.req) : r.error
}

export async function startConnectionSignIn(deps: ConnectionGatewayDeps, scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<{ authorizeUrl: string; host: string; expiresAt: Instant }>> {
  const r = refusal(scope, ConnectionRefRequestSchema, req, ADMIN_OR_INHOUSE)
  return r.ok ? deps.hooks.startConnectionSignIn({ deps }, r.req) : r.error
}

/** A hand-registered app (`kind: 'client'`) is the Inhouse team's only (N42). */
export async function setConnectionCredential(deps: ConnectionGatewayDeps, scope: CallerScope, req: { actor: ConnectionActor; accountId: string; credential: ConnectionCredential }): Promise<HubResult<{ state: ConnectionState }>> {
  const r = refusal(scope, SetCredentialRequestSchema, req, ADMIN_OR_INHOUSE)
  if (!r.ok) return r.error
  if (r.req.credential.kind === 'client' && r.req.actor.kind !== 'inhouse') return err('invalid_args', 'actor')
  return deps.hooks.setConnectionCredential({ deps }, r.req)
}

export async function checkConnection(deps: ConnectionGatewayDeps, scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<{ listed: number }>> {
  const r = refusal(scope, ConnectionRefRequestSchema, req, INHOUSE)
  return r.ok ? deps.hooks.checkConnection({ deps }, r.req) : r.error
}

export async function listConnectionTools(deps: ConnectionGatewayDeps, scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<ConnectionTools>> {
  const r = refusal(scope, ConnectionRefRequestSchema, req, ADMIN_OR_INHOUSE)
  return r.ok ? deps.hooks.listConnectionTools({ deps }, r.req) : r.error
}

export async function confirmConnectionTools(deps: ConnectionGatewayDeps, scope: CallerScope, req: ConfirmToolsRequest): Promise<HubResult<{ policyRev: number }>> {
  const r = refusal(scope, ConfirmToolsRequestSchema, req, INHOUSE)
  return r.ok ? deps.hooks.confirmConnectionTools({ deps }, r.req) : r.error
}

export async function listWriteTools(deps: ConnectionGatewayDeps, scope: CallerScope): Promise<HubResult<WriteToolInfo[]>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  return deps.hooks.listWriteTools({ deps })
}

// ---- The walks of the index (ServerGateway, index/index.ts) ----

/** Key rotation: every listed connection's envelopes re-sealed under the current key. One failure doesn't stop the walk. */
export async function reencryptConnections(deps: ConnectionGatewayDeps, scope: CallerScope): Promise<HubResult<{ accountId: string; kid: string | null; changed: boolean; code: string | null }[]>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  const listed = await settledAnswer(deps.index().indexList())
  if (!listed.ok) return listed
  const out: { accountId: string; kid: string | null; changed: boolean; code: string | null }[] = []
  for (const e of listed.value) {
    const r = await settledAnswer(deps.object(e.accountId).reencrypt(e.accountId))
    out.push(r.ok ? { accountId: e.accountId, kid: r.value.kid, changed: r.value.changed, code: null } : { accountId: e.accountId, kid: null, changed: false, code: r.error.code })
  }
  return ok(out)
}

/** Teardown: every listed connection removed (revoked where it can be, tombstoned, unlisted). One failure doesn't stop it. */
export async function teardownConnections(deps: ConnectionGatewayDeps, scope: CallerScope): Promise<HubResult<{ accountId: string; revoked: boolean; code: string | null }[]>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  const listed = await settledAnswer(deps.index().indexList())
  if (!listed.ok) return listed
  const out: { accountId: string; revoked: boolean; code: string | null }[] = []
  for (const e of listed.value) {
    const r = await removeOne(deps, e.accountId)
    out.push(r.ok ? { accountId: e.accountId, revoked: r.value.revoked, code: null } : { accountId: e.accountId, revoked: false, code: r.error.code })
  }
  return ok(out)
}
