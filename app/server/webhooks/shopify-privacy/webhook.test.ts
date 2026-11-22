// Shopify's privacy webhooks (P8a F2) through serveWebhook, as server/index.ts serves them, on the real D1. Ways they
// could fail, written down first:
//  1. a missing, wrong-secret or tampered signature records anything, or answers anything but 401 (Shopify's check
//     sends a bad HMAC and expects 401);
//  2. a signed delivery answers anything but 2xx, or records it without its audit line or the admins' notice;
//  3. Shopify's retry of one delivery (the same X-Shopify-Webhook-Id) records a second row, line or notice;
//  4. the customer's email or phone reaches the row, the audit line or the notice;
//  5. a body over the cap, a non-JSON Content-Type, another topic's header or payload is recorded;
//  6. the secrets are unset or malformed and a delivery still verifies (or is answered 401, so Shopify gives up instead
//     of retrying our misconfiguration);
//  7. another method on a webhook path is served without sign-in, or a webhook route without its `webhook` row runs;
//  8. closing a request leaves the Shopify ids on it, writes no line, or closes it twice;
//  9. the health signal stays green while a request is open, or red after it's closed.
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accessMatrix } from '../../access-matrix.ts'
import { webhookRoutes } from '../../routes.ts'
import { lastLineId } from '../../db/test-support.ts'
import { serveWebhook } from '../serve.ts'
import { MAX_BODY_BYTES } from './handler.ts'
import { signShopifyBody } from './hmac.ts'
import { privacySignal } from './signal.ts'
import { DUE_MS, privacyRequestStore, requestIdFor } from './store.ts'

const db = env.DB
const READ = 'test-only-webhook-read-app-secret'
const WRITE = 'test-only-webhook-write-app-secret'
const hookEnv = { DB: db, SHOPIFY_WEBHOOK_SECRETS: JSON.stringify([READ, WRITE]) }
const enc = new TextEncoder()
const EMAIL = 'invented.customer@example.test'
const PHONE = '+15550100999'

const PAYLOADS = {
  'customers/data_request': { path: 'customers-data-request', body: { shop_id: 954889, shop_domain: 'invented-shop.myshopify.com', orders_requested: [299938, 280263], customer: { id: 191167, email: EMAIL, phone: PHONE }, data_request: { id: 9999 } } },
  'customers/redact': { path: 'customers-redact', body: { shop_id: 954889, shop_domain: 'invented-shop.myshopify.com', customer: { id: 191167, email: EMAIL, phone: PHONE }, orders_to_redact: [299938, 280263, 220458] } },
  'shop/redact': { path: 'shop-redact', body: { shop_id: 954889, shop_domain: 'invented-shop.myshopify.com' } },
} as const
type Topic = keyof typeof PAYLOADS

let n = 0
const newWebhookId = () => `wh-${Date.now()}-${++n}`

async function deliver(topic: Topic, o: { webhookId?: string; secret?: string | null; raw?: string; tamper?: boolean; contentType?: string; topicHeader?: string; method?: string; env?: Record<string, unknown> } = {}) {
  const raw = o.raw ?? JSON.stringify(PAYLOADS[topic].body)
  const bytes = enc.encode(raw)
  const headers: Record<string, string> = {
    'Content-Type': o.contentType ?? 'application/json', 'X-Shopify-Topic': o.topicHeader ?? topic, 'X-Shopify-Webhook-Id': o.webhookId ?? newWebhookId(),
    'X-Shopify-Shop-Domain': 'invented-shop.myshopify.com', 'X-Shopify-API-Version': '2026-10',
  }
  if (o.secret !== null) headers['X-Shopify-Hmac-Sha256'] = await signShopifyBody(bytes, o.secret ?? READ)
  const sent = o.tamper ? raw.replace('954889', '954880') : raw
  const request = new Request(`http://brand.localhost:8787/api/webhooks/shopify/${PAYLOADS[topic].path}`, { method: o.method ?? 'POST', headers, body: o.method === 'GET' ? undefined : sent })
  const res = await serveWebhook(webhookRoutes, accessMatrix, request, (o.env ?? hookEnv) as typeof hookEnv, 'req-hook')
  return { res, webhookId: headers['X-Shopify-Webhook-Id'] }
}

let mark = 0
beforeEach(async () => {
  mark = await lastLineId(db)
  await db.prepare('DELETE FROM privacy_requests').run()
  await db.prepare("DELETE FROM notices WHERE source = 'shopify-privacy'").run()
})
afterEach(() => vi.restoreAllMocks())
const lines = async () => (await db.prepare('SELECT actor_id, action, target_kind, target_id, args_json FROM audit_log WHERE id > ? ORDER BY id').bind(mark).all()).results
const requests = async () => (await db.prepare('SELECT * FROM privacy_requests ORDER BY received_at_ms, id').all<Record<string, unknown>>()).results
const notices = async () => (await db.prepare("SELECT id, audience, template, fields_json, body, person_id FROM notices WHERE source = 'shopify-privacy' ORDER BY id").all()).results

describe('the signature (failure 1)', () => {
  it.each([
    ['missing', { secret: null }], ['signed with another secret', { secret: 'another-app-secret-not-ours' }], ['a tampered body', { tamper: true }],
  ] as const)('%s: 401 unauthorized, nothing recorded', async (_, o) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const topic of Object.keys(PAYLOADS) as Topic[]) {
      const { res } = await deliver(topic, o)
      expect(res?.status).toBe(401)
      expect(await res?.json()).toEqual({ error: { code: 'unauthorized' } })
      expect(res?.headers.get('Cache-Control')).toBe('no-store')
    }
    expect(await requests()).toEqual([])
    expect(await lines()).toEqual([])
    expect(await notices()).toEqual([])
  })
  it('a malformed header is 401 too, and the write app\'s secret verifies like the read app\'s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bytes = enc.encode(JSON.stringify(PAYLOADS['shop/redact'].body))
    const req = new Request('http://brand.localhost:8787/api/webhooks/shopify/shop-redact', {
      method: 'POST', body: bytes, headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': 'shop/redact', 'X-Shopify-Webhook-Id': 'wh-x', 'X-Shopify-Hmac-Sha256': 'not-a-signature' },
    })
    expect((await serveWebhook(webhookRoutes, accessMatrix, req, hookEnv, 'r'))?.status).toBe(401)
    expect((await deliver('shop/redact', { secret: WRITE })).res?.status).toBe(200)
  })
})

describe('a signed delivery (failures 2 to 4)', () => {
  it.each(Object.keys(PAYLOADS) as Topic[])('%s: 200, one row, one privacy.requested line, one admins notice; no email or phone anywhere', async topic => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { res, webhookId } = await deliver(topic)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ ok: true })
    const id = await requestIdFor(webhookId)
    const rows = await requests()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row).toMatchObject({ id, webhook_id: webhookId, topic, shop_id: 954889, status: 'open', closed_at_ms: null })
    expect(row.due_at_ms).toBe(Number(row.received_at_ms) + DUE_MS)
    if (topic === 'customers/data_request') expect(row).toMatchObject({ customer_id: '191167', order_ids_json: '[299938,280263]', data_request_id: '9999' })
    if (topic === 'customers/redact') expect(row).toMatchObject({ customer_id: '191167', order_ids_json: '[299938,280263,220458]', data_request_id: null })
    if (topic === 'shop/redact') expect(row).toMatchObject({ customer_id: null, order_ids_json: null, data_request_id: null })
    expect(await lines()).toEqual([{ actor_id: 'm_system', action: 'privacy.requested', target_kind: null, target_id: null, args_json: JSON.stringify({ requestId: id, topic }) }])
    const template = { 'customers/data_request': 'privacy_data_request', 'customers/redact': 'privacy_customer_redact', 'shop/redact': 'privacy_shop_redact' }[topic]
    expect(await notices()).toEqual([{ id: `privacy-${id}`, audience: 'admins', template, fields_json: '{}', body: null, person_id: null }])
    const stored = JSON.stringify([rows, await lines(), await notices()])
    for (const secret of [EMAIL, PHONE, 'invented-shop']) expect(stored).not.toContain(secret)
  })
  it('Shopify\'s retry of the same delivery answers 200 and writes nothing more (failure 3)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const webhookId = newWebhookId()
    for (let i = 0; i < 3; i++) expect((await deliver('customers/redact', { webhookId })).res?.status).toBe(200)
    expect(await requests()).toHaveLength(1)
    expect(await lines()).toHaveLength(1)
    expect(await notices()).toHaveLength(1)
    // A new delivery of the same topic is its own request.
    expect((await deliver('customers/redact')).res?.status).toBe(200)
    expect(await requests()).toHaveLength(2)
    expect(await lines()).toHaveLength(2)
  })
})

describe('refused before anything is recorded (failures 5 to 7)', () => {
  it('a body over the cap (413 as invalid too_large), a non-JSON type, another topic or a bad payload is 400', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const big = JSON.stringify({ shop_id: 1, pad: 'x'.repeat(MAX_BODY_BYTES) })
    const tooBig = await deliver('shop/redact', { raw: big })
    expect(tooBig.res?.status).toBe(400)
    expect(await tooBig.res?.json()).toEqual({ error: { code: 'invalid', reason: 'too_large' } })
    expect((await deliver('shop/redact', { contentType: 'text/plain' })).res?.status).toBe(400)
    expect((await deliver('shop/redact', { topicHeader: 'customers/redact' })).res?.status).toBe(400)
    expect((await deliver('customers/redact', { raw: JSON.stringify(PAYLOADS['shop/redact'].body) })).res?.status).toBe(400)
    expect((await deliver('shop/redact', { raw: '{"shop_id":' })).res?.status).toBe(400)
    expect((await deliver('shop/redact', { webhookId: 'bad id with spaces' })).res?.status).toBe(400)
    expect(await requests()).toEqual([])
    expect(await lines()).toEqual([])
  })
  it('unset or malformed secrets: 503, never 401, and nothing verifies (failure 6)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const secrets of [undefined, '', 'not json', '[]', '["short"]', JSON.stringify([READ, WRITE, READ, WRITE, READ])]) {
      const { res } = await deliver('shop/redact', { env: { DB: db, SHOPIFY_WEBHOOK_SECRETS: secrets } })
      expect(res?.status, String(secrets)).toBe(503)
    }
    expect(error.mock.calls.every(([e]) => (e as { event: string }).event === 'privacy_webhook_secrets_invalid')).toBe(true)
    expect(await requests()).toEqual([])
  })
  it('another method on a webhook path, or another path, is not served here (failure 7)', async () => {
    expect((await deliver('shop/redact', { method: 'GET' })).res).toBeNull()
    expect((await deliver('shop/redact', { method: 'PUT' })).res).toBeNull()
    const other = new Request('http://brand.localhost:8787/api/webhooks/shopify/orders-create', { method: 'POST', body: '{}' })
    expect(await serveWebhook(webhookRoutes, accessMatrix, other, hookEnv, 'r')).toBeNull()
  })
  it('a webhook route without its webhook row answers 500 and never runs (failure 7)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = vi.fn(async () => new Response('ran'))
    const table = [{ method: 'POST' as const, pattern: '/api/webhooks/shopify/shop-redact', handler }]
    const rows = accessMatrix.map(r => (r.pattern === '/api/webhooks/shopify/shop-redact' ? { ...r, class: 'open' as const } : r))
    const req = new Request('http://brand.localhost:8787/api/webhooks/shopify/shop-redact', { method: 'POST', body: '{}' })
    expect((await serveWebhook(table, rows, req, hookEnv, 'r'))?.status).toBe(500)
    expect(handler).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith({ event: 'route_without_matrix_row', requestId: 'r', method: 'POST', pattern: '/api/webhooks/shopify/shop-redact' })
  })
})

describe('closing a request and the health signal (failures 8 and 9)', () => {
  it('the signal is red while one is open; closing clears the Shopify ids, writes privacy.closed once, and the signal goes green', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = privacyRequestStore(db)
    expect(await privacySignal(store, Date.now())).toEqual({ ok: true })
    const { webhookId } = await deliver('customers/data_request')
    const id = await requestIdFor(webhookId)
    const received = Number((await requests())[0].received_at_ms)
    expect(await privacySignal(store, received)).toEqual({ ok: false, detail: '1 open, 30 days left on the oldest' })
    expect(await privacySignal(store, received + DUE_MS + 86_400_000)).toEqual({ ok: false, detail: '1 open, -1 days left on the oldest' })
    mark = await lastLineId(db)
    expect(await store.close(id, { nowMs: received + 1000, requestId: 'req-close' })).toBe('closed')
    expect(await store.close(id, { nowMs: received + 2000, requestId: 'req-close-2' })).toBe('already_closed')
    expect(await store.close('pr_AAAAAAAAAAAAAAAAAAAAAA', { nowMs: received, requestId: 'r' })).toBe('not_found')
    expect((await requests())[0]).toMatchObject({ status: 'closed', closed_at_ms: received + 1000, customer_id: null, order_ids_json: null, data_request_id: null, topic: 'customers/data_request' })
    expect(await lines()).toEqual([{ actor_id: 'm_system', action: 'privacy.closed', target_kind: null, target_id: null, args_json: JSON.stringify({ requestId: id, topic: 'customers/data_request', by: 'release' }) }])
    expect(await privacySignal(store, Date.now())).toEqual({ ok: true })
  })
  it('the table refuses a closed row that still names a customer', async () => {
    await expect(db.prepare(
      "INSERT INTO privacy_requests (id, webhook_id, topic, shop_id, customer_id, received_at_ms, due_at_ms, status, closed_at_ms, req_id) VALUES ('pr_BBBBBBBBBBBBBBBBBBBBBB', 'w', 'customers/redact', 1, '5', 1, 2, 'closed', 3, 'r')",
    ).run()).rejects.toThrow(/CHECK/)
  })
})
