// Shopify's privacy webhooks (P8a F2) through serveWebhook, as server/index.ts serves them, on the real D1. Ways they
// could fail, written down first:
//  1. a missing, wrong-secret or tampered signature records anything, or answers anything but 401 (Shopify's check
//     sends a bad HMAC and expects 401);
//  2. a signed delivery answers anything but 2xx, or records it without its audit line or the admins' notice;
//  3. Shopify's retry of one delivery (the same X-Shopify-Webhook-Id) records a second row, line or notice;
//  4. the customer's email or phone reaches the row, the audit line or the notice;
//  5. a signed delivery that doesn't parse (another topic's header or shape, a non-JSON type, more order ids than the
//     cap, no webhook id) is dropped or answered non-2xx (Shopify retries it into oblivion) instead of recorded as
//     unparsed, audited and notified; a customer known by email only (no customer id) is refused;
//  6. the secrets are unset or malformed and a delivery still verifies (or is answered 401, so Shopify gives up instead
//     of retrying our misconfiguration);
//  7. another method on a webhook path, or a near path (a trailing slash, a suffix, an encoded slash), is served
//     without sign-in, or a webhook route without its `webhook` row runs;
//  8. closing a request leaves the Shopify ids on it, writes no line, or closes it twice;
//  9. the health signal blocks a release (red) while a request is merely open, or stays quiet: it must be amber while
//     open and red once the oldest has 7 days or fewer left;
// 10. a captured body replayed under a fresh webhook id, or the same request delivered by the brand's other app,
//     records a second row, line or notice.
import { env } from 'cloudflare:workers'
import worker from '../../index.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accessMatrix } from '../../access-matrix.ts'
import { webhookRoutes } from '../../routes.ts'
import { lastLineId } from '../../db/test-support.ts'
import { serveWebhook } from '../serve.ts'
import { MAX_BODY_BYTES } from './handler.ts'
import { MAX_ORDER_IDS } from './payload.ts'
import { signShopifyBody } from './hmac.ts'
import { privacySignal, secretsSignal } from './signal.ts'
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

async function deliver(topic: Topic, o: { webhookId?: string | null; secret?: string | null; raw?: string; tamper?: boolean; contentType?: string; topicHeader?: string; method?: string; env?: Record<string, unknown> } = {}) {
  const raw = o.raw ?? JSON.stringify(PAYLOADS[topic].body)
  const bytes = enc.encode(raw)
  const headers: Record<string, string> = {
    'Content-Type': o.contentType ?? 'application/json', 'X-Shopify-Topic': o.topicHeader ?? topic,
    'X-Shopify-Shop-Domain': 'invented-shop.myshopify.com', 'X-Shopify-API-Version': '2026-10',
  }
  if (o.webhookId !== null) headers['X-Shopify-Webhook-Id'] = o.webhookId ?? newWebhookId()
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
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')
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
    expect(row).toMatchObject({ id, webhook_id: webhookId, topic, shop_id: 954889, parse_failed: 0, status: 'open', closed_at_ms: null, body_sha256: await sha256(JSON.stringify(PAYLOADS[topic].body)) })
    expect(row.due_at_ms).toBe(Number(row.received_at_ms) + DUE_MS)
    if (topic === 'customers/data_request') expect(row).toMatchObject({ customer_id: '191167', order_ids_json: '[299938,280263]', data_request_id: '9999' })
    if (topic === 'customers/redact') expect(row).toMatchObject({ customer_id: '191167', order_ids_json: '[299938,280263,220458]', data_request_id: null })
    if (topic === 'shop/redact') expect(row).toMatchObject({ customer_id: null, order_ids_json: null, data_request_id: null })
    expect(await lines()).toEqual([{ actor_id: 'm_system', action: 'privacy.requested', target_kind: null, target_id: null, args_json: JSON.stringify({ requestId: id, topic, parsed: true }) }])
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
    // A new request of the same topic (another customer) is its own row.
    expect((await deliver('customers/redact', { raw: JSON.stringify({ ...PAYLOADS['customers/redact'].body, customer: { id: 191168, email: EMAIL, phone: PHONE } }) })).res?.status).toBe(200)
    expect(await requests()).toHaveLength(2)
    expect(await lines()).toHaveLength(2)
  })
})

describe('a signed delivery that does not parse is recorded, never dropped (failure 5)', () => {
  const unparsed: [string, Topic, Parameters<typeof deliver>[1]][] = [
    ['a non-JSON Content-Type', 'shop/redact', { contentType: 'text/plain' }],
    ["another topic's header", 'shop/redact', { topicHeader: 'customers/redact' }],
    ["another topic's shape (a customers/redact body carrying data_request)", 'customers/redact', { raw: JSON.stringify({ ...PAYLOADS['customers/redact'].body, data_request: { id: 1 } }) }],
    // Each key that marks another topic is refused (an unknown key is not: see below).
    ['a shop/redact carrying customer', 'shop/redact', { raw: JSON.stringify({ ...PAYLOADS['shop/redact'].body, customer: { id: 5 } }) }],
    ['a shop/redact carrying orders_to_redact', 'shop/redact', { raw: JSON.stringify({ ...PAYLOADS['shop/redact'].body, orders_to_redact: [1] }) }],
    ['a shop/redact carrying orders_requested', 'shop/redact', { raw: JSON.stringify({ ...PAYLOADS['shop/redact'].body, orders_requested: [1] }) }],
    ['a shop/redact carrying data_request', 'shop/redact', { raw: JSON.stringify({ ...PAYLOADS['shop/redact'].body, data_request: { id: 1 } }) }],
    ['a customers/redact carrying orders_requested', 'customers/redact', { raw: JSON.stringify({ ...PAYLOADS['customers/redact'].body, orders_requested: [1] }) }],
    ['a data request carrying orders_to_redact', 'customers/data_request', { raw: JSON.stringify({ ...PAYLOADS['customers/data_request'].body, orders_to_redact: [1] }) }],
    ['broken JSON', 'shop/redact', { raw: '{"shop_id":' }],
    ['more than 10,000 order ids', 'customers/redact', { raw: JSON.stringify({ ...PAYLOADS['customers/redact'].body, orders_to_redact: Array.from({ length: 10_001 }, (_, i) => i + 1) }) }],
    ['no webhook id', 'shop/redact', { webhookId: null }],
    ['a malformed webhook id', 'shop/redact', { webhookId: 'bad id with spaces' }],
  ]
  it.each(unparsed)('%s: 200, one parse_failed row with no ids, its line (parsed false) and the admins notice', async (_, topic, o) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { res } = await deliver(topic, o)
    expect(res?.status).toBe(200)
    const rows = await requests()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ topic, parse_failed: 1, shop_id: null, customer_id: null, order_ids_json: null, data_request_id: null, status: 'open' })
    expect(rows[0].webhook_id).toMatch(o?.webhookId === undefined ? /^wh-/ : /^body:[0-9a-f]{64}:req-hook$/)
    expect((await lines()).map(l => JSON.parse(String(l.args_json)))).toEqual([{ requestId: rows[0].id, topic, parsed: false }])
    expect(await notices()).toHaveLength(1)
  })
  it.each(Object.keys(PAYLOADS) as Topic[])('%s with a field Shopify may add later still parses, with its ids', async topic => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = PAYLOADS[topic].body
    const extra = { ...b, new_top_level_field: { nested: true }, ...('customer' in b ? { customer: { ...b.customer, new_customer_field: 'x' } } : {}) }
    expect((await deliver(topic, { raw: JSON.stringify(extra) })).res?.status).toBe(200)
    expect((await requests())[0]).toMatchObject({ parse_failed: 0, shop_id: 954889, customer_id: topic === 'shop/redact' ? null : '191167' })
  })
  it('a customer known by email only (no customer id) is a parsed request with no customer id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = { ...PAYLOADS['customers/redact'].body, customer: { id: null, email: EMAIL, phone: null } }
    expect((await deliver('customers/redact', { raw: JSON.stringify(body) })).res?.status).toBe(200)
    expect((await requests())[0]).toMatchObject({ parse_failed: 0, customer_id: null, order_ids_json: '[299938,280263,220458]' })
    expect(JSON.stringify(await requests())).not.toContain(EMAIL)
  })
})

describe('one request is one row (failure 10)', () => {
  // Only the body index can catch these: an email-only customer has no open-request key, and an unparsed row none either.
  it.each([
    ['an email-only customers/redact', 'customers/redact', { raw: JSON.stringify({ ...PAYLOADS['customers/redact'].body, customer: { id: null, email: EMAIL, phone: null } }) }],
    ['an unparsed body', 'shop/redact', { raw: '{"shop_id":' }],
    ['a body with no webhook id', 'shop/redact', { webhookId: null }],
  ] as [string, Topic, Parameters<typeof deliver>[1]][])('%s replayed under a new webhook id is one row', async (_, topic, o) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 2; i++) expect((await deliver(topic, o)).res?.status).toBe(200)
    expect(await requests()).toHaveLength(1)
    expect(await lines()).toHaveLength(1)
  })
  it("a second customers/redact for the same open customer merges its order ids into the open row (deduped, bounded), adding no row, line or notice", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = PAYLOADS['customers/redact'].body
    expect((await deliver('customers/redact')).res?.status).toBe(200)
    expect((await deliver('customers/redact', { secret: WRITE, raw: JSON.stringify({ ...b, orders_to_redact: [220458, 111111, 299938] }) })).res?.status).toBe(200)
    expect((await requests()).map(r => r.order_ids_json)).toEqual(['[111111,220458,280263,299938]'])
    expect(await lines()).toHaveLength(1)
    expect(await notices()).toHaveLength(1)
    // Bounded: never past MAX_ORDER_IDS.
    expect((await deliver('customers/redact', { raw: JSON.stringify({ ...b, orders_to_redact: Array.from({ length: MAX_ORDER_IDS }, (_, i) => 500_000 + i) }) })).res?.status).toBe(200)
    expect(JSON.parse(String((await requests())[0].order_ids_json))).toHaveLength(MAX_ORDER_IDS)
    // Another customer's request is never merged into.
    expect((await deliver('customers/redact', { raw: JSON.stringify({ ...b, customer: { id: 191168, email: EMAIL, phone: PHONE }, orders_to_redact: [7] }) })).res?.status).toBe(200)
    expect((await requests()).map(r => r.order_ids_json)).toHaveLength(2)
    expect((await requests())[1].order_ids_json).toBe('[7]')
  })
  it('the same signed body replayed under a fresh webhook id adds nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 2; i++) expect((await deliver('customers/redact')).res?.status).toBe(200)
    expect(await requests()).toHaveLength(1)
    expect(await lines()).toHaveLength(1)
    expect(await notices()).toHaveLength(1)
  })
  it("the same open request from the brand's other app (another body, another id) adds nothing; a new request does", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = PAYLOADS['customers/data_request'].body
    expect((await deliver('customers/data_request', { secret: READ })).res?.status).toBe(200)
    const reordered = JSON.stringify({ data_request: b.data_request, customer: b.customer, orders_requested: b.orders_requested, shop_domain: b.shop_domain, shop_id: b.shop_id })
    expect((await deliver('customers/data_request', { secret: WRITE, raw: reordered })).res?.status).toBe(200)
    expect(await requests()).toHaveLength(1)
    expect(await lines()).toHaveLength(1)
    expect(await notices()).toHaveLength(1)
    // Another data request for the same customer is its own request.
    expect((await deliver('customers/data_request', { raw: JSON.stringify({ ...b, data_request: { id: 10_000 } }) })).res?.status).toBe(200)
    expect(await requests()).toHaveLength(2)
    // Two email-only customers have no key to match on: both kept.
    const emailOnly = (email: string) => JSON.stringify({ ...PAYLOADS['customers/redact'].body, customer: { id: null, email, phone: null } })
    expect((await deliver('customers/redact', { raw: emailOnly('a@example.test') })).res?.status).toBe(200)
    expect((await deliver('customers/redact', { raw: emailOnly('b@example.test') })).res?.status).toBe(200)
    expect(await requests()).toHaveLength(4)
  })
  it('once closed, the same request may open again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { webhookId } = await deliver('shop/redact')
    await privacyRequestStore(db).close(await requestIdFor(webhookId), { nowMs: Date.now(), requestId: 'r-close' })
    // The identical body (a shop's second uninstall, say) is a new request once the first is closed.
    expect((await deliver('shop/redact')).res?.status).toBe(200)
    expect((await requests()).map(r => r.status)).toEqual(['closed', 'open'])
  })
})

describe('refused before anything is recorded (failures 6 and 7)', () => {
  it('a body over the cap is 400 too_large, before the signature', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tooBig = await deliver('shop/redact', { raw: JSON.stringify({ shop_id: 1, pad: 'x'.repeat(MAX_BODY_BYTES) }) })
    expect(tooBig.res?.status).toBe(400)
    expect(await tooBig.res?.json()).toEqual({ error: { code: 'invalid', reason: 'too_large' } })
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
  it('a correctly signed POST to a near path is not a webhook: the Worker sends it to sign-in, 401, nothing recorded (failure 7)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify(PAYLOADS['customers/redact'].body)
    const headers = { 'Content-Type': 'application/json', 'X-Shopify-Topic': 'customers/redact', 'X-Shopify-Webhook-Id': newWebhookId(), 'X-Shopify-Hmac-Sha256': await signShopifyBody(enc.encode(raw), READ) }
    for (const path of ['/api/webhooks/shopify/customers-redact/', '/api/webhooks/shopify/customers-redact-x', '/api/webhooks/shopify%2Fcustomers-redact', '/api/webhooks%2Fshopify%2Fcustomers-redact', '/api/webhooks/shopify/customers%2Dredact']) {
      const request = new Request(`http://brand.localhost:8787${path}`, { method: 'POST', headers, body: raw })
      expect(await serveWebhook(webhookRoutes, accessMatrix, request.clone() as Request, hookEnv, 'r'), path).toBeNull()
      const res = await worker.fetch(request as never, { ...env, ...hookEnv } as Env, {} as ExecutionContext)
      expect(res.status, path).toBe(401)
    }
    expect(await requests()).toEqual([])
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
  it('the signal is amber (ok) while one is open, red at 7 days left or overdue; closing clears the ids, writes privacy.closed once, and the signal goes green', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = privacyRequestStore(db)
    const DAY = 86_400_000
    expect(await privacySignal(store, Date.now())).toEqual({ ok: true })
    const { webhookId } = await deliver('customers/data_request')
    const id = await requestIdFor(webhookId)
    const received = Number((await requests())[0].received_at_ms)
    expect(await privacySignal(store, received)).toEqual({ ok: true, amber: true, detail: '1 open, oldest 30 days left' })
    expect(await privacySignal(store, received + 23 * DAY - 1)).toEqual({ ok: true, amber: true, detail: '1 open, oldest 7 days left' })
    expect(await privacySignal(store, received + 23 * DAY)).toEqual({ ok: false, detail: '1 open, oldest 7 days left' })
    expect(await privacySignal(store, received + DUE_MS + DAY)).toEqual({ ok: false, detail: '1 open, oldest -1 days left' })
    // An unparsed one counts, and says so.
    await deliver('shop/redact', { contentType: 'text/plain' })
    expect(await privacySignal(store, received)).toEqual({ ok: true, amber: true, detail: '2 open (1 unparsed), oldest 30 days left' })
    await db.prepare("DELETE FROM privacy_requests WHERE parse_failed = 1").run()
    mark = await lastLineId(db)
    expect(await store.close(id, { nowMs: received + 1000, requestId: 'req-close' })).toBe('closed')
    expect(await store.close(id, { nowMs: received + 2000, requestId: 'req-close-2' })).toBe('already_closed')
    expect(await store.close('pr_AAAAAAAAAAAAAAAAAAAAAA', { nowMs: received, requestId: 'r' })).toBe('not_found')
    expect((await requests())[0]).toMatchObject({ status: 'closed', closed_at_ms: received + 1000, customer_id: null, order_ids_json: null, data_request_id: null, topic: 'customers/data_request' })
    expect(await lines()).toEqual([{ actor_id: 'm_system', action: 'privacy.closed', target_kind: null, target_id: null, args_json: JSON.stringify({ requestId: id, topic: 'customers/data_request', by: 'release' }) }])
    expect(await privacySignal(store, Date.now())).toEqual({ ok: true })
  })
  it('the secrets signal: green when they parse, amber when unset (a deployment without Shopify), red when malformed', () => {
    expect(secretsSignal(JSON.stringify([READ, WRITE]))).toEqual({ ok: true, detail: '2 app secrets' })
    expect(secretsSignal(undefined)).toEqual({ ok: true, amber: true, detail: 'not set' })
    for (const bad of ['', 'not json', '[]', '["short"]']) expect(secretsSignal(bad), bad).toEqual({ ok: false, detail: 'malformed' })
  })
  it('the table refuses a closed row that still names a customer, and an unparsed row with ids', async () => {
    const insert = (status: string, parseFailed: number, shopId: number | null, customerId: string | null) => db.prepare(
      "INSERT INTO privacy_requests (id, webhook_id, body_sha256, topic, parse_failed, shop_id, customer_id, received_at_ms, due_at_ms, status, closed_at_ms, req_id) VALUES ('pr_BBBBBBBBBBBBBBBBBBBBBB', 'w', ?, 'customers/redact', ?, ?, ?, 1, 2, ?, 3, 'r')",
    ).bind('a'.repeat(64), parseFailed, shopId, customerId, status).run()
    await expect(insert('closed', 0, 1, '5')).rejects.toThrow(/CHECK/)
    await expect(insert('open', 1, 1, null)).rejects.toThrow(/CHECK/)
    await expect(insert('open', 1, null, '5')).rejects.toThrow(/CHECK/)
    await expect(insert('open', 0, null, null)).rejects.toThrow(/CHECK/)
  })
})
