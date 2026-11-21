// The SignIn Durable Object: one per connector account (env.SIGNIN.idFromName(accountId)), SQLite backed. A thin
// wrapper: the state machine is core.ts over ctx.storage.kv (synchronous), ctx.storage.setAlarm and Date.now().
// This module also holds the runtime glue the entrypoints share (the registry load and the upstream), since it's the
// one place that may hold the guarded test branch: node tests never import this file (it imports cloudflare:workers).
// Docs read 2026-11-20: SQLite storage API (ctx.storage.kv, transactionSync), Alarms, Durable Objects rules, lifecycle.
import { DurableObject } from 'cloudflare:workers'
import { connectors } from '../connectors/index'
import type { HubResult } from '../index/contract'
import { err } from '../index/errors'
import { log } from '../index/log'
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
    }
    return buildRegistry(modules)
  })().catch((e: unknown) => {
    log('hub_config_invalid', { code: 'registry' })
    throw e
  })
  return registry
}

/** globalThis.fetch, except in the test build, where PR0's seam answers from recorded upstreams. */
export async function upstreamFor(env: HubEnv): Promise<Upstream> {
  if (__INHOUSE_HUB_TEST__ && env.INHOUSE_TEST_BUILD === '1') {
    const { testUpstreamFetch } = await import('../testing/index')
    return testUpstreamFetch
  }
  return req => fetch(req)
}

/** Env only, synchronous. Shopify: H0's three settings. An oauth_mcp connector: its own `configure(env)` (P5 W1). */
export const isConfigured = (env: HubEnv, connector: HubConnector): boolean =>
  isMcpConnector(connector) ? connector.configure(envRecord(env)) !== null : connector.id === 'shopify' && parseShopifyConfig(env) !== null

const envRecord = (env: HubEnv): Readonly<Record<string, unknown>> => env as unknown as Readonly<Record<string, unknown>>

/** The OAuth provider for an account: its module and this deployment's client settings. Null when unconfigured. */
export async function providerFor(env: HubEnv, accountId: string): Promise<McpProvider | null> {
  const connector = mcpConnectorFor(await loadRegistry(env), accountId)
  if (!connector) return null
  const clientConfig = connector.configure(envRecord(env))
  return clientConfig ? { kind: 'oauth_mcp', connector, clientConfig } : null
}

export const signInFor = (env: Env, accountId: string) => env.SIGNIN.get(env.SIGNIN.idFromName(accountId))

/**
 * The ReadGateway's deps with readiness and the MCP proxy (P5 W1). index.ts's ReadGateway uses these through the
 * orchestrator's wiring line: `listReadyTools(await readyGatewayDeps(this.env))`, `callReadyTool(...)`.
 */
export async function readyGatewayDeps(env: Env): Promise<ReadyGatewayDeps> {
  const registry = await loadRegistry(env)
  return {
    registry,
    isConfigured: c => isConfigured(env, c),
    shopifyFor: (c: HubConnector): ShopifyReadClient => ({
      graphql: async (document, variables, apiVersion) => {
        const version = apiVersion ?? (isMcpConnector(c) ? undefined : c.apiVersion)
        if (!version) return err('invalid_args', 'apiVersion')
        return (await signInFor(env, c.accountId).query({ accountId: c.accountId, document, variables, apiVersion: version })) as HubResult<{ data: unknown }>
      },
    }),
    nowMs: () => Date.now(),
    isReady: async accountId => {
      const r = await signInFor(env, accountId).ready(accountId)
      return r.ok ? r.value : { ready: false, code: 'not_configured' }
    },
    mcpFor: (c: McpConnectorModule): McpClient => ({
      call: async (upstream, args) => (await signInFor(env, c.accountId).mcpCall({ accountId: c.accountId, upstream, args })) as never,
    }),
  }
}

export class SignIn extends DurableObject<Env> {
  readonly #core: SignInCore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
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
      shopify: () => parseShopifyConfig(env),
      scopesFor: async accountId => scopesFor(await loadRegistry(env), accountId),
      provider: accountId => providerFor(env, accountId),
      kindFor: async accountId => kindFor(await loadRegistry(env), accountId),
    })
  }

  async #guard<T>(fn: () => Promise<HubResult<T>> | HubResult<T>): Promise<HubResult<T>> {
    try {
      return await fn()
    } catch {
      log('hub_internal', { code: 'internal' })
      return err('internal')
    }
  }

  query(req: QueryRequest) {
    return this.#guard(() => this.#core.query(req))
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
  override async alarm(): Promise<void> {
    await this.#core.alarm()
  }
}
