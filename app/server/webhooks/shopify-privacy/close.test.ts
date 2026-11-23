// Route 94, `POST /api/ops/privacy-requests/:id/close` (P8a F2), the handler on the real D1 stores. The access row
// (release only, class open) is proven by the matrix oracle (auth/matrix.test.ts) and the e2e kit's case. Ways it can
// fail: an unknown or malformed id answers anything but 404 or writes a line; a close answers without clearing the
// request; a second close writes a second line.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { openStores } from '../../db/stores.ts'
import { ctx, lastLineId, reqId } from '../../db/test-support.ts'
import type { Principal } from '../../auth/index.ts'
import type { HandlerContext } from '../../routes.ts'
import { closePrivacyRequest } from './close.ts'
import { privacyRequestStore } from './store.ts'

const db = env.DB
const stores = openStores(env)
const release = (): Principal => ({ kind: 'service', name: 'release', requestId: reqId() })
const call = async (id: string) => {
  const { c } = ctx(stores, release(), { method: 'POST', path: `/api/ops/privacy-requests/${id}/close`, params: { id } })
  const res = await closePrivacyRequest({ ...c, env, ctx: {} as ExecutionContext } as HandlerContext)
  return { status: res.status, body: await res.json() }
}
let mark = 0
beforeEach(async () => {
  await db.prepare('DELETE FROM privacy_requests').run()
  mark = await lastLineId(db)
})
const actions = async () => (await db.prepare('SELECT action FROM audit_log WHERE id > ? ORDER BY id').bind(mark).all<{ action: string }>()).results.map(r => r.action)

describe('route 94', () => {
  it('closes an open request once: closed, then already_closed, one privacy.closed line', async () => {
    const { id } = await privacyRequestStore(db).record(
      { webhookId: 'wh-close-1', bodySha256: 'c'.repeat(64), topic: 'customers/redact', parsed: { shopId: 1, customerId: '42', orderIds: [7], dataRequestId: null } }, { nowMs: 1_800_000_000_000, requestId: 'req-rec' },
    )
    mark = await lastLineId(db)
    expect(await call(id)).toEqual({ status: 200, body: { result: 'closed' } })
    expect(await call(id)).toEqual({ status: 200, body: { result: 'already_closed' } })
    expect(await actions()).toEqual(['privacy.closed'])
    expect(await db.prepare('SELECT status, customer_id, order_ids_json FROM privacy_requests WHERE id = ?').bind(id).first()).toEqual({ status: 'closed', customer_id: null, order_ids_json: null })
  })
  it('an unknown or malformed id is 404 and writes no line', async () => {
    for (const id of ['pr_AAAAAAAAAAAAAAAAAAAAAA', 'nope', 'pr_short']) expect((await call(id)).status, id).toBe(404)
    expect(await actions()).toEqual([])
  })
})
