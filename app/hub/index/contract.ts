// The hub's service binding contract (P4 H0). Plain TypeScript types only, no zod-inferred types and no imports, so
// the product Worker can `import type` this file without the hub's dependencies. schemas.ts mirrors every type here
// with zod, and schemas.test.ts asserts the two agree.

/** C1's time format. */
export type Instant = { iso: string; ms: number }

/** Who is calling. Scope fields are for logs; the read/write decision is structural (which entrypoint was bound). */
export type CallerScope =
  | { kind: 'run'; runId: string; principalId: string; requestId: string } // the runner, through H1's egress route
  | { kind: 'server'; job: string; requestId: string } // product Worker code

export type HubErrorCode =
  | 'invalid_args'
  | 'unknown_tool'
  | 'write_refused'
  | 'not_configured'
  | 'credentials_rejected'
  | 'scope_mismatch'
  | 'key_unavailable'
  | 'upstream_unavailable'
  | 'upstream_rejected'
  | 'upstream_version_mismatch'
  | 'rate_limited'
  | 'result_too_large'
  | 'internal'
  // P5 (p5-w1): the connect flow and pause.
  | 'state_invalid'
  | 'workspace_mismatch'
  | 'connect_stale'
  | 'connect_refused'
  | 'paused'

/** `message` is a fixed text per code plus safe names. Never an upstream body, header, token, secret or argument. */
export type HubError = { code: HubErrorCode; message: string; retryAfterMs?: number }

export type HubResult<T> = { ok: true; value: T } | { ok: false; error: HubError }

export type ToolInfo = { name: string; connector: string; description: string; inputSchema: Record<string, unknown> }

export type SignInState = 'empty' | 'active' | 'failed' | 'disconnected'

export type AccountStatus = {
  accountId: string
  state: SignInState
  kid: string | null
  expiresAt: Instant | null
  scopes: string[]
  lastError: { code: HubErrorCode; at: Instant } | null
  // P5 (p5-w1)
  paused: boolean
  kind: 'client_credentials' | 'oauth_mcp'
  connectedBy: string | null
  connectedAt: Instant | null
  revokeFailedAt: Instant | null
  /** An OAuth account whose stored grant no longer equals the requested scopes, or whose token was rejected. */
  needsReconnect: boolean
}

/** One row per account id (two modules naming one account give one row). */
export type AccountSummary = { accountId: string; connector: string; configured: boolean; status: AccountStatus }

/** Bound by the runner's egress route (H1) and by product server code that reads. Lists and runs read tools only. */
export interface ReadGateway {
  listTools(scope: CallerScope): Promise<HubResult<ToolInfo[]>>
  callTool(scope: CallerScope, name: string, args: unknown): Promise<HubResult<{ data: unknown }>>
}

/** Product Worker server code only. H1's egress route never holds this binding. */
export interface ServerGateway {
  status(scope: CallerScope, accountId: string): Promise<HubResult<AccountStatus>>
  reencrypt(scope: CallerScope, accountId: string): Promise<HubResult<{ kid: string; changed: boolean }>>
}

/**
 * Product Worker server code only (P5 W1). Re-exported from index.ts by an orchestrator line. `scope.kind` must be
 * `server` on every method. Nothing here returns a token, code, verifier, client secret or upstream body.
 */
export interface ConnectGateway {
  startConnect(scope: CallerScope, req: { accountId: string; memberId: string }): Promise<HubResult<{ authorizeUrl: string; expiresAt: Instant }>>
  completeConnect(scope: CallerScope, req: { state: string; code: string; memberId: string }): Promise<HubResult<{ accountId: string }>>
  /** The AS answered `?error=`: consume the state and record it. The error value is never echoed. */
  failConnect(scope: CallerScope, req: { state: string; memberId: string; error: string }): Promise<HubResult<{ accountId: string | null }>>
  disconnect(scope: CallerScope, accountId: string): Promise<HubResult<{ revoked: boolean }>>
  setPaused(scope: CallerScope, accountId: string, paused: boolean): Promise<HubResult<{ paused: boolean }>>
  listAccounts(scope: CallerScope): Promise<HubResult<AccountSummary[]>>
}
