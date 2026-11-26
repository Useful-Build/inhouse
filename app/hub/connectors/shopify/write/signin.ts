// The ShopifyWriteSignIn Durable Object (Stage 1 M2-C, N13, P6 W5): a separate SignIn DO for the write-scoped Shopify
// app, so its token never shares storage or credentials with the read app's SignIn DO.
// Re-exported from hub/index/index.ts and bound as `SHOPIFY_WRITE_SIGNIN` in wrangler.hub*.jsonc.
import { DurableObject } from 'cloudflare:workers'
import type { AccountStatus, HubResult, WriteResult } from '../../../index/contract'
import { log } from '../../../index/log'
import { keyRingFor } from '../../../crypto/keyring'
import type { SyncStore } from '../../../signin/core'
import { flushTestLogs, signInFor, upstreamFor } from '../../../signin/signin'
import { ShopifyWriteCore } from './core'
import { parseShopifyWriteConfig, writeErr } from './provider'

export type HubWriteEnv = Env & {
  INHOUSE_TEST_BUILD?: string
  SHOPIFY_WRITE_SHOP?: string
  SHOPIFY_WRITE_CLIENT_ID?: string
  SHOPIFY_WRITE_CLIENT_SECRET?: string
  SHOPIFY_WRITE_SIGNIN?: DurableObjectNamespace<ShopifyWriteSignIn>
}

export class ShopifyWriteSignIn extends DurableObject<Env> {
  readonly #core: ShopifyWriteCore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    const hubEnv = env as HubWriteEnv
    const store: SyncStore = {
      get: key => storage.kv.get(key),
      put: (key, value) => storage.kv.put(key, value),
      delete: key => storage.kv.delete(key),
      list: prefix => storage.kv.list({ prefix }),
      transactionSync: fn => storage.transactionSync(fn),
    }
    this.#core = new ShopifyWriteCore({
      store,
      now: () => Date.now(),
      upstream: () => upstreamFor(hubEnv),
      keyring: () => keyRingFor(hubEnv),
      config: () => parseShopifyWriteConfig(hubEnv),
      accountStatus: async accountId => (await signInFor(env, accountId).status(accountId)) as HubResult<AccountStatus>,
    })
  }

  /**
   * Runs `shopify.order.tag_add` against the write-scoped Shopify app.
   * Stage 1: only runs in the test build against the fake write upstream; the deployable build answers `not_configured`.
   */
  async orderTagAdd(req: {
    accountId: string
    expect: { connectedAtMs: number }
    args: unknown
  }): Promise<WriteResult> {
    try {
      const hubEnv = this.env as HubWriteEnv
      if (!(__INHOUSE_HUB_TEST__ && hubEnv.INHOUSE_TEST_BUILD === '1')) {
        return writeErr('not_configured', 'no', 'shopify_write')
      }
      return await this.#core.orderTagAdd(req)
    } catch {
      log('hub_internal', { code: 'internal' })
      return writeErr('internal', 'unknown')
    } finally {
      await flushTestLogs(this.env)
    }
  }
}
