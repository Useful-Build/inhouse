// The hooks later packages fill (Stage 1 M4-R1, N35). connectionCall (call.ts), the SignIn object (signin/core.ts) and
// the gateway (gateway.ts) call these and nothing else, so M4-B, M4-O1a, M4-D, M4-H, M4-L and M4-W1 never edit
// app/hub/signin/ or the entry files: each replaces its own entry below. Until then each answers `not_built` (or, for
// `beforeCall`, refuses every read and write), so nothing half built can send.
//
// - credentialFor (M4-B the key, M4-O1a the sign-in): the credential for a call, and its class. Never logged or returned.
// - beforeCall (M4-H): part of the last check, synchronous, on every request; refuses unless mode, generation, the
//   confirmed hash and freshness hold now. A list passes until M4-H says otherwise.
// - afterCall (M4-H): the call's result, with `commit` to store what it learned under the same fence.
// - write (M4-W1): an MCP write, through `send` (exactly one POST; `sent` as call.ts reports it).
// - revoke (M4-O1a): best effort, the credentials a remove or a disconnect took out of the record.
// - methods (gateway side) and objectOps (in the connection's own object): the ConnectGateway methods owned by later
//   packages (contract.ts names each owner).
import type { ConfirmToolsRequest, ConnectionActor, ConnectionCredential, ConnectionState, ConnectionTools, DetectResult, HubErrorCode, HubResult, Instant, WriteToolInfo } from '../index/contract'
import { err } from '../index/errors'
import type { Envelope } from '../crypto/envelope'
import type { KeyRingResult } from '../crypto/keyring'
import type { McpCredential } from '../oauth/http'
import type { GuardedSend } from './send'
import type { CallResult, ConnectionCallRequest, Fence } from './call'
import type { CredentialClass, ResolvePublic } from './destinations'
import type { ConnectionGatewayDeps } from './gateway'
import type { ConnectionBinding, ConnectionRecord } from './record'

export type CredentialForContext = { record: ConnectionRecord; request: ConnectionCallRequest; keyring: () => Promise<KeyRingResult>; nowMs: number }
export type BeforeCallContext = { record: ConnectionRecord; request: ConnectionCallRequest; fence: Fence; nowMs: number }
export type AfterCallContext = {
  record: ConnectionRecord
  request: ConnectionCallRequest
  fence: Fence
  result: CallResult
  /** Writes a change to the record if the fence still holds (one synchronous step); null when it broke. */
  commit(change: (r: ConnectionRecord) => ConnectionRecord): ConnectionRecord | null
}
export type WriteContext = { record: ConnectionRecord; request: Extract<ConnectionCallRequest, { kind: 'write' }>; fence: Fence; send(): Promise<CallResult> }
export type RevokeContext = {
  accountId: string
  binding: ConnectionBinding
  captured: { key: Envelope | null; client: Envelope | null; token: Envelope | null; refresh: Envelope | null }
  keyring: () => Promise<KeyRingResult>
  /** The guarded sender (send.ts) over the removed binding's destinations: a revocation goes only to `revoke`. */
  send: GuardedSend
  /** The DNS half of the address check (destinations.ts). */
  resolvePublic: ResolvePublic
}

export type ConnectionHooks = {
  credentialFor(ctx: CredentialForContext): Promise<HubResult<{ credential: McpCredential; cls: Extract<CredentialClass, 'key' | 'access_token'> }>>
  beforeCall(ctx: BeforeCallContext): HubErrorCode | null
  afterCall(ctx: AfterCallContext): Promise<CallResult>
  write(ctx: WriteContext): Promise<CallResult>
  revoke(ctx: RevokeContext): Promise<boolean>
}

export const connectionHooks: ConnectionHooks = {
  credentialFor: async ctx => err('not_built', ctx.record.binding.path === 'key' ? 'credentialFor:key' : 'credentialFor:signin'),
  beforeCall: ctx => (ctx.request.kind === 'list' ? null : 'not_built'),
  afterCall: async ctx => ctx.result,
  write: async () => ({ ok: false, error: { code: 'not_built', message: 'not built yet: write' }, sent: 'no' }),
  // A sign-in's tokens are revoked by M4-O1a; until then a record holding one reports it unrevoked. A key or a client
  // has nothing to revoke at the server: dropping it from the record is the whole removal.
  revoke: async ctx => ctx.captured.token === null && ctx.captured.refresh === null,
}

/** What a gateway-side method hook gets: the gateway's deps (registry, objects, index) and the parsed request. */
export type MethodHookContext = { deps: ConnectionGatewayDeps }

/** The ConnectGateway methods later packages own. Each gets a `server` scope's parsed request, its actor already checked. */
export type MethodHooks = {
  detectConnection(ctx: MethodHookContext, req: { actor: ConnectionActor; url: string }): Promise<HubResult<DetectResult>>
  setTrusted(ctx: MethodHookContext, req: { actor: ConnectionActor; accountId: string; trusted: boolean; ifRev: number }): Promise<HubResult<{ trusted: boolean; policyRev: number }>>
  startConnectionSignIn(ctx: MethodHookContext, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<{ authorizeUrl: string; host: string; expiresAt: Instant }>>
  setConnectionCredential(ctx: MethodHookContext, req: { actor: ConnectionActor; accountId: string; credential: ConnectionCredential }): Promise<HubResult<{ state: ConnectionState }>>
  checkConnection(ctx: MethodHookContext, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<{ listed: number }>>
  listConnectionTools(ctx: MethodHookContext, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<ConnectionTools>>
  confirmConnectionTools(ctx: MethodHookContext, req: ConfirmToolsRequest): Promise<HubResult<{ policyRev: number }>>
  listWriteTools(ctx: MethodHookContext): Promise<HubResult<WriteToolInfo[]>>
}

export const methodHooks: MethodHooks = {
  detectConnection: async () => err('not_built', 'detectConnection'),
  setTrusted: async () => err('not_built', 'setTrusted'),
  startConnectionSignIn: async () => err('not_built', 'startConnectionSignIn'),
  setConnectionCredential: async () => err('not_built', 'setConnectionCredential'),
  checkConnection: async () => err('not_built', 'checkConnection'),
  listConnectionTools: async () => err('not_built', 'listConnectionTools'),
  confirmConnectionTools: async () => err('not_built', 'confirmConnectionTools'),
  listWriteTools: async () => err('not_built', 'listWriteTools'),
}

/** What an operation inside a connection's own object gets (the SignIn object's `connectionOp`). */
export type ObjectOpContext = {
  accountId: string
  /** The record now (null: none, or a tombstone). Synchronous. */
  read(): ConnectionRecord | null
  /**
   * Writes a change under a fence, in one synchronous step; null when the record changed or went (call.ts `changeCode`).
   * Pause doesn't stop it: only calls stop on pause.
   */
  commit(fence: Fence, change: (r: ConnectionRecord) => ConnectionRecord): ConnectionRecord | null
  now(): number
  keyring(): Promise<KeyRingResult>
  /**
   * The guarded sender (send.ts) over the record's destinations as they are at each send (M4-D's check, M4-O1a's sign-in
   * legs, M4-B's key check). Never the raw upstream.
   */
  send: GuardedSend
  /** The DNS half of the address check (destinations.ts). */
  resolvePublic: ResolvePublic
  call(req: ConnectionCallRequest): Promise<CallResult>
}

/** Operations later packages run inside a connection's object (a trust flip, a confirm, a credential's save). None yet. */
export type ObjectOps = Readonly<Record<string, (ctx: ObjectOpContext, req: unknown) => Promise<HubResult<unknown>>>>

export const objectOps: ObjectOps = {}
