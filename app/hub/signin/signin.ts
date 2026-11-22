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
import { buildRegistry, scopesFor, type ConnectorModule, type Registry } from '../registry/registry'
import { parseShopifyConfig, type Upstream } from './providers/shopify'
import { SignInCore, type QueryRequest, type SyncStore } from './core'

type HubEnv = Env & { INHOUSE_TEST_BUILD?: string }

// The guard is written out in full at each use (never behind a helper call), so esbuild sees `false && ...` in the
// deployable build and drops the branch with its dynamic import.
let registry: Promise<Registry> | null = null

/** Built once per isolate. A malformed module rejects every call (loud, never half open). */
export function loadRegistry(env: HubEnv): Promise<Registry> {
  registry ??= (async () => {
    const modules: ConnectorModule[] = [...(connectors as readonly ConnectorModule[])]
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

/** Shopify is the only provider in P4. Other connectors are configured from P5 (OAuth). */
export const isConfigured = (env: HubEnv, connector: ConnectorModule): boolean =>
  connector.id === 'shopify' && parseShopifyConfig(env) !== null

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
  status(accountId: string) {
    return this.#guard(() => this.#core.status(accountId))
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
  override async alarm(): Promise<void> {
    await this.#core.alarm()
  }
}
