// schemas.ts and contract.ts must agree. The expectTypeOf lines are checked by `npm run typecheck` (tsc includes test
// files); the runtime cases check that the schemas accept and refuse what the types say.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { AccountStatus, AccountSummary, CallerScope, CallToolOptions, CardFacts, CardFactsRequest, HubError, HubErrorCode, HubResult, Instant, SignInState, ToolInfo, WriteOperationKey, WriteRequest, WriteResult } from './contract'
import type {
  CallToolValue, ConfirmToolsRequest, ConnectGateway, ConnectReturn, ConnectionActor, ConnectionBindingInput, ConnectionCredential, ConnectionDestinations, ConnectionKeyPlace,
  ConnectionListFreshness, ConnectionState, ConnectionSummary, ConnectionTool, ConnectionTools, ConnectionView, DetectResult, PrepareConnectionRequest,
  ScriptProposal, ToolTrust, UpdateConnectionRequest, WriteToolInfo,
} from './contract'
import { CONNECTION_CAPS, SCRIPT_PROPOSALS_MAX, THROTTLE_WAIT_MS, WRITE_OPERATIONS } from './contract'
import { isHubErrorCode } from './errors'
import {
  AccountStatusSchema,
  AccountSummarySchema,
  CallerScopeSchema,
  CallToolOptionsSchema,
  HubErrorCodeSchema,
  HubErrorSchema,
  hubResultSchema,
  InstantSchema,
  SignInStateSchema,
  ToolInfoSchema,
  WriteOperationKeySchema,
  WriteRequestSchema,
  WriteResultSchema,
  CardFactsRequestSchema,
  CardFactsSchema,
  CallToolValueSchema,
  ConfirmToolsRequestSchema,
  ConnectionActorSchema,
  ConnectReturnSchema,
  ConnectionBindingInputSchema,
  ConnectionCredentialSchema,
  ConnectionDestinationsSchema,
  ConnectionKeyPlaceSchema,
  ConnectionListFreshnessSchema,
  ConnectionRefRequestSchema,
  ConnectionStateSchema,
  ConnectionSummarySchema,
  ConnectionToolSchema,
  ConnectionToolsSchema,
  ConnectionViewSchema,
  DetectRequestSchema,
  DetectResultSchema,
  PrepareConnectionRequestSchema,
  ReturnIssSchema,
  ScriptProposalSchema,
  SetCredentialRequestSchema,
  SetTrustedRequestSchema,
  ToolTrustSchema,
  UpdateConnectionRequestSchema,
  WriteToolInfoSchema,
  PINNED_OPERATIONS,
} from './schemas'

type Flat<T> = { [K in keyof T]: T[K] }
type Req<M extends keyof ConnectGateway> = ConnectGateway[M] extends (scope: CallerScope, req: infer R) => unknown ? R : never

describe('schemas.ts mirrors contract.ts', () => {
  it('types agree', () => {
    expectTypeOf<z.infer<typeof InstantSchema>>().toEqualTypeOf<Instant>()
    expectTypeOf<z.infer<typeof CallerScopeSchema>>().toEqualTypeOf<CallerScope>()
    expectTypeOf<z.infer<typeof HubErrorCodeSchema>>().toEqualTypeOf<HubErrorCode>()
    expectTypeOf<z.infer<typeof HubErrorSchema>>().toEqualTypeOf<HubError>()
    expectTypeOf<z.infer<typeof ToolInfoSchema>>().toEqualTypeOf<ToolInfo>()
    expectTypeOf<z.infer<typeof SignInStateSchema>>().toEqualTypeOf<SignInState>()
    expectTypeOf<z.infer<typeof AccountStatusSchema>>().toEqualTypeOf<AccountStatus>()
    expectTypeOf<z.infer<typeof AccountSummarySchema>>().toEqualTypeOf<AccountSummary>()
    expectTypeOf<Flat<z.infer<typeof CallToolOptionsSchema>>>().toEqualTypeOf<Flat<CallToolOptions>>()
    const toolList = hubResultSchema(ToolInfoSchema.array())
    expectTypeOf<z.infer<typeof toolList>>().toEqualTypeOf<HubResult<ToolInfo[]>>()
    expectTypeOf<z.infer<typeof WriteOperationKeySchema>>().toEqualTypeOf<WriteOperationKey>()
    expectTypeOf<z.infer<typeof WriteRequestSchema>>().toEqualTypeOf<WriteRequest>()
    expectTypeOf<z.infer<typeof WriteResultSchema>>().toEqualTypeOf<WriteResult>()
    expectTypeOf<z.infer<typeof CardFactsRequestSchema>>().toEqualTypeOf<CardFactsRequest>()
    expectTypeOf<z.infer<typeof CardFactsSchema>>().toEqualTypeOf<CardFacts>()
    // Stage 1 M4 (M4-A)
    expectTypeOf<z.infer<typeof ToolTrustSchema>>().toEqualTypeOf<ToolTrust>()
    expectTypeOf<z.infer<typeof ScriptProposalSchema>>().toEqualTypeOf<ScriptProposal>()
    expectTypeOf<z.infer<typeof CallToolValueSchema>>().toEqualTypeOf<CallToolValue>()
    expectTypeOf<z.infer<typeof ConnectionActorSchema>>().toEqualTypeOf<ConnectionActor>()
    expectTypeOf<z.infer<typeof ConnectionStateSchema>>().toEqualTypeOf<ConnectionState>()
    expectTypeOf<z.infer<typeof ConnectionDestinationsSchema>>().toEqualTypeOf<ConnectionDestinations>()
    expectTypeOf<z.infer<typeof DetectResultSchema>>().toEqualTypeOf<DetectResult>()
    expectTypeOf<z.infer<typeof ConnectionKeyPlaceSchema>>().toEqualTypeOf<ConnectionKeyPlace>()
    expectTypeOf<z.infer<typeof ConnectionBindingInputSchema>>().toEqualTypeOf<ConnectionBindingInput>()
    expectTypeOf<z.infer<typeof ConnectionCredentialSchema>>().toEqualTypeOf<ConnectionCredential>()
    expectTypeOf<z.infer<typeof ConnectionListFreshnessSchema>>().toEqualTypeOf<ConnectionListFreshness>()
    expectTypeOf<z.infer<typeof ConnectionViewSchema>>().toEqualTypeOf<ConnectionView>()
    expectTypeOf<z.infer<typeof ConnectionToolSchema>>().toEqualTypeOf<ConnectionTool>()
    expectTypeOf<z.infer<typeof ConnectionToolsSchema>>().toEqualTypeOf<ConnectionTools>()
    // The contract writes it as the view and its tools (an intersection); compared field by field.
    expectTypeOf<Flat<z.infer<typeof ConnectionSummarySchema>>>().toEqualTypeOf<Flat<ConnectionSummary>>()
    expectTypeOf<z.infer<typeof WriteToolInfoSchema>>().toEqualTypeOf<WriteToolInfo>()
    expectTypeOf<z.infer<typeof PrepareConnectionRequestSchema>>().toEqualTypeOf<PrepareConnectionRequest>()
    expectTypeOf<z.infer<typeof UpdateConnectionRequestSchema>>().toEqualTypeOf<UpdateConnectionRequest>()
    expectTypeOf<z.infer<typeof ConfirmToolsRequestSchema>>().toEqualTypeOf<ConfirmToolsRequest>()
    // Each new ConnectGateway method's request is the schema the entrypoint will parse it with.
    expectTypeOf<z.infer<typeof DetectRequestSchema>>().toEqualTypeOf<Req<'detectConnection'>>()
    expectTypeOf<z.infer<typeof PrepareConnectionRequestSchema>>().toEqualTypeOf<Req<'prepareConnection'>>()
    expectTypeOf<z.infer<typeof ConnectionRefRequestSchema>>().toEqualTypeOf<Req<'getConnection'>>()
    expectTypeOf<z.infer<typeof UpdateConnectionRequestSchema>>().toEqualTypeOf<Req<'updateConnection'>>()
    expectTypeOf<z.infer<typeof SetTrustedRequestSchema>>().toEqualTypeOf<Req<'setTrusted'>>()
    expectTypeOf<z.infer<typeof ConnectionRefRequestSchema>>().toEqualTypeOf<Req<'startConnectionSignIn'>>()
    expectTypeOf<z.infer<typeof SetCredentialRequestSchema>>().toEqualTypeOf<Req<'setConnectionCredential'>>()
    expectTypeOf<z.infer<typeof ConnectionRefRequestSchema>>().toEqualTypeOf<Req<'checkConnection'>>()
    expectTypeOf<z.infer<typeof ConnectionRefRequestSchema>>().toEqualTypeOf<Req<'listConnectionTools'>>()
    expectTypeOf<z.infer<typeof ConfirmToolsRequestSchema>>().toEqualTypeOf<Req<'confirmConnectionTools'>>()
    expectTypeOf<z.infer<typeof ConnectionRefRequestSchema>>().toEqualTypeOf<Req<'removeConnection'>>()
    expectTypeOf<z.infer<typeof ConnectReturnSchema>>().toEqualTypeOf<ConnectReturn>()
    expectTypeOf<Partial<ConnectReturn>>().toEqualTypeOf<Partial<Pick<Req<'completeConnect'>, 'actorKind' | 'iss'>>>()
    expectTypeOf<Partial<ConnectReturn>>().toEqualTypeOf<Partial<Pick<Req<'failConnect'>, 'actorKind' | 'iss'>>>()
  })

  it('caller scopes parse strictly', () => {
    expect(CallerScopeSchema.safeParse({ kind: 'run', runId: 'r', principalId: 'p', requestId: 'q' }).success).toBe(true)
    expect(CallerScopeSchema.safeParse({ kind: 'server', job: 'j', requestId: 'q' }).success).toBe(true)
    expect(CallerScopeSchema.safeParse({ kind: 'run', runId: 'r', requestId: 'q' }).success).toBe(false)
    expect(CallerScopeSchema.safeParse({ kind: 'server', job: 'j', requestId: 'q', write: true }).success).toBe(false)
    expect(CallerScopeSchema.safeParse({ kind: 'admin', requestId: 'q' }).success).toBe(false)
    expect(CallerScopeSchema.safeParse({ kind: 'server', job: '', requestId: 'q' }).success).toBe(false)
  })

  // The read call's options (the test shop override): ways it can go wrong, written first. A host that isn't a Shopify
  // host (another domain, a path, a port, upper case, a bare handle) or an unknown key must not parse, so the hub never
  // builds a URL from it and nothing rides along under a new name.
  it('call options parse strictly', () => {
    expect(CallToolOptionsSchema.safeParse({}).success).toBe(true)
    expect(CallToolOptionsSchema.safeParse({ testShopHost: 'example-mc-late-orders.myshopify.com' }).success).toBe(true)
    for (const testShopHost of ['example-mc-late-orders', 'evil.example', 'a.myshopify.com.evil.example', 'a.myshopify.com/x', 'a.myshopify.com:443', 'A.myshopify.com', '-a.myshopify.com', '.myshopify.com', ''])
      expect(CallToolOptionsSchema.safeParse({ testShopHost }).success, testShopHost).toBe(false)
    expect(CallToolOptionsSchema.safeParse({ testShopHost: 'a.myshopify.com', shop: 'b' }).success).toBe(false)
    expect(CallToolOptionsSchema.safeParse({ testShopHost: 1 }).success).toBe(false)
  })

  // The write entrypoint (N13), ways it can go wrong, written first: an operation outside the write set, a request
  // with an extra key (a caller-supplied scope or a flag riding along), a missing account generation, an attempt of 0, a
  // result that says it failed without saying whether anything went out, or a `sent` other than 'no' and 'unknown'.
  it('write requests and results parse strictly', () => {
    // M3-S1 adds tag_remove and draft_order.create, M3-S2 restock, reduce and refund (plan section 0, Q1); nothing else.
    expect(WRITE_OPERATIONS).toEqual(['shopify.order.tag_add', 'slack.channel.post', 'shopify.order.tag_remove', 'shopify.draft_order.create',
      'shopify.inventory.restock', 'shopify.inventory.reduce', 'shopify.refund.create'])
    expect(WriteOperationKeySchema.options).toEqual([...WRITE_OPERATIONS])
    const req = { actionId: 'a_1', attempt: 1, requestId: 'q', accountId: 'shopify:store', expect: { connectedAtMs: 5 }, operation: 'shopify.order.tag_add', args: { orderId: '1', tags: ['x'] } }
    expect(WriteRequestSchema.safeParse(req).success).toBe(true)
    expect(WriteRequestSchema.safeParse({ ...req, operation: 'slack.channel.post', accountId: 'slack:workspace' }).success).toBe(true)
    expect(WriteRequestSchema.safeParse({ ...req, operation: 'shopify.order.cancel' }).success).toBe(false)
    expect(WriteRequestSchema.safeParse({ ...req, scope: { shop: 'x' } }).success).toBe(false)
    expect(WriteRequestSchema.safeParse({ ...req, expect: {} }).success).toBe(false)
    expect(WriteRequestSchema.safeParse({ ...req, expect: { connectedAtMs: 5, force: true } }).success).toBe(false)
    expect(WriteRequestSchema.safeParse({ ...req, attempt: 0 }).success).toBe(false)
    expect(WriteRequestSchema.safeParse({ ...req, accountId: 'Shopify Store' }).success).toBe(false)
    expect(WriteRequestSchema.safeParse({ ...req, actionId: '' }).success).toBe(false)
    const error = { code: 'not_configured', message: 'Not configured' }
    expect(WriteResultSchema.safeParse({ ok: true, value: { ref: '#1001: vip' } }).success).toBe(true)
    expect(WriteResultSchema.safeParse({ ok: false, error, sent: 'no' }).success).toBe(true)
    expect(WriteResultSchema.safeParse({ ok: false, error, sent: 'unknown' }).success).toBe(true)
    expect(WriteResultSchema.safeParse({ ok: false, error }).success).toBe(false)
    expect(WriteResultSchema.safeParse({ ok: false, error, sent: 'yes' }).success).toBe(false)
    expect(WriteResultSchema.safeParse({ ok: true, value: { ref: 'x', body: {} } }).success).toBe(false)
  })

  // Stage 1 M3 (N22, N21), ways it can go wrong, written first: an item past the batch's end, an item 0, a batch longer
  // than the ceiling allows (500), an item with a key riding along, an idempotency key that is empty, too long or carries
  // characters a GraphQL directive argument shouldn't; and a throttle that loses its retry time or says nothing went out
  // without `sent`.
  it('batch items, idempotency keys and throttles parse strictly', () => {
    const req = { actionId: 'ac_1', attempt: 1, requestId: 'ac_1:3', accountId: 'shopify:store', expect: { connectedAtMs: 5, shop: 'store-a' }, operation: 'shopify.order.tag_add', args: {} }
    expect(WriteRequestSchema.safeParse({ ...req, item: { n: 3, of: 40 }, idempotencyKey: 'ac_1:3' }).success).toBe(true)
    expect(WriteRequestSchema.safeParse({ ...req, item: { n: 1, of: 1 } }).success).toBe(true)
    expect(WriteRequestSchema.safeParse({ ...req, item: { n: 500, of: 500 } }).success).toBe(true)
    for (const item of [{ n: 0, of: 1 }, { n: 2, of: 1 }, { n: 1, of: 501 }, { n: 1.5, of: 2 }, { n: 1 }, { n: 1, of: 2, total: 2 }])
      expect(WriteRequestSchema.safeParse({ ...req, item }).success, JSON.stringify(item)).toBe(false)
    for (const idempotencyKey of ['', 'a'.repeat(201), 'ac_1:3"', 'ac 1', 'ac_1:3\n', '{x}'])
      expect(WriteRequestSchema.safeParse({ ...req, idempotencyKey }).success, idempotencyKey).toBe(false)
    expect(WriteRequestSchema.safeParse({ ...req, idempotencyKey: 'a'.repeat(200) }).success).toBe(true)
    const throttled = { ok: false, error: { code: 'rate_limited', message: 'rate limited by the upstream', retryAfterMs: 2000 }, sent: 'no' }
    expect(WriteResultSchema.safeParse(throttled).success).toBe(true)
    expect(WriteResultSchema.safeParse({ ...throttled, error: { ...throttled.error, retryAfterMs: '2000' } }).success).toBe(false)
    expect(WriteResultSchema.safeParse({ ok: false, error: throttled.error }).success).toBe(false)
    const { retryAfterMs: _, ...noWait } = throttled.error
    expect(WriteResultSchema.safeParse({ ...throttled, error: noWait }).success).toBe(true)
    for (const retryAfterMs of [-1, 1.5, 86_400_001]) expect(WriteResultSchema.safeParse({ ...throttled, error: { ...throttled.error, retryAfterMs } }).success, String(retryAfterMs)).toBe(false)
    expect(WriteResultSchema.safeParse({ ...throttled, error: { ...throttled.error, upstream: 'body' } }).success).toBe(false)
    expect(THROTTLE_WAIT_MS.min).toBeLessThanOrEqual(THROTTLE_WAIT_MS.default)
    expect(THROTTLE_WAIT_MS.default).toBeLessThanOrEqual(THROTTLE_WAIT_MS.max)
  })
  // Stage 1 M4 (M4-A): the codes, the call options, the answer and the write pins. Ways they can go wrong, written first:
  // a new code missing from the schema; `propose` or `name` taking a non-boolean or an empty name; proposals that ride
  // in `data` or past the cap; an MCP write pinned by one or two of its three facts, or by a hash that isn't hex.
  it('M4 codes, call options and proposals parse strictly', () => {
    for (const code of ['needs_key', 'definition_changed', 'needs_input', 'leak', 'client_fault', 'not_built', 'connections_off'])
      expect(HubErrorCodeSchema.safeParse(code).success, code).toBe(true)
    // The hub's text table (errors.ts) knows every code and nothing else (app/server/contract-coverage.test.ts checks the
    // product's lists against the same set).
    for (const code of HubErrorCodeSchema.options) expect(isHubErrorCode(code), code).toBe(true)
    for (const other of ['ok', 'quota_exceeded', 'toString', '__proto__']) expect(isHubErrorCode(other), other).toBe(false)
    expect(CallToolOptionsSchema.safeParse({ propose: true }).success).toBe(true)
    expect(CallToolOptionsSchema.safeParse({ name: 'helpdesk_search' }).success).toBe(true)
    for (const bad of [{ propose: 'yes' }, { name: '' }, { name: 'x'.repeat(201) }, { propose: true, proposals: [] }])
      expect(CallToolOptionsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    expect(CallToolValueSchema.safeParse({ data: { ok: 1 } }).success).toBe(true)
    expect(CallToolValueSchema.safeParse({ data: null, proposals: [{ tool: 'shopify_order_tag_add', args: { orderId: '1' } }] }).success).toBe(true)
    const many = Array.from({ length: SCRIPT_PROPOSALS_MAX.proposals + 1 }, () => ({ tool: 'shopify_order_tag_add', args: {} }))
    expect(CallToolValueSchema.safeParse({ data: null, proposals: many }).success).toBe(false)
    expect(CallToolValueSchema.safeParse({ data: null, proposals: [{ tool: 'x', args: {}, key: 'k' }] }).success).toBe(false)
    expect(AccountStatusSchema.shape.kind.options).toEqual(['client_credentials', 'oauth_mcp', 'mcp_runtime'])
    const tool = { name: 'orders_search', connector: 'shopify', description: 'Orders', inputSchema: {} }
    expect(ToolInfoSchema.safeParse(tool).success).toBe(true)
    expect(ToolInfoSchema.safeParse({ ...tool, source: 'mcp:helpdesk', trust: 'untrusted' }).success).toBe(true)
    expect(ToolInfoSchema.safeParse({ ...tool, trust: 'yes' }).success).toBe(false)
  })

  // #673: the pins are refused on every operation that doesn't read them (all of them until M4-W2), so a request that
  // carries them is refused as it was before M4-A, never sent with them unread.
  it('an MCP write pins generation, defHash and policyRev together, and only where an operation reads them', () => {
    const req = { actionId: 'ac_1', attempt: 1, requestId: 'ac_1:1', accountId: 'shopify:store', expect: { connectedAtMs: 5 }, operation: 'shopify.order.tag_add', args: {} }
    const pins = { generation: 3, defHash: 'a'.repeat(64), policyRev: 7 }
    expect(PINNED_OPERATIONS).toEqual([])
    expect(WriteRequestSchema.safeParse(req).success).toBe(true)
    for (const operation of WRITE_OPERATIONS) {
      expect(WriteRequestSchema.safeParse({ ...req, operation, expect: { connectedAtMs: 5, ...pins } }).success, operation).toBe(false)
    }
    for (const k of Object.keys(pins) as (keyof typeof pins)[]) {
      const { [k]: _, ...rest } = pins
      expect(WriteRequestSchema.safeParse({ ...req, expect: { connectedAtMs: 5, ...rest } }).success, k).toBe(false)
      expect(WriteRequestSchema.safeParse({ ...req, expect: { connectedAtMs: 5, [k]: pins[k] } }).success, k).toBe(false)
    }
    for (const bad of [{ defHash: 'A'.repeat(64) }, { defHash: 'a'.repeat(63) }, { generation: 0 }, { policyRev: 1.5 }])
      expect(WriteRequestSchema.safeParse({ ...req, expect: { connectedAtMs: 5, ...pins, ...bad } }).success, JSON.stringify(bad)).toBe(false)
  })

  // Connections (N35 to N46). Ways they can go wrong, written first: an address that isn't exact https (http, a user
  // part, a query, a fragment, a space); a reserved or odd slug; a key header that could smuggle (Host, Cookie,
  // Content-Length, any Mcp-*, a CR or LF in the prefix, Authorization with no scheme); an actor that isn't the Inhouse
  // team or an Admin; a credential with control characters; a confirm naming a tool twice or a mode of `new`.
  it('connection requests and answers parse strictly', () => {
    const actor = { kind: 'inhouse', memberId: 'm_1' }
    const destinations = {
      mcp: 'https://mcp.example.com/mcp', metadata: ['https://mcp.example.com/.well-known/oauth-protected-resource/mcp'], issuer: 'https://login.example.com',
      authorize: 'https://login.example.com/authorize', token: 'https://login.example.com/token', registration: null, revoke: null,
    }
    expect(DetectRequestSchema.safeParse({ actor, url: 'https://mcp.example.com:8443/v1/mcp' }).success).toBe(true)
    for (const url of ['http://mcp.example.com/mcp', 'https://user@mcp.example.com/mcp', 'https://mcp.example.com/mcp?x=1', 'https://mcp.example.com/mcp#f', 'https://mcp.example.com/m cp', 'mcp.example.com', ''])
      expect(DetectRequestSchema.safeParse({ actor, url }).success, url).toBe(false)
    for (const kind of ['member', 'system']) expect(ConnectionActorSchema.safeParse({ kind, memberId: 'm_1' }).success, kind).toBe(false)
    const binding = { transport: 'https', path: 'key', destinations, key: { header: 'Authorization', prefix: 'Bearer ' }, settings: {} }
    const prepare = { actor, slug: 'helpdesk', adminMaySignIn: false, binding }
    expect(PrepareConnectionRequestSchema.safeParse(prepare).success).toBe(true)
    expect(PrepareConnectionRequestSchema.safeParse({ ...prepare, binding: { transport: 'connector', connector: 'rest-fixture', settings: {} } }).success).toBe(true)
    for (const slug of ['shopify', 'slack', 'code', 'inhouse', 'member', 'index', 'Help', 'help-desk', 'h', '1help', 'a'.repeat(25)])
      expect(PrepareConnectionRequestSchema.safeParse({ ...prepare, slug }).success, slug).toBe(false)
    expect(ConnectionKeyPlaceSchema.safeParse({ header: 'X-Api-Key', prefix: '' }).success).toBe(true)
    for (const key of [{ header: 'Host', prefix: '' }, { header: 'cookie', prefix: '' }, { header: 'Content-Length', prefix: '' }, { header: 'Mcp-Session-Id', prefix: '' },
      { header: 'X-Api-Key', prefix: 'a\r\nX: y' }, { header: 'Authorization', prefix: '' }, { header: 'X Key', prefix: '' }])
      expect(ConnectionKeyPlaceSchema.safeParse(key).success, JSON.stringify(key)).toBe(false)
    expect(SetCredentialRequestSchema.safeParse({ actor, accountId: 'mcp:helpdesk', credential: { kind: 'key', key: 'sk_live_abc' } }).success).toBe(true)
    for (const credential of [{ kind: 'key', key: '' }, { kind: 'key', key: 'a\nb' }, { kind: 'client', clientId: 'c', clientSecret: 'a b' }, { kind: 'token', key: 'x' }])
      expect(SetCredentialRequestSchema.safeParse({ actor, accountId: 'mcp:helpdesk', credential }).success, JSON.stringify(credential)).toBe(false)
    for (const accountId of ['mcp:helpdesk', 'mcp:h2'])
      expect(ConnectionRefRequestSchema.safeParse({ actor, accountId }).success, accountId).toBe(true)
    for (const accountId of ['slack:workspace', 'shopify', 'mcp:', 'mcp:Help', 'helpdesk'])
      expect(ConnectionRefRequestSchema.safeParse({ actor, accountId }).success, accountId).toBe(false)
    const hash = 'b'.repeat(64)
    const confirm = { actor, accountId: 'mcp:helpdesk', generation: 2, ifRev: 4, tools: [{ name: 'search', defHash: hash, mode: 'read' }, { name: 'reply', defHash: hash, mode: 'write' }] }
    expect(ConfirmToolsRequestSchema.safeParse(confirm).success).toBe(true)
    expect(ConfirmToolsRequestSchema.safeParse({ ...confirm, tools: [confirm.tools[0], confirm.tools[0]] }).success).toBe(false)
    expect(ConfirmToolsRequestSchema.safeParse({ ...confirm, tools: [{ ...confirm.tools[0], mode: 'new' }] }).success).toBe(false)
    expect(ConfirmToolsRequestSchema.safeParse({ ...confirm, tools: [] }).success).toBe(false)
    expect(UpdateConnectionRequestSchema.safeParse({ actor, accountId: 'mcp:helpdesk', ifRev: 1, adminMaySignIn: true }).success).toBe(true)
    expect(UpdateConnectionRequestSchema.safeParse({ actor, accountId: 'mcp:helpdesk', ifRev: 1, trusted: true }).success).toBe(false)
    expect(SetTrustedRequestSchema.safeParse({ actor, accountId: 'mcp:helpdesk', trusted: true, ifRev: 2 }).success).toBe(true)
    const view = {
      accountId: 'mcp:helpdesk', slug: 'helpdesk', generation: 1, policyRev: 1, transport: 'https', path: 'signin', connector: null, destinations, era: 'modern',
      settings: {}, trusted: false, adminMaySignIn: true, paused: false, state: 'waiting_signin', list: null,
    }
    expect(ConnectionViewSchema.safeParse(view).success).toBe(true)
    expect(ConnectionViewSchema.safeParse({ ...view, key: 'sk_live_abc' }).success).toBe(false)
    expect(ConnectionSummarySchema.safeParse({ ...view, tools: [{ name: 'search', hubName: 'helpdesk_search', defHash: hash, mode: 'new', hidden: null }] }).success).toBe(true)
    expect(DetectResultSchema.safeParse({ outcome: 'blocked', reason: 'redirected', era: null, destinations }).success).toBe(true)
    expect(DetectResultSchema.safeParse({ outcome: 'blocked', reason: 'Redirected to <a>', era: null, destinations }).success).toBe(false)
    expect(WriteToolInfoSchema.safeParse({ accountId: 'mcp:helpdesk', name: 'reply', hubName: 'helpdesk_reply', description: 'Replies', inputSchema: {}, defHash: hash, generation: 1, policyRev: 2, trusted: false }).success).toBe(true)
    expect(ReturnIssSchema.safeParse(['https://login.example.com', 'https://login.example.com']).success).toBe(true)
    expect(ReturnIssSchema.safeParse(null).success).toBe(true)
    expect(ReturnIssSchema.safeParse([]).success).toBe(false)
    expect(ReturnIssSchema.safeParse(undefined).success).toBe(false)
    // #674: both fields, always; none is an explicit null.
    expect(ConnectReturnSchema.safeParse({ actorKind: 'inhouse', iss: null }).success).toBe(true)
    expect(ConnectReturnSchema.safeParse({ actorKind: 'admin', iss: ['https://login.example.com'] }).success).toBe(true)
    for (const bad of [{ actorKind: 'inhouse' }, { iss: null }, {}, { actorKind: 'member', iss: null }, { actorKind: 'inhouse', iss: [] }])
      expect(ConnectReturnSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    expect(CONNECTION_CAPS).toEqual({ perBrand: 20, snapshotTools: 200, confirmedTools: 100 })
  })
})
