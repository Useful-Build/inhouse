// The SignIn Durable Object: one per connector account (env.SIGNIN.idFromName(accountId)), SQLite backed. A thin
// wrapper: the state machine is core.ts over ctx.storage.kv (synchronous), ctx.storage.setAlarm and Date.now().
// This module also holds the runtime glue the entrypoints share (the registry load and the upstream), since it's the
// one place that may hold the guarded test branch: node tests never import this file (it imports cloudflare:workers).
// Docs read 2026-11-20: SQLite storage API (ctx.storage.kv, transactionSync), Alarms, Durable Objects rules, lifecycle.
import { DurableObject } from 'cloudflare:workers'
import { safeError } from '../../server/safe-error'
import { settledAnswer } from '../../shared/rpc-answer'
import { connectors } from '../connectors/index'
import type { HubResult } from '../index/contract'
import { err } from '../index/errors'
import { drainPendingTestLogs, log } from '../index/log'
import { keyRingFor } from '../crypto/keyring'
import {
  buildRegistry,
  isMcpConnector,
  kindFor,
  mcpConnectorFor,
  scopesFor,
  type HubConnector,
  type McpClient,
  type McpConnectorModule,
  type ReadyGatewayDeps,
  type Registry,
  type ShopifyReadClient,
} from '../registry/registry'
import { parseShopifyConfig, type Upstream } from './providers/shopify'
import type { SlackPostExpect, SlackPostRequest } from '../connectors/slack/contract'
import { SignInCore, type McpCallRequest, type McpProvider, type QueryRequest, type SyncStore } from './core'

type HubEnv = Env & { INHOUSE_TEST_BUILD?: string }

// The guard is written out in full at each use (never behind a helper call), so esbuild sees `false && ...` in the
// deployable build and drops the branch with its dynamic import.
let registry: Promise<Registry> | null = null

/** Built once per isolate. A malformed module rejects every call (loud, never half open). */
export function loadRegistry(env: HubEnv): Promise<Registry> {
  registry ??= (async () => {
    const modules: HubConnector[] = [...(connectors as readonly HubConnector[])]
    if (__INHOUSE_HUB_TEST__ && env.INHOUSE_TEST_BUILD === '1') {
      const { fixtureConnector } = await import('../registry/testing/fixture-connector')
      modules.push(fixtureConnector)
      const { notesConnector } = await import('../connectors/mcp/testing/notes-connector')
      modules.push(notesConnector)
    }
    return buildRegistry(modules)
  })().catch((e: unknown) => {
    log('hub_config_invalid', { code: 'registry' })
    throw e
  })
  return registry
}

/**
 * The singleton SignIn Durable Object name holding the test build's fake upstreams, var overrides, ConnectGateway
 * answer log and hub log buffer. Cannot collide with any account id (`AccountIdSchema` starts with a letter).
 */
export const TEST_FAKES_DO_NAME = '__test-fakes__'
/** Storage key inside the singleton test-fakes DO holding `op: 'var'` overrides so they survive DO eviction. */
export const TEST_FAKES_VARS_KEY = 'test-fakes:vars'
const TEST_THROW_STATUS = 598
const TEST_THROW_HEADER = 'X-Inhouse-Test-Throw'

/**
 * globalThis.fetch, except in the test build, where PR0's seam answers from recorded upstreams. Routed through the one
 * singleton test-fakes DO so every SignIn DO and Worker isolate shares the exact same fake servers, switches, seeds and logs.
 */
export async function upstreamFor(env: HubEnv): Promise<Upstream> {
  if (__INHOUSE_HUB_TEST__ && env.INHOUSE_TEST_BUILD === '1') {
    const stub = env.SIGNIN.get(env.SIGNIN.idFromName(TEST_FAKES_DO_NAME))
    return async req => {
      const res = await stub.fetch(req)
      if (res.status === TEST_THROW_STATUS && res.headers.get(TEST_THROW_HEADER) === '1') {
        throw new TypeError(await res.text())
      }
      return res
    }
  }
  return req => fetch(req)
}

/** Tail of this isolate's flush chain (test build only). Never rejects: every link catches its own failure. */
let testLogFlushChain: Promise<void> = Promise.resolve()

/**
 * Flushes this isolate's queued hub test log lines to the singleton test-fakes DO (test build only). Flushes chain per
 * isolate: each waits for the one before it, so when this returns, every line queued by any flush started earlier in
 * this isolate has reached the DO (a second request can't return while the first's lines are still in flight). Runs in
 * `finally` blocks, so it never throws; a failed append is logged loudly (error name and line count, never content).
 */
export function flushTestLogs(env: HubEnv): Promise<void> {
  // The whole test path sits inside the `if`, never after an early return: the deployable build folds the flag to
  // `false` and drops the block, so no test-fakes name or call reaches dist-hub (check-hub-build.mjs proves it).
  if (__INHOUSE_HUB_TEST__ && env.INHOUSE_TEST_BUILD === '1') {
    const mine = testLogFlushChain.then(async () => {
      const lines = drainPendingTestLogs()
      if (lines.length === 0) return
      try {
        await env.SIGNIN.get(env.SIGNIN.idFromName(TEST_FAKES_DO_NAME)).testAppendLogs(lines)
      } catch (e) {
        console.error(`hub test logs: flushing ${lines.length} line${lines.length === 1 ? '' : 's'} failed and they are lost (${safeError(e)})`)
      }
    })
    testLogFlushChain = mine
    return mine
  }
  return Promise.resolve()
}

/** Env with any test-build `op: 'var'` overrides read from the singleton test-fakes DO. */
export async function envRecord(env: HubEnv): Promise<Readonly<Record<string, unknown>>> {
  // The hub's TEST bundle only: the test-fakes hook's var overrides (hub/testing/fakes.ts, op `var`), held in the
  // singleton test-fakes DO's SQLite KV and cleared by its reset. The deployable bundle drops the branch (the define is "false").
  if (__INHOUSE_HUB_TEST__ && env.INHOUSE_TEST_BUILD === '1') {
    const vars = await settledAnswer(env.SIGNIN.get(env.SIGNIN.idFromName(TEST_FAKES_DO_NAME)).testGetVars())
    if (Object.keys(vars).length > 0) return { ...(env as unknown as Record<string, unknown>), ...vars }
  }
  return env as unknown as Readonly<Record<string, unknown>>
}

/** Env only, synchronous over a pre-loaded env record. Shopify: H0's three settings. An oauth_mcp connector: its own `configure(env)` (P5 W1). */
export const isConfiguredFrom = (env: HubEnv, record: Readonly<Record<string, unknown>>, connector: HubConnector): boolean =>
  isMcpConnector(connector) ? connector.configure(record) !== null : connector.id === 'shopify' && parseShopifyConfig(env) !== null

/** The OAuth provider for an account: its module and this deployment's client settings. Null when unconfigured. */
export async function providerFor(env: HubEnv, accountId: string): Promise<McpProvider | null> {
  const connector = mcpConnectorFor(await loadRegistry(env), accountId)
  if (!connector) return null
  const clientConfig = connector.configure(await envRecord(env))
  return clientConfig ? { kind: 'oauth_mcp', connector, clientConfig } : null
}

export const signInFor = (env: Env, accountId: string) => env.SIGNIN.get(env.SIGNIN.idFromName(accountId))

/**
 * The ReadGateway's deps with readiness and the MCP proxy (P5 W1). index.ts's ReadGateway uses these through the
 * orchestrator's wiring line: `listReadyTools(await readyGatewayDeps(this.env))`, `callReadyTool(...)`. Every SignIn
 * answer is read as plain data and released (`settledAnswer`), so a tool's answer never passes one on as is.
 */
export async function readyGatewayDeps(env: Env, testShop: string | null = null): Promise<ReadyGatewayDeps> {
  const [registry, record] = await Promise.all([loadRegistry(env), envRecord(env)])
  return {
    registry,
    isConfigured: c => isConfiguredFrom(env, record, c),
    // `testShop` (P4): a test build's override handle (index.ts shopFor), read by its own SignIn object (signInName).
    // Every Shopify read (the read tools and code mode's shop.graphql) comes through here, so none reaches SHOPIFY_SHOP.
    shopifyFor: (c: HubConnector): ShopifyReadClient => ({
      graphql: async (document, variables, apiVersion) => {
        const version = apiVersion ?? (isMcpConnector(c) ? undefined : c.apiVersion)
        if (!version) return err('invalid_args', 'apiVersion')
        const query = { accountId: c.accountId, document, variables, apiVersion: version }
        if (testShop === null) return (await settledAnswer(signInFor(env, c.accountId).query(query))) as HubResult<{ data: unknown }>
        return (await settledAnswer(env.SIGNIN.get(env.SIGNIN.idFromName(signInName(c.accountId, testShop))).query({ ...query, testShop }))) as HubResult<{ data: unknown }>
      },
    }),
    nowMs: () => Date.now(),
    // With a test shop, a Shopify account's readiness is the test shop's own object's (#337 review): the real account's
    // pause or state never decides a test-shop read. MCP accounts have no test shop and keep their own object.
    isReady: async accountId => {
      const shopify = testShop !== null && registry.modules.some(c => c.accountId === accountId && !isMcpConnector(c))
      const stub = shopify ? env.SIGNIN.get(env.SIGNIN.idFromName(signInName(accountId, testShop))) : signInFor(env, accountId)
      const r = await settledAnswer(stub.ready(accountId))
      return r.ok ? r.value : { ready: false, code: 'not_configured' }
    },
    mcpFor: (c: McpConnectorModule): McpClient => ({
      call: async (upstream, args) => (await settledAnswer(signInFor(env, c.accountId).mcpCall({ accountId: c.accountId, upstream, args }))) as never,
    }),
  }
}

/**
 * The SignIn object a call reaches: the account's own, or in a test build a test shop's (index.ts shopFor), named apart so
 * its token, grant and alarm never mix with the account's or another shop's.
 */
export const signInName = (accountId: string, testShop: string | null): string => (testShop === null ? accountId : `${accountId}|test-shop|${testShop}`)

/** The SignIn storage key holding a test shop object's handle (outside the core's `record` and `pending:` keys). */
const TEST_SHOP_KEY = 'test-shop'

export class SignIn extends DurableObject<Env> {
  readonly #core: SignInCore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    const hubEnv: HubEnv = env
    const store: SyncStore = {
      get: key => storage.kv.get(key),
      put: (key, value) => storage.kv.put(key, value),
      delete: key => storage.kv.delete(key),
      list: prefix => storage.kv.list({ prefix }),
      transactionSync: fn => storage.transactionSync(fn),
    }
    this.#core = new SignInCore({
      store,
      now: () => Date.now(),
      // Awaited by the core, which logs a failure and records it for status().
      alarm: {
        set: atMs => storage.setAlarm(atMs),
        delete: () => storage.deleteAlarm(),
        get: () => storage.getAlarm(),
      },
      upstream: () => upstreamFor(env),
      keyring: () => keyRingFor(env),
      // A test shop's object reads that shop (stored by its first query, so a refresh alarm in a new isolate still has it);
      // every other object, and every object in the deployable build, reads SHOPIFY_SHOP.
      shopify: () => {
        const config = parseShopifyConfig(env)
        if (__INHOUSE_HUB_TEST__ && hubEnv.INHOUSE_TEST_BUILD === '1') {
          const testShop = storage.kv.get(TEST_SHOP_KEY)
          if (config !== null && typeof testShop === 'string') return { ...config, shop: testShop }
        }
        return config
      },
      scopesFor: async accountId => scopesFor(await loadRegistry(env), accountId),
      provider: accountId => providerFor(env, accountId),
      kindFor: async accountId => kindFor(await loadRegistry(env), accountId),
      // P5 (p5-w4)
      appOrigin: () => (env as HubEnv & { APP_ORIGIN?: unknown }).APP_ORIGIN,
    })
  }

  async #guard<T>(fn: () => Promise<HubResult<T>> | HubResult<T>): Promise<HubResult<T>> {
    try {
      return await fn()
    } catch {
      log('hub_internal', { code: 'internal' })
      return err('internal')
    } finally {
      if (__INHOUSE_HUB_TEST__ && (this.env as HubEnv).INHOUSE_TEST_BUILD === '1') {
        if (!this.ctx.id.equals(this.env.SIGNIN.idFromName(TEST_FAKES_DO_NAME))) await flushTestLogs(this.env)
      }
    }
  }

  /**
   * `testShop` (index.ts, a test build only, a host its seam registers, already checked there): this object is that
   * shop's, and stays it. Refused in the deployable build, and when the object already holds another shop.
   */
  query(req: QueryRequest & { testShop?: string }) {
    return this.#guard(() => {
      const { testShop, ...rest } = req
      if (testShop !== undefined) {
        if (!(__INHOUSE_HUB_TEST__ && (this.env as HubEnv).INHOUSE_TEST_BUILD === '1')) return err('invalid_args', 'testShopHost')
        const held = this.ctx.storage.kv.get(TEST_SHOP_KEY)
        if (held !== undefined && held !== testShop) return err('invalid_args', 'testShopHost')
        if (held === undefined) this.ctx.storage.kv.put(TEST_SHOP_KEY, testShop)
      }
      return this.#core.query(rest)
    })
  }
  /**
   * P5 #337: a test shop's object, granted before ConnectGateway.listAccounts reads its status (oauth/entry.ts). The same
   * guard and held-shop rule as `query`'s `testShop`: refused in the deployable build and when the object holds another shop.
   */
  warmTestShop(req: { accountId: string; testShop: string }) {
    return this.#guard(() => {
      if (!(__INHOUSE_HUB_TEST__ && (this.env as HubEnv).INHOUSE_TEST_BUILD === '1')) return err('invalid_args', 'testShopHost')
      const held = this.ctx.storage.kv.get(TEST_SHOP_KEY)
      if (held !== undefined && held !== req.testShop) return err('invalid_args', 'testShopHost')
      if (held === undefined) this.ctx.storage.kv.put(TEST_SHOP_KEY, req.testShop)
      return this.#core.warm(req.accountId)
    })
  }
  /** H0's fields plus P5's (paused, kind, connectedBy, connectedAt, revokeFailedAt, needsReconnect). */
  status(accountId: string) {
    return this.#guard(() => this.#core.accountStatus(accountId))
  }
  reencrypt(accountId: string) {
    return this.#guard(() => this.#core.reencrypt(accountId))
  }
  disconnect(accountId: string) {
    return this.#guard(() => this.#core.disconnect(accountId))
  }
  putPending(key: string, data: unknown, ttlMs: number) {
    return this.#guard(() => this.#core.putPending(key, data, ttlMs))
  }
  takePending(key: string) {
    return this.#guard(() => this.#core.takePending(key))
  }
  // ---- P5 (p5-w1) ----
  ready(accountId: string) {
    return this.#guard(() => this.#core.ready(accountId))
  }
  setPaused(accountId: string, paused: boolean) {
    return this.#guard(() => this.#core.setPaused(accountId, paused))
  }
  beginConnect(req: { accountId: string; memberId: string }) {
    return this.#guard(() => this.#core.beginConnect(req))
  }
  completeConnect(req: { state: string; code: string; memberId: string }) {
    return this.#guard(() => this.#core.completeConnect(req))
  }
  failConnect(req: { state: string; memberId: string }) {
    return this.#guard(() => this.#core.failConnect(req))
  }
  mcpCall(req: McpCallRequest) {
    return this.#guard(() => this.#core.mcpCall(req))
  }
  // ---- P5 (p5-w2) ----
  /** Code mode's per-run and per-day script caps (cm: keys). */
  bumpCounter(key: string, limit: number, ttlMs: number) {
    return this.#guard(() => this.#core.bumpCounter(key, limit, ttlMs))
  }
  // ---- P5 (p5-w4): Slack delivery, the only Web API calls (section 6) ----
  slackChannelInfo(accountId: string, channelId: string) {
    return this.#guard(() => this.#core.slackChannelInfo(accountId, channelId))
  }
  slackChannelList(accountId: string, cursor?: string) {
    return this.#guard(() => this.#core.slackChannelList(accountId, cursor))
  }
  slackPost(accountId: string, req: SlackPostRequest, expect?: SlackPostExpect) {
    return this.#guard(() => this.#core.slackPost(accountId, req, expect))
  }
  override async alarm(): Promise<void> {
    try {
      await this.#core.alarm()
    } finally {
      if (__INHOUSE_HUB_TEST__ && (this.env as HubEnv).INHOUSE_TEST_BUILD === '1') {
        if (!this.ctx.id.equals(this.env.SIGNIN.idFromName(TEST_FAKES_DO_NAME))) await flushTestLogs(this.env)
      }
    }
  }
  /**
   * TEST BUILD ONLY (singleton `__test-fakes__` DO): serves recorded upstream HTTP requests so every SignIn DO and
   * Worker isolate hits the same fake servers. Any other build or DO id answers 404.
   */
  override async fetch(request: Request): Promise<Response> {
    if (__INHOUSE_HUB_TEST__ && (this.env as HubEnv).INHOUSE_TEST_BUILD === '1') {
      if (!this.ctx.id.equals(this.env.SIGNIN.idFromName(TEST_FAKES_DO_NAME))) return new Response('not found', { status: 404 })
      const { attachFakeStorage, testUpstreamFetch } = await import('../testing/index')
      // #619: the fake write store's state lives in this DO's storage, so a restart of this isolate keeps its tokens.
      attachFakeStorage(this.ctx.storage)
      try {
        // The hub's env: on the eval hub it binds the eval D1, whose workspace the Slack fake serves (testing/eval-slack.ts).
        return await testUpstreamFetch(request, this.env)
      } catch (e) {
        // Tunnel an intentional network throw (FakeSlackWeb.throwNextPost, FakeMcpServer refreshModes:'unreachable')
        // back to upstreamFor without letting an unhandled DO exception reset the DO's in-memory fake state.
        const msg = safeError(e)
        return new Response(msg, { status: TEST_THROW_STATUS, headers: { [TEST_THROW_HEADER]: '1' } })
      }
    }
    return new Response('not found', { status: 404 })
  }
  /**
   * TEST BUILD ONLY (singleton `__test-fakes__` DO): runs a leaf test-fakes op (`state`, `reset`, `set`, `var`, `logs`,
   * `seed`) in the same DO isolate that serves upstream fetches. Refused outside the test build or on any account DO.
   */
  async testFakesOp(op: unknown): Promise<HubResult<unknown>> {
    if (__INHOUSE_HUB_TEST__ && (this.env as HubEnv).INHOUSE_TEST_BUILD === '1') {
      if (!this.ctx.id.equals(this.env.SIGNIN.idFromName(TEST_FAKES_DO_NAME))) return err('not_configured', 'testFakesOp')
      const { runHubFakesInDo } = await import('../testing/fakes')
      return runHubFakesInDo(this.ctx.storage, op)
    }
    return err('not_configured', 'testFakesOp')
  }
  /** TEST BUILD ONLY (singleton `__test-fakes__` DO): reads `op: 'var'` overrides persisted in this DO's SQLite KV. */
  async testGetVars(): Promise<Record<string, string>> {
    if (__INHOUSE_HUB_TEST__ && (this.env as HubEnv).INHOUSE_TEST_BUILD === '1') {
      if (!this.ctx.id.equals(this.env.SIGNIN.idFromName(TEST_FAKES_DO_NAME))) return {}
      return this.ctx.storage.kv.get<Record<string, string>>(TEST_FAKES_VARS_KEY) ?? {}
    }
    return {}
  }
  /** TEST BUILD ONLY (singleton `__test-fakes__` DO): appends a ConnectGateway answer JSON string for `state.connect.bodies`. */
  async testRecordConnectBody(body: string): Promise<void> {
    if (__INHOUSE_HUB_TEST__ && (this.env as HubEnv).INHOUSE_TEST_BUILD === '1') {
      if (!this.ctx.id.equals(this.env.SIGNIN.idFromName(TEST_FAKES_DO_NAME))) return
      const { recordConnectBody } = await import('../testing/fakes')
      recordConnectBody(body)
    }
  }
  /** TEST BUILD ONLY (singleton `__test-fakes__` DO): appends flushed hub log lines from any gateway or SignIn DO isolate. */
  async testAppendLogs(lines: string[]): Promise<void> {
    if (__INHOUSE_HUB_TEST__ && (this.env as HubEnv).INHOUSE_TEST_BUILD === '1') {
      if (!this.ctx.id.equals(this.env.SIGNIN.idFromName(TEST_FAKES_DO_NAME))) return
      const { appendHubLogs } = await import('../testing/fakes')
      appendHubLogs(lines)
    }
  }
  /**
   * TEST BUILD ONLY (W5's test-fakes hook, op `alarm`): runs this account's alarm body once now. Anywhere else (the
   * deployable bundle, or the test bundle not switched on) it refuses with `not_configured` and runs nothing.
   */
  async testFireAlarm(): Promise<HubResult<{ fired: true }>> {
    if (!(__INHOUSE_HUB_TEST__ && (this.env as HubEnv).INHOUSE_TEST_BUILD === '1')) return err('not_configured', 'testFireAlarm')
    return this.#guard(async () => {
      await this.#core.alarm()
      return { ok: true, value: { fired: true as const } }
    })
  }
}
