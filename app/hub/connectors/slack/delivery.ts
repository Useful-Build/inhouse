// DeliveryGateway (P5 W4, p5-w4.md section 6): a named WorkerEntrypoint, re-exported from index/index.ts by an
// orchestrator line, bound only by product Worker server code as `HUB_DELIVERY`. What keeps the runner off it is code
// discipline plus checks: this entrypoint refuses a `run` scope, and the product's lint rule and tests keep the egress
// from holding or importing it. Typed RPC only; every method returns a HubResult, and an unexpected exception is logged
// as `internal` without its text. Docs read 2026-11-21: service bindings RPC (named entrypoints).
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { CallerScope, HubResult } from '../../index/contract'
import { err } from '../../index/errors'
import { log } from '../../index/log'
import { flushTestLogs, signInFor } from '../../signin/signin'
import type { DeliveryGateway as DeliveryApi, PostNoticeRequest, SlackChannel } from './contract'
import { checkChannel, listChannels, postNotice, type DeliveryDeps, type DeliveryStub } from './gateway'

async function guarded<T>(env: Env, fn: () => Promise<HubResult<T>>): Promise<HubResult<T>> {
  try {
    return await fn()
  } catch {
    log('hub_internal', { code: 'internal' })
    return err('internal')
  } finally {
    await flushTestLogs(env)
  }
}

export class DeliveryGateway extends WorkerEntrypoint<Env> implements DeliveryApi {
  #deps(): DeliveryDeps {
    return { signIn: accountId => signInFor(this.env, accountId) as unknown as DeliveryStub }
  }

  async postNotice(scope: CallerScope, req: PostNoticeRequest): Promise<HubResult<{ ts: string }>> {
    return guarded(this.env, () => postNotice(this.#deps(), scope, req))
  }

  async listChannels(scope: CallerScope, req: { accountId: 'slack:workspace'; cursor?: string }): Promise<HubResult<{ channels: SlackChannel[]; nextCursor: string | null }>> {
    return guarded(this.env, () => listChannels(this.#deps(), scope, req))
  }

  async checkChannel(scope: CallerScope, req: { accountId: 'slack:workspace'; channelId: string }): Promise<HubResult<SlackChannel>> {
    return guarded(this.env, () => checkChannel(this.#deps(), scope, req))
  }
}
