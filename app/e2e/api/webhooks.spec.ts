// Shopify's privacy webhooks on the test build (P8a F2, routes 91 to 94), end to end: a delivery signed with the test
// build's invented app secret (wrangler.test.jsonc `SHOPIFY_WEBHOOK_SECRETS`) is recorded, audited and shown to the
// brand's admins in the bell; an unsigned, wrongly signed or tampered one is 401 with nothing recorded; Shopify's retry
// of one delivery, or the same request from the other app, changes nothing; the health signal is amber (still ok, so no
// release is blocked) while the request is open, and the release token's close (route 94) clears it. https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, appOrigin, call, expectError, fetchRaw } from './kit.ts'
import { auditAfter, auditMax, readSql } from './db.ts'

test.describe.configure({ mode: 'serial' })

/** The test build's invented secrets, read from its config (never a real app's). */
function testSecrets(): string[] {
  const config = readFileSync(new URL('../../wrangler.test.jsonc', import.meta.url), 'utf8')
  const m = /"SHOPIFY_WEBHOOK_SECRETS":\s*"((?:[^"\\]|\\.)*)"/.exec(config)
  if (!m) throw new Error('wrangler.test.jsonc has no SHOPIFY_WEBHOOK_SECRETS')
  return JSON.parse(JSON.parse(`"${m[1]}"`)) as string[]
}
const [READ, WRITE] = testSecrets()

const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body, 'utf8').digest('base64')
/** Encode the first 128 digest bits so the last base64url character has canonical padding bits. */
const requestIdFor = (webhookId: string) => `pr_${createHash('sha256').update(`shopify-webhook:${webhookId}`).digest().subarray(0, 16).toString('base64url')}`

const run = Date.now()
const REDACT = { shop_id: 954889, shop_domain: 'invented-shop.myshopify.com', customer: { id: 100_000 + (run % 900_000), email: 'invented.customer@example.test', phone: '+15550100999' }, orders_to_redact: [299938, 280263] }

async function deliver(request: APIRequestContext, o: { webhookId: string; body?: string; signature?: string | null; secret?: string; send?: string }) {
  const body = o.body ?? JSON.stringify(REDACT)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'X-Shopify-Topic': 'customers/redact', 'X-Shopify-Webhook-Id': o.webhookId,
    'X-Shopify-Shop-Domain': 'invented-shop.myshopify.com', 'X-Shopify-API-Version': '2026-10',
  }
  const signature = o.signature === undefined ? sign(body, o.secret ?? READ) : o.signature
  if (signature !== null) headers['X-Shopify-Hmac-Sha256'] = signature
  // No Access JWT and no Origin: Shopify sends neither.
  return fetchRaw(request, 'POST', `${appOrigin('brand')}/api/webhooks/shopify/customers-redact`, headers, o.send ?? body)
}

const privacySignal = async (request: APIRequestContext) => {
  const r = await call(request, actor('monitor'), 'GET', '/api/health')
  return (r.json.signals as { name: string; ok: boolean; detail?: string }[]).find(s => s.name === 'privacy_requests')
}

test('unsigned, wrongly signed or tampered: 401 unauthorized, nothing recorded or audited', async ({ request }) => {
  const mark = auditMax()
  const webhookId = `e2e-bad-${run}`
  expectError(await deliver(request, { webhookId, signature: null }), 401, 'unauthorized')
  expectError(await deliver(request, { webhookId, secret: 'invented-secret-of-another-app' }), 401, 'unauthorized')
  expectError(await deliver(request, { webhookId, send: JSON.stringify({ ...REDACT, shop_id: 954880 }) }), 401, 'unauthorized')
  // A signed-in Admin's JWT counts for nothing on a webhook route.
  expectError(await call(request, actor('admin'), 'POST', '/api/webhooks/shopify/customers-redact', { json: REDACT }), 401, 'unauthorized')
  expect(readSql('SELECT id FROM privacy_requests WHERE webhook_id = ?', webhookId)).toEqual([])
  expect(auditAfter(mark).filter(l => l.action.startsWith('privacy.'))).toEqual([])
})

test('a signed customers/redact: 200, recorded once across retries, audited by id only, in the admins\' bell, amber on health until closed', async ({ request }) => {
  const mark = auditMax()
  const webhookId = `e2e-redact-${run}`
  const id = requestIdFor(webhookId)
  // Shopify's retries of one delivery, then the same request delivered by the brand's other app under its own id.
  for (const [id_, secret] of [[webhookId, READ], [webhookId, READ], [`${webhookId}-write-app`, WRITE]]) {
    const r = await deliver(request, { webhookId: id_, secret })
    expect(r.status, r.text).toBe(200)
    expect(r.json).toEqual({ ok: true })
  }
  expect(readSql('SELECT id, topic, customer_id, order_ids_json, status FROM privacy_requests WHERE webhook_id = ?', webhookId)).toEqual([
    { id, topic: 'customers/redact', customer_id: String(REDACT.customer.id), order_ids_json: '[280263,299938]', status: 'open' },
  ])
  const lines = auditAfter(mark).filter(l => l.action.startsWith('privacy.'))
  expect(lines.map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])).toEqual([['privacy.requested', 'm_system', { requestId: id, topic: 'customers/redact', parsed: true }]])
  expect(JSON.stringify(lines)).not.toContain('invented.customer')

  const bell = await call(request, actor('admin'), 'GET', '/api/notifications')
  expect(bell.status, bell.text).toBe(200)
  expect(bell.json.items.filter((n: { id: string }) => n.id === `privacy-${id}`).map((n: { text: string }) => n.text)).toEqual([
    "Shopify asked to erase a customer's data. The Inhouse team will handle it within 30 days",
  ])
  const memberBell = await call(request, actor('memberA'), 'GET', '/api/notifications')
  expect(memberBell.json.items.some((n: { id: string }) => n.id === `privacy-${id}`), 'admins only').toBe(false)

  // Amber, not red: an open request needs the team but never blocks a release.
  const open = await call(request, actor('monitor'), 'GET', '/api/health')
  expect(open.status, open.text).toBe(200)
  expect((await privacySignal(request))).toEqual({ name: 'privacy_requests', ok: true, amber: true, detail: '1 open, oldest 29 days left' })

  const closed = await call(request, actor('release'), 'POST', `/api/ops/privacy-requests/${id}/close`, { json: {} })
  expect(closed.status, closed.text).toBe(200)
  expect(closed.json).toEqual({ result: 'closed' })
  expect(readSql('SELECT customer_id, order_ids_json, status FROM privacy_requests WHERE id = ?', id)).toEqual([{ customer_id: null, order_ids_json: null, status: 'closed' }])
  expect(auditAfter(mark).filter(l => l.action === 'privacy.closed').map(l => JSON.parse(l.args_json))).toEqual([{ requestId: id, topic: 'customers/redact', by: 'release' }])
  expect(await privacySignal(request)).toEqual({ name: 'privacy_requests', ok: true })
  // Only the release token closes one.
  expectError(await call(request, actor('admin'), 'POST', `/api/ops/privacy-requests/${id}/close`, { json: {} }), 403, 'forbidden')
})
