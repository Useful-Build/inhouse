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
}

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
