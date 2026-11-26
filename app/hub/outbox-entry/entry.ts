// WriteGateway (Stage 1 M2-C, N13): a named WorkerEntrypoint, re-exported from hub/index/index.ts, bound ONLY by
// `app/server/outbox/dispatch.ts` as `HUB_WRITE`. The agent's sandbox never holds this binding, and ReadGateway never
// writes. Every unexpected exception is logged as `internal` without its text and returned as `sent: 'unknown'`.
//
// Stage 1: writes run only in the test build against the fake upstreams (`example-write.myshopify.com`, `FakeSlackWeb`).
// In the deployable build (`__INHOUSE_HUB_TEST__ === false`), every valid write request answers `not_configured` with
// `sent: 'no'` and never touches a live upstream.
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { WriteGateway as WriteApi, WriteRequest, WriteResult } from '../index/contract'
import { hubError } from '../index/errors'
import { log } from '../index/log'
import { flushTestLogs, signInFor } from '../signin/signin'
import { SHOPIFY_WRITE_SIGNIN_ACCOUNT } from '../connectors/shopify/write/provider'
import type { HubWriteEnv } from '../connectors/shopify/write/signin'
import { postSlackOutboxAction, type SlackOutboxStub } from '../connectors/slack/outbox'
import { SLACK_ACCOUNT } from '../connectors/slack/post'
import { runWriteAction, type WriteGatewayDeps } from './gateway'

export class WriteGateway extends WorkerEntrypoint<Env> implements WriteApi {
  #deps(): WriteGatewayDeps {
    const hubEnv: HubWriteEnv = this.env
    if (__INHOUSE_HUB_TEST__ && hubEnv.INHOUSE_TEST_BUILD === '1') {
      return {
        shopifyOrderTagAdd: async input => {
          const ns = hubEnv.SHOPIFY_WRITE_SIGNIN
          const stub = ns.get(ns.idFromName(SHOPIFY_WRITE_SIGNIN_ACCOUNT))
          return (await stub.orderTagAdd(input)) as WriteResult
        },
        slackChannelPost: input =>
          postSlackOutboxAction(signInFor(this.env, SLACK_ACCOUNT) as unknown as SlackOutboxStub, input),
      }
    }
    return {
      shopifyOrderTagAdd: async () => ({ ok: false, error: hubError('not_configured', 'shopify_write'), sent: 'no' }),
      slackChannelPost: async () => ({ ok: false, error: hubError('not_configured', 'slack_write'), sent: 'no' }),
    }
  }

  async runAction(req: WriteRequest): Promise<WriteResult> {
    try {
      return await runWriteAction(this.#deps(), req)
    } catch {
      log('hub_internal', { code: 'internal' })
      return { ok: false, error: hubError('internal'), sent: 'unknown' }
    } finally {
      await flushTestLogs(this.env)
    }
  }
}
