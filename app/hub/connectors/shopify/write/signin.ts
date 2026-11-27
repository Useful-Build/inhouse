// The ShopifyWriteSignIn Durable Object (Stage 1 M2-C, N13, P6 W5): a separate SignIn DO for the write-scoped Shopify
// app, so its token never shares storage or credentials with the read app's SignIn DO.
// Re-exported from hub/index/index.ts and bound as `SHOPIFY_WRITE_SIGNIN` in wrangler.hub*.jsonc.
import { DurableObject } from 'cloudflare:workers'
import type { AccountStatus, HubResult, WriteResult } from '../../../index/contract'
import { log } from '../../../index/log'
import { keyRingFor } from '../../../crypto/keyring'
import type { SyncStore } from '../../../signin/core'
import { flushTestLogs, signInFor, upstreamFor } from '../../../signin/signin'
import { ShopifyWriteCore, type ShopifyWriteInput } from './core'
import { parseShopifyWriteConfig, writeErr } from './provider'
import { settledAnswer } from '../../../../shared/rpc-answer'

/** `Env` (generated) plus what it can't name: the test build's flag and the optional write app secret. */
export type HubWriteEnv = Env & { INHOUSE_TEST_BUILD?: string; SHOPIFY_WRITE_CLIENT_SECRET?: string }

export class ShopifyWriteSignIn extends DurableObject<Env> {
  readonly #core: ShopifyWriteCore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    const hubEnv: HubWriteEnv = env
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
      accountStatus: async accountId => (await settledAnswer(signInFor(env, accountId).status(accountId))) as HubResult<AccountStatus>,
    })
  }

  /**
   * Runs one Shopify write operation (`ops/`) against the write-scoped Shopify app.
   * Stage 1: only runs in the test build against the fake write upstream; the deployable build answers `not_configured`.
   */
  async runWrite(req: ShopifyWriteInput): Promise<WriteResult> {
    try {
      const hubEnv: HubWriteEnv = this.env
      if (!(__INHOUSE_HUB_TEST__ && hubEnv.INHOUSE_TEST_BUILD === '1')) {
        return writeErr('not_configured', 'no', 'shopify_write')
      }
      return await this.#core.run(req)
    } catch {
      log('hub_internal', { code: 'internal' })
      return writeErr('internal', 'unknown')
    } finally {
      await flushTestLogs(this.env)
    }
  }

  /**
   * Stage 1 M3-S2 (N21): the write store's currency for the connect/status answer (`ConnectGateway.listAccounts`), read
   * with the write token and kept a day. Gated as `runWrite` is: the deployable build answers null and reads nothing.
   */
  async shopCurrency(): Promise<string | null> {
    try {
      const hubEnv: HubWriteEnv = this.env
      if (!(__INHOUSE_HUB_TEST__ && hubEnv.INHOUSE_TEST_BUILD === '1')) return null
      return await this.#core.currency()
    } catch {
      log('hub_internal', { code: 'internal' })
      return null
    } finally {
      await flushTestLogs(this.env)
    }
  }
}
