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

/**
 * A read call's options. `testShopHost` is the test and eval builds' shop override (the morning-check set, P4): the Shopify
 * host (`<handle>.myshopify.com`) this one call reads instead of the hub's SHOPIFY_SHOP. Only the product Worker's test and
 * eval builds ever send it (server/egress/test-shop.ts); a hub honours it only when built for tests (`__INHOUSE_HUB_TEST__`
 * and INHOUSE_TEST_BUILD=1) and only for a host its test seam registers (hub/testing/index.ts). Anything else is refused
 * (`invalid_args`), never read from SHOPIFY_SHOP instead.
 */
export type CallToolOptions = { testShopHost?: string }

/** Bound by the runner's egress route (H1) and by product server code that reads. Lists and runs read tools only. */
export interface ReadGateway {
  listTools(scope: CallerScope): Promise<HubResult<ToolInfo[]>>
  callTool(scope: CallerScope, name: string, args: unknown, options?: CallToolOptions): Promise<HubResult<{ data: unknown }>>
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
  /**
   * `options.testShopHost` (P5 #337, test and eval builds only, as ReadGateway.callTool's): a Shopify account's row comes
   * from that test shop's own SignIn object (granted first), the one the turn's reads will use. Refused elsewhere.
   */
  listAccounts(scope: CallerScope, options?: CallToolOptions): Promise<HubResult<AccountSummary[]>>
  /**
   * TEST BUILD ONLY, optional (W5's test-fakes hook, the product's `POST /api/ops/test-fakes`): reads and flips the
   * fake upstreams in the hub's test bundle (hub/testing/fakes.ts). A `server` scope only. The deployable hub answers
   * `not_configured` and loads nothing (scripts/check-hub-build.mjs proves the module absent). No product code but
   * the test build's hook calls it.
   */
  testFakes?(scope: CallerScope, op: unknown): Promise<HubResult<unknown>>
}

// ---- P5 (p5-w4): notices to listed Slack channels ----

/** The app link kinds (app/shared/notify/links.ts `LINK_KINDS`, written out here; a hub test checks they agree). */
export type NoticeLinkKind = 'approval' | 'chat' | 'today' | 'activity' | 'routine'

export type SlackChannel = { id: string; name: string; isMember: boolean; shared: boolean; archived: boolean; private: boolean }

export type PostNoticeRequest = {
  accountId: 'slack:workspace'
  channelId: string
  /** Bounded but unescaped (the hub escapes once). */
  title: string
  text: string
  link?: { kind: NoticeLinkKind; id?: string }
  /** The server's notice id, `n_` + 128 random bits. */
  noticeId: string
}

/**
 * Product Worker server code only (P5 W4), bound as `HUB_DELIVERY`; re-exported from index.ts by an orchestrator line.
 * `scope.kind` must be `server`. A refused channel is `connect_refused` with one of `shared_channel`, `archived`,
 * `not_public`, `not_member`, `not_found` after the message's `: `. Nothing here returns a token or an upstream body.
 */
export interface DeliveryGateway {
  postNotice(scope: CallerScope, req: PostNoticeRequest): Promise<HubResult<{ ts: string }>>
  listChannels(scope: CallerScope, req: { accountId: 'slack:workspace'; cursor?: string }): Promise<HubResult<{ channels: SlackChannel[]; nextCursor: string | null }>>
  checkChannel(scope: CallerScope, req: { accountId: 'slack:workspace'; channelId: string }): Promise<HubResult<SlackChannel>>
}
