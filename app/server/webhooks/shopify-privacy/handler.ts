// Shopify's privacy (compliance) webhooks on the product Worker (P8a F2), routes 91 to 93: the closed `webhook` exception
// in the access matrix. No Access JWT: Shopify can't present one, so Shopify's HMAC is the authentication. Docs, read
// 2026-11-22: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance (POST, JSON body, 401 on an
// invalid HMAC, a 2xx to acknowledge, act within 30 days) and https://shopify.dev/docs/apps/build/webhooks/subscribe/https
// (the HMAC over the raw body, X-Shopify-Webhook-Id for deduplication, answer within five seconds).
//
// The order: the body cap (400 `too_large`), the secrets (503: ours to fix, and Shopify retries), the signature (401).
// Once Shopify's signature holds, nothing is dropped: a delivery whose Content-Type, topic header, webhook id or payload
// isn't what the route expects is recorded unparsed (no ids) rather than refused, so Shopify doesn't retry it into
// oblivion and the team still sees it. Then one D1 batch (the record, its audit line and the admins' bell notice) and
// 200. A repeat (the same webhook id, the same signed body, or the same open request from the other app) answers 200
// and writes nothing.
import { z } from 'zod'
import { readCapped } from '../../db/handler-kit.ts'
import { StoreUnavailableError } from '../../db/sql.ts'
import { apiError, apiJson } from '../../http.ts'
import { verifyShopifyHmac } from './hmac.ts'
import { parsePayload } from './payload.ts'
import type { ParsedRequest, PrivacyTopic } from './payload.ts'
import { privacyRequestStore } from './store.ts'

/** The most a compliance payload may be. An order list of a few thousand ids fits many times over. */
export const MAX_BODY_BYTES = 256 * 1024

/** What a webhook route's handler gets: no principal (Shopify's HMAC stands in for sign-in) and the whole env. */
export interface WebhookContext {
  request: Request
  env: Pick<Env, 'DB' | 'SHOPIFY_WEBHOOK_SECRETS'>
  requestId: string
  nowMs: number
}
export type WebhookHandler = (c: WebhookContext) => Promise<Response>

/** `SHOPIFY_WEBHOOK_SECRETS`: a JSON array of the brand's Shopify app client secrets (read and write app), 1 to 4. */
const SecretsSchema = z.array(z.string().min(16).max(256)).min(1).max(4)

export function webhookSecrets(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = SecretsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const WEBHOOK_ID = /^[A-Za-z0-9._:-]{1,128}$/

const isJson = (contentType: string | null) => contentType?.split(';')[0].trim().toLowerCase() === 'application/json'

/** The signed delivery's ids, or why it isn't the route's topic and shape. */
function readPayload(topic: PrivacyTopic, request: Request, body: Uint8Array): { ok: ParsedRequest } | { problem: string } {
  if (!isJson(request.headers.get('Content-Type'))) return { problem: 'content_type' }
  if (request.headers.get('X-Shopify-Topic') !== topic) return { problem: 'topic' }
  if (!WEBHOOK_ID.test(request.headers.get('X-Shopify-Webhook-Id') ?? '')) return { problem: 'webhook_id' }
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    return { problem: 'json' }
  }
  const parsed = parsePayload(topic, json)
  return parsed ? { ok: parsed } : { problem: 'payload' }
}

export function privacyWebhook(topic: PrivacyTopic): WebhookHandler {
  return async ({ request, env, requestId, nowMs }) => {
    const refuse = (reason: string, res: Response) => {
      console.warn({ event: 'privacy_webhook_refused', requestId, topic, reason })
      return res
    }
    if (request.method !== 'POST') return refuse('method', apiError('not_found'))
    const body = await readCapped(request, MAX_BODY_BYTES)
    if (body === null) return refuse('too_large', apiError('invalid', { reason: 'too_large' }))
    const secrets = webhookSecrets(env.SHOPIFY_WEBHOOK_SECRETS)
    if (!secrets) {
      console.error({ event: 'privacy_webhook_secrets_invalid', requestId })
      return apiError('unavailable')
    }
    if (!(await verifyShopifyHmac(body, request.headers.get('X-Shopify-Hmac-Sha256'), secrets))) return refuse('hmac', apiError('unauthorized'))
    // Signed by one of the brand's apps from here on: recorded whatever it holds.
    const bodySha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map(b => b.toString(16).padStart(2, '0')).join('')
    const header = request.headers.get('X-Shopify-Webhook-Id')
    const webhookId = header !== null && WEBHOOK_ID.test(header) ? header : `body:${bodySha256}`
    const parsed = readPayload(topic, request, body)
    if ('problem' in parsed) console.warn({ event: 'privacy_webhook_unparsed', requestId, topic, reason: parsed.problem })
    try {
      const { id, created } = await privacyRequestStore(env.DB).record({ webhookId, bodySha256, topic, parsed: 'problem' in parsed ? null : parsed.ok }, { nowMs, requestId })
      // Ids only: our request id and the topic, never the customer's.
      console.warn({ event: created ? 'privacy_request_received' : 'privacy_request_repeat', requestId, topic, privacyRequestId: id })
    } catch (err) {
      if (err instanceof StoreUnavailableError) {
        console.error({ event: 'store_unavailable', requestId, error: err.name })
        return apiError('unavailable')
      }
      throw err
    }
    return apiJson({ ok: true })
  }
}

export const customersDataRequest = privacyWebhook('customers/data_request')
export const customersRedact = privacyWebhook('customers/redact')
export const shopRedact = privacyWebhook('shop/redact')
