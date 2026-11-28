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
  // Stage 1 M4 (M4-A; N35 to N51): connections by address.
  /** A key connection whose key is missing or was refused on use: "Needs a new key" (N42). */
  | 'needs_key'
  /** The tool's definition isn't the confirmed one now (a changed hash, a stale generation or `policyRev`): N43, N46. */
  | 'definition_changed'
  /** The server asked for input mid-call (MCP `input_required` with a question); the hub declares no way to answer (N36). */
  | 'needs_input'
  /** Another tool's data in a call toward an untrusted connection (N49): refused before anything is sent. */
  | 'leak'
  /** The login server refused our client (`invalid_client` and the like): the login is kept, the team fixes the app (N41). */
  | 'client_fault'
  /** A route or method M4 landed before the package that fills it (N35's hooks, section 1's route rows). */
  | 'not_built'
  /** Connections are switched off in this build (`CONNECTIONS_ON = false`, N51). */
  | 'connections_off'

/** `message` is a fixed text per code plus safe names. Never an upstream body, header, token, secret or argument. */
export type HubError = { code: HubErrorCode; message: string; retryAfterMs?: number }

export type HubResult<T> = { ok: true; value: T } | { ok: false; error: HubError }

/**
 * Whose word a tool's data is (Stage 1 M4, N49), the hub's alone: `own` for the brand's compiled connectors (Shopify,
 * Slack), `trusted` or `untrusted` for a runtime connection (default `untrusted`; only the Inhouse team flips it).
 */
export type ToolTrust = 'own' | 'trusted' | 'untrusted'

/**
 * `source` and `trust` (Stage 1 M4, N44, N49): the hub account the tool reads (`shopify`, `slack:workspace`,
 * `mcp:<slug>`) and the hub's word on it. M4-T fills both on every listed tool; until then the hub leaves them out, and
 * a reader takes a missing `trust` as `untrusted` (fail closed).
 */
export type ToolInfo = { name: string; connector: string; description: string; inputSchema: Record<string, unknown>; source?: string; trust?: ToolTrust }

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
  /** `mcp_runtime` (Stage 1 M4, N35): a connection by address, `mcp:<slug>`, its record version 3. */
  kind: 'client_credentials' | 'oauth_mcp' | 'mcp_runtime'
  connectedBy: string | null
  connectedAt: Instant | null
  revokeFailedAt: Instant | null
  /** An OAuth account whose stored grant no longer equals the requested scopes, or whose token was rejected. */
  needsReconnect: boolean
}

/**
 * One row per account id (two modules naming one account give one row). `shop` (Stage 1 M2-D): for the Shopify account
 * only, the handle of the store the write app writes to (`<handle>` of `<handle>.myshopify.com`, a deployment var, not a
 * secret), when one is configured. The product keeps it as the permission scope's `{ shop }`; absent, a write is refused.
 * `currency` (Stage 1 M3-S2, N21): for the Shopify account only, the write store's currency (ISO 4217, upper case), as
 * Shopify's `shop.currencyCode` names it, when the hub has read it. The product copies it like the handle; a refund in any
 * other currency is refused at `resolve`, and absent, every refund is.
 */
export type AccountSummary = { accountId: string; connector: string; configured: boolean; status: AccountStatus; shop?: string; currency?: string }

/**
 * A read call's options. `testShopHost` is the test and eval builds' shop override (the morning-check set, P4): the Shopify
 * host (`<handle>.myshopify.com`) this one call reads instead of the hub's SHOPIFY_SHOP. Only the product Worker's test and
 * eval builds ever send it (server/egress/test-shop.ts); a hub honours it only when built for tests (`__INHOUSE_HUB_TEST__`
 * and INHOUSE_TEST_BUILD=1) and only for a host its test seam registers (hub/testing/index.ts). Anything else is refused
 * (`invalid_args`), never read from SHOPIFY_SHOP instead.
 */
export type CallToolOptions = { testShopHost?: string } & M4CallOptions

/**
 * Stage 1 M4's call options (M4-A), kept apart so `CallToolOptions`'s first line stays as
 * scripts/check-product-build.test.mjs reads it.
 */
export type M4CallOptions = {
  /**
   * Stage 1 M4 (N48, M4-K3): a `code_run` call BrandAgent admitted (the main agent, this live turn, this input's hash), so
   * a write tool in the script records a proposal instead of throwing. Never set for a helper or a run with no `actions`
   * server. The hub refuses it (`invalid_args`) until M4-K3 builds proposals.
   */
  propose?: boolean
  /**
   * Stage 1 M4 (N44, M4-T): `listTools` resolves this one tool's connection from its slug and asks only that object (the
   * egress's per-call "listed now" check). Until M4-T builds the lookup the hub doesn't read it and lists every tool (a
   * superset, so a "listed now" check still holds). `callTool` refuses it (`invalid_args`).
   */
  name?: string
}

/** Stage 1 M4 (N48): the most proposals, and the most records across them, one script records. */
export const SCRIPT_PROPOSALS_MAX = { proposals: 50, records: 500 } as const

/**
 * Stage 1 M4 (N48): one write a script proposed instead of running: the write tool's name as the `actions` server lists
 * it (an operation entry's `tool`, or a confirmed MCP write tool's `hubName`) and the arguments, unchecked. The product
 * resolves each one exactly as it would the same call from the model; nothing here is trusted.
 */
export type ScriptProposal = { tool: string; args: unknown }

/**
 * `proposals` (Stage 1 M4, N48): only on a `code_run` call with `options.propose`, and only when the script finished
 * cleanly; in its own field, apart from `data`, so nothing a script returns can be read as one. Absent otherwise.
 */
export type CallToolValue = { data: unknown; proposals?: ScriptProposal[] }

/** Bound by the runner's egress route (H1) and by product server code that reads. Lists and runs read tools only. */
export interface ReadGateway {
  listTools(scope: CallerScope, options?: CallToolOptions): Promise<HubResult<ToolInfo[]>>
  callTool(scope: CallerScope, name: string, args: unknown, options?: CallToolOptions): Promise<HubResult<CallToolValue>>
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
  /**
   * Stage 1 M4 (N40; #674): `actorKind`, who finished the sign-in (the pending item binds it), and `iss`, every `iss`
   * value the return carried, in order, or null when it carried none (two: a doubled `iss`, refused). M4-O1a checks
   * them (a present `iss` against the issuer it recorded, on success and on error, before anything else is trusted) and
   * makes both required here; until then the hub reads neither, as it read no `iss` before M4. They are optional here
   * only because the hub's own test callers live under `app/hub/testing/` (Lane 4); the product's caller is held to
   * `ConnectReturn` (server/api/connect.ts `ConnectBinding`), and the hub parses them with `ConnectReturnSchema`.
   */
  completeConnect(scope: CallerScope, req: { state: string; code: string; memberId: string } & Partial<ConnectReturn>): Promise<HubResult<{ accountId: string }>>
  /** The AS answered `?error=`: consume the state and record it. The error value is never echoed. `actorKind`, `iss`: as `completeConnect`'s. */
  failConnect(scope: CallerScope, req: { state: string; memberId: string; error: string } & Partial<ConnectReturn>): Promise<HubResult<{ accountId: string | null }>>
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
  /**
   * Stage 1 M3 (card details, #488): what an approval card shows beside a write's ids, read from the write store with the
   * write app's token (never the read app's, which holds no `read_customers`). A `server` scope only; the product's
   * outbox asks it at request time, through BrandAgent. Test build only, as the writes are: the deployable hub answers
   * `not_configured` and reads nothing. Display-only: the product never hands these strings to the agent.
   */
  cardFacts(scope: CallerScope, req: CardFactsRequest): Promise<HubResult<CardFacts>>

  // ---- Stage 1 M4 (M4-A freezes them; M4-R1 lands each as a hook that answers `not_built` until its owner fills it) ----
  // A `server` scope only, as every method here. `req.actor` is who acts, as the product checked them; the hub enforces
  // its own part too (an Admin only where `adminMaySignIn` is on and the connection waits for that login, N40). A
  // refusal from detect or the check is `connect_refused` with one of M4-D's reasons after the message's `: ` (N38).
  // Nothing here returns a credential, a code, a verifier or an upstream body.

  /** Route 160 (M4-D): asks the address with no credential (N37). Inhouse team only. */
  detectConnection(scope: CallerScope, req: { actor: ConnectionActor; url: string }): Promise<HubResult<DetectResult>>
  /** Route 161 (M4-R2): writes the record (a new generation, untrusted, no credential), then the index (N35). Inhouse team only. */
  prepareConnection(scope: CallerScope, req: PrepareConnectionRequest): Promise<HubResult<ConnectionView>>
  /** Route 162. */
  getConnection(scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<ConnectionView>>
  /** Route 163 (M4-R2): the settings and the Admin's right; `ifRev` is the `policyRev` last read. Inhouse team only. */
  updateConnection(scope: CallerScope, req: UpdateConnectionRequest): Promise<HubResult<ConnectionView>>
  /** Route 164 (M4-L): trust, audited, bumps `policyRev` (N49). Inhouse team only. */
  setTrusted(scope: CallerScope, req: { actor: ConnectionActor; accountId: string; trusted: boolean; ifRev: number }): Promise<HubResult<{ trusted: boolean; policyRev: number }>>
  /** Route 165 (M4-O1a, M4-X): starts a sign-in on a connection that waits for one. `host`: the authorize address's host, named on the screen first. */
  startConnectionSignIn(scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<{ authorizeUrl: string; host: string; expiresAt: Instant }>>
  /**
   * Route 166 (M4-B, M4-X): a key, or (Inhouse team only) a hand-registered app's id and secret. Checked before it's
   * saved (N39); a replacement only after its own check. Never logged, audited or answered.
   */
  setConnectionCredential(scope: CallerScope, req: { actor: ConnectionActor; accountId: string; credential: ConnectionCredential }): Promise<HubResult<{ state: ConnectionState }>>
  /** Route 167 (M4-D): the connection check (N39), with the credential the record holds. Inhouse team only. */
  checkConnection(scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<{ listed: number }>>
  /** Route 168 (M4-H): the stored snapshot, never a live list (N43). */
  listConnectionTools(scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<ConnectionTools>>
  /** Route 169 (M4-H): each tool by name, hash and generation, with `ifRev` (N43). Inhouse team only. */
  confirmConnectionTools(scope: CallerScope, req: ConfirmToolsRequest): Promise<HubResult<{ policyRev: number }>>
  /** Route 171 (M4-R2): revokes what it can, removes the record, then the index (N35). Inhouse team only. */
  removeConnection(scope: CallerScope, req: { actor: ConnectionActor; accountId: string }): Promise<HubResult<{ revoked: boolean }>>
  /** The sync's read (M4-R2, M4-H): every connection the index lists, each tool by name and hash only. A broken one is skipped. */
  listConnections(scope: CallerScope): Promise<HubResult<ConnectionSummary[]>>
  /**
   * N46 (M4-W1): every confirmed `write` tool of a live, unpaused connection, read now, for the `actions` server's list.
   * The product sets a write's connection, tool, `defHash`, `generation` and `policyRev` from this, never from a request.
   */
  listWriteTools(scope: CallerScope): Promise<HubResult<WriteToolInfo[]>>
}

// ---- Stage 1 M4 (M4-A): connections by address (N35 to N46) ----

/** Stage 1 M4 (N35): the caps. */
export const CONNECTION_CAPS = { perBrand: 20, snapshotTools: 200, confirmedTools: 100 } as const

/**
 * Stage 1 M4 (N40, #674): what a sign-in's return forwards to the hub, both always: who finished it, and every `iss`
 * value it carried, in order, or null for none. An explicit null, never a missing field.
 */
export type ConnectReturn = { actorKind: ConnectionActorKind; iss: string[] | null }

/** Who acts on a connection: the Inhouse team or one of the brand's Admins. A Member never reaches the hub. */
export type ConnectionActorKind = 'inhouse' | 'admin'
export type ConnectionActor = { kind: ConnectionActorKind; memberId: string }

/**
 * Where a connection stands, the hub's word (N35, N40, N42, N43). `waiting_signin` and `waiting_key`: prepared, no
 * credential yet. `needs_review`: a credential works, no tool confirmed yet. `live`: at least one tool confirmed.
 * `sign_in_again`: the login ended or needs a wider scope ("Sign in again"). `needs_key`: the key was refused on use
 * ("Needs a new key"). `unavailable`: the list is stale and can't be refreshed, so calls are blocked. Pause is apart.
 */
export type ConnectionState = 'waiting_signin' | 'waiting_key' | 'needs_review' | 'live' | 'sign_in_again' | 'needs_key' | 'unavailable'

/** How the hub reaches it: an MCP address, or a built connector's code the hub loads with no network (N50). */
export type ConnectionTransport = 'https' | 'connector'
/** Which credential it takes: none (open), a sign-in, or a key (N37, N42). */
export type ConnectionPath = 'none' | 'signin' | 'key'
/** Which MCP era answered (N36): the 2026-07-28 protocol, or 2025-11-25's `initialize`. Null before one answered. */
export type ConnectionEra = 'modern' | 'legacy'

/**
 * Every address a connection may reach, by purpose (N35), each exact (scheme, host, port, path). A key or an access
 * token goes only to `mcp`; a client secret, a refresh token and a code only to `token`; nothing to the rest.
 */
export type ConnectionDestinations = {
  mcp: string
  metadata: string[]
  issuer: string | null
  authorize: string | null
  token: string | null
  registration: string | null
  revoke: string | null
}

/** Detect's six outcomes (N37). */
export type DetectOutcome = 'open' | 'signin' | 'signin_needs_app' | 'key' | 'blocked' | 'not_mcp'
/** `reason`: one of M4-D's fixed codes (N38) when the outcome refuses (`blocked`, `not_mcp`), else null. Never a body. */
export type DetectResult = { outcome: DetectOutcome; reason: string | null; era: ConnectionEra | null; destinations: ConnectionDestinations }

/** Where a key goes on the request (N42): a header name and a prefix (`Bearer `). */
export type ConnectionKeyPlace = { header: string; prefix: string }

/**
 * What the Inhouse team confirmed at prepare (N35): an address with the destinations detect found, or a built
 * connector by its id (its hosts come from its own config, N50). `settings`: a known server's manifest settings (N39).
 */
export type ConnectionBindingInput =
  | { transport: 'https'; path: ConnectionPath; destinations: ConnectionDestinations; key?: ConnectionKeyPlace; settings: Record<string, string> }
  | { transport: 'connector'; connector: string; settings: Record<string, string> }

/** Route 161. `slug` names the account (`mcp:<slug>`) and its tools' `hubName`s; it is never reused after a remove. */
export type PrepareConnectionRequest = { actor: ConnectionActor; slug: string; adminMaySignIn: boolean; binding: ConnectionBindingInput }

/** Route 163. Each field left out stays as it is; any change bumps `policyRev`. */
export type UpdateConnectionRequest = { actor: ConnectionActor; accountId: string; ifRev: number; adminMaySignIn?: boolean; settings?: Record<string, string> }

/** Route 166's credential (N42). `client` is the Inhouse team's only. */
export type ConnectionCredential = { kind: 'key'; key: string } | { kind: 'client'; clientId: string; clientSecret: string | null }

/** How fresh the stored list is (N43). Null before a complete list was stored. */
export type ConnectionListFreshness = { fetchedAtMs: number; ttlMs: number; complete: boolean }

/**
 * One connection as the hub holds it, with no credential (N35). `generation` is new on prepare and on any binding or
 * credential change; `policyRev` rises with a confirm, a trust flip, pause and a settings change.
 */
export type ConnectionView = {
  accountId: string
  slug: string
  generation: number
  policyRev: number
  transport: ConnectionTransport
  path: ConnectionPath
  /** A built connector's id (`transport: 'connector'`), else null. */
  connector: string | null
  /** An address's destinations; null for a built connector (its hosts are its own config, N50). */
  destinations: ConnectionDestinations | null
  era: ConnectionEra | null
  settings: Record<string, string>
  trusted: boolean
  adminMaySignIn: boolean
  paused: boolean
  state: ConnectionState
  list: ConnectionListFreshness | null
}

/** A tool's review state (N43): `new` until the Inhouse team confirms it, and never listed while it is. */
export type ConnectionToolMode = 'new' | 'read' | 'write' | 'off'
/** Why a tool is hidden (N43): its hash isn't the confirmed one, it left the list, or it's outside the bounds. */
export type ConnectionToolHidden = 'changed' | 'gone' | 'rejected'

/**
 * One tool of the stored snapshot (N43, N45), for the reviewer: exactly the text the model will see. `name` is the
 * server's (what the wire carries); `hubName` ours (`<slug>_<tool>`, at most 50). `readOnlyHint`: the server's own
 * label, a hint only. `confirmedHash`: the hash the mode was confirmed for, null while `new`.
 */
export type ConnectionTool = {
  name: string
  hubName: string
  title: string | null
  description: string
  inputSchema: Record<string, unknown>
  defHash: string
  mode: ConnectionToolMode
  confirmedHash: string | null
  hidden: ConnectionToolHidden | null
  readOnlyHint: boolean | null
}

/** Route 168's answer. */
export type ConnectionTools = { generation: number; policyRev: number; list: ConnectionListFreshness | null; tools: ConnectionTool[] }

/** Route 169: each tool by name and the hash the reviewer saw, for this generation. */
export type ConfirmToolsRequest = {
  actor: ConnectionActor
  accountId: string
  generation: number
  ifRev: number
  tools: { name: string; defHash: string; mode: 'read' | 'write' | 'off' }[]
}

/** One connection as the sync reads it (N35): the view, and each tool by name and hash only (no text, no schema). */
export type ConnectionSummary = ConnectionView & {
  tools: { name: string; hubName: string; defHash: string; mode: ConnectionToolMode; hidden: ConnectionToolHidden | null }[]
}

/**
 * One confirmed `write` tool (N46): what the `actions` server lists and what a write pins. `name` is the server's tool,
 * `hubName` the name the agent calls. `trusted`: the leak rule's word (N49).
 */
export type WriteToolInfo = {
  accountId: string
  name: string
  hubName: string
  description: string
  inputSchema: Record<string, unknown>
  defHash: string
  generation: number
  policyRev: number
  trusted: boolean
}

// ---- Stage 1 M3 (card details, #488): the facts an approval card shows ----

/** The most order and variant ids one `cardFacts` call names (a tag call's 100 orders; a draft order's 20 variants). */
export const CARD_FACTS_MAX = { orders: 100, variants: 20 } as const

/**
 * `expect` is the write account's generation and store, as a write's (`WriteRequest.expect`): a store or connection that
 * changed since is refused, so a card never shows another store's customers.
 */
export type CardFactsRequest = {
  accountId: 'shopify:store'
  expect: { connectedAtMs: number; shop: string }
  orderIds: string[]
  variantIds: string[]
}

/**
 * One order as the card shows it: its name ("#3901"), its customer's display name (null for a guest order, a deleted
 * customer, or a write app without `read_customers`) and its current total in the shop's currency (Shopify's decimal
 * string). `found: false`: no order has that id (deleted, or never existed).
 */
export type CardOrderFacts =
  | { id: string; found: true; name: string; customer: string | null; total: { amount: string; currencyCode: string } | null }
  | { id: string; found: false }

/** One product variant: its product's title, its own title and its SKU. `found: false`: no variant has that id. */
export type CardVariantFacts =
  | { id: string; found: true; product: string; variant: string; sku: string | null }
  | { id: string; found: false }

/**
 * Upstream text, capped (`CARD_FACTS_CAPS`) and otherwise as Shopify holds it: the product runs its own text rules on
 * every string before it stores one. A list is `null` when it wasn't read: none asked, or (variants) the write app lacks
 * `read_products`. Orders need only `write_orders` (it grants reads); their customers need `read_customers` as well,
 * and Shopify's protected customer data access for the name.
 */
export type CardFacts = { orders: CardOrderFacts[] | null; variants: CardVariantFacts[] | null }

/** The longest string `cardFacts` answers, in UTF-8 bytes of its JSON (as the read tools' caps). */
export const CARD_FACTS_CAPS = { orderName: 40, customer: 120, product: 120, variant: 40, sku: 64 } as const

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

// ---- Stage 1 M2 (W0-A): the write entrypoint's contract (N13). M2-C builds it. ----

/**
 * The writes the hub runs (M2's two; Stage 1 M3 adds one line per operation, a shared entry file). The server's operation
 * table is typed `Record<WriteOperationKey, OperationEntry>`.
 */
export const WRITE_OPERATIONS = [
  'shopify.order.tag_add',
  'slack.channel.post',
  'shopify.order.tag_remove', // M3-S1
  'shopify.draft_order.create', // M3-S1
  'shopify.inventory.restock', // M3-S2
  'shopify.inventory.reduce', // M3-S2
  'shopify.refund.create', // M3-S2
] as const
export type WriteOperationKey = (typeof WRITE_OPERATIONS)[number]

/**
 * One send from the outbox dispatcher (`app/server/outbox/dispatch.ts`, the only holder of `HUB_WRITE`). `actionId` and
 * `attempt` name the outbox row and its claim; `expect.connectedAtMs` is the account generation the action was approved
 * on (the hub refuses when it changed). `expect.shop` (Stage 1 M2-G, from #444's review): for a Shopify write, the store
 * handle the action was approved for (its permission scope); the hub refuses when its write app now points at another
 * store, even with no request since. `args` is checked per operation by the hub, strictly.
 *
 * Stage 1 M3 (M3-A, N22 and N21):
 * - `item`: one item of a batch, `n` of `of` (1-based; `of` is the batch's `approved_upto`, at most the ceiling's
 *   `batch_max`, 500); `requestId` is then `<actionId>:<n>` and `args` are that item's own arguments (one hub call per
 *   item). Absent for a single action.
 * - `idempotencyKey`: the upstream idempotency key, `<actionId>:<n>` (`n` = 1 for a single action), the same on every
 *   attempt, so a person's later "try again" can't apply twice. Sent for an operation whose mutation takes one
 *   (`inventoryAdjustQuantities`, `refundCreate`); the hub ignores it elsewhere. Never a reason to resend by itself.
 *
 * Stage 1 M4 (N46): `expect.generation`, `expect.defHash` and `expect.policyRev` pin an MCP write to the connection's
 * generation, the tool's confirmed hash and the connection's policy revision it was approved under; the hub checks all
 * three against the record at the send (a change is `sent: 'no'`). All three or none.
 */
export type WriteRequest = {
  actionId: string
  attempt: number
  requestId: string
  accountId: string
  expect: { connectedAtMs: number; shop?: string; generation?: number; defHash?: string; policyRev?: number }
  operation: WriteOperationKey
  args: unknown
  item?: { n: number; of: number }
  idempotencyKey?: string
}

/**
 * `value.ref` is a safe ref only (tag names, a channel name, a message time), never an upstream body. `sent: 'no'` only
 * when the hub is sure nothing went out; everything else is `'unknown'`.
 *
 * Throttled (Stage 1 M3, N22): an upstream that throttled the call and ran nothing (Shopify's `THROTTLED`, HTTP 429) is
 * `{ code: 'rate_limited', retryAfterMs?, sent: 'no' }`. `retryAfterMs` is optional (Shopify's GraphQL `THROTTLED` names
 * no wait) and, when present, a whole number of milliseconds up to a day. The batch tries that item again after
 * `THROTTLE_WAIT_MS.default` when it's absent, and clamps any value to `THROTTLE_WAIT_MS.min` to `.max`. A throttle
 * that may have run something is `sent: 'unknown'` like any other unclear answer.
 */
export type WriteResult = { ok: true; value: { ref: string } } | { ok: false; error: HubError; sent: 'no' | 'unknown' }

/** Stage 1 M3 (N22): how long a batch waits before it tries a throttled item again (see `WriteResult`). */
export const THROTTLE_WAIT_MS = { default: 2_000, min: 1_000, max: 60_000 } as const

/** Bound as `HUB_WRITE`, its own named entrypoint. `ReadGateway` never writes. */
export interface WriteGateway {
  runAction(req: WriteRequest): Promise<WriteResult>
}
