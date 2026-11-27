// Stage 1 M3-R (N30): EvalWriteGateway through the test build's exports on workerd. The test config binds no
// EVAL_WRITE_LOG (only the eval hub's config does), so here it must answer `not_configured`, sure nothing went out: a hub
// without the log never pretends a write happened. Its log on a real D1 is server/outbox/eval-write-log.test.ts's.
import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { WriteGateway, WriteRequest } from '../index/contract'
import { WriteResultSchema } from '../index/schemas'
import { hubError } from '../index/errors'
import { EVAL_ERROR_TEXT, hubError as evalHubError } from './eval-write'

const gw = exports as unknown as { EvalWriteGateway?: WriteGateway }

describe('EvalWriteGateway in the hub test build', () => {
  it('is exported by the test build\'s main module, and without its D1 refuses, writing nothing', async () => {
    expect(gw.EvalWriteGateway).toBeDefined()
    const req: WriteRequest = {
      actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', attempt: 1, requestId: 'req-eval-1', accountId: 'shopify:store',
      expect: { connectedAtMs: 1, shop: 'example-write' }, operation: 'shopify.order.tag_add', args: { orderId: 'gid://shopify/Order/1', tags: ['vip'] },
    }
    const r = await gw.EvalWriteGateway!.runAction(req)
    expect(WriteResultSchema.safeParse(r).success).toBe(true)
    expect(r).toEqual({ ok: false, error: { code: 'not_configured', message: 'connector not configured: eval_write_log' }, sent: 'no' })
  })

  it('its error texts are index/errors.ts\'s (copied there so the server tests can import it)', () => {
    for (const code of Object.keys(EVAL_ERROR_TEXT) as (keyof typeof EVAL_ERROR_TEXT)[]) {
      expect(evalHubError(code)).toEqual(hubError(code))
      expect(evalHubError(code, 'eval_fault', 7)).toEqual(hubError(code, 'eval_fault', 7))
    }
  })
})
