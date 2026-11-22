// Shopify's privacy (compliance) webhooks on the product Worker (P8a F2), routes 91 to 93: the closed `webhook` exception
// in the access matrix. No Access JWT: Shopify can't present one, so Shopify's HMAC is the authentication. Docs, read
// 2026-11-22: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance (POST, JSON body, 401 on an
// invalid HMAC, a 2xx to acknowledge, act within 30 days) and https://shopify.dev/docs/apps/build/webhooks/subscribe/https
// (the HMAC over the raw body, X-Shopify-Webhook-Id for deduplication, answer within five seconds).
//
// The order: the body cap (413), the secrets (503: ours to fix, and Shopify retries), the signature (401), then only
// for a signed delivery the Content-Type, topic, webhook id and payload (400), then one D1 batch (the record, its audit
// line and the admins' bell notice) and 200. A retry of a recorded delivery answers 200 and writes nothing.
import { z } from 'zod'
import { readCapped } from '../../db/handler-kit.ts'
import { StoreUnavailableError } from '../../db/sql.ts'
import { apiError, apiJson } from '../../http.ts'
import { verifyShopifyHmac } from './hmac.ts'
import { parsePayload } from './payload.ts'
import type { PrivacyTopic } from './payload.ts'
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
    // Signed by one of the brand's apps from here on.
    if (!isJson(request.headers.get('Content-Type'))) return refuse('content_type', apiError('invalid', { reason: 'content_type' }))
    if (request.headers.get('X-Shopify-Topic') !== topic) return refuse('topic', apiError('invalid', { reason: 'topic' }))
    const webhookId = request.headers.get('X-Shopify-Webhook-Id')
    if (webhookId === null || !WEBHOOK_ID.test(webhookId)) return refuse('webhook_id', apiError('invalid', { reason: 'webhook_id' }))
    let json: unknown
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    } catch {
      return refuse('json', apiError('invalid'))
    }
    const parsed = parsePayload(topic, json)
    if (!parsed) return refuse('payload', apiError('invalid'))
    try {
      const { id, created } = await privacyRequestStore(env.DB).record({ webhookId, topic, ...parsed }, { nowMs, requestId })
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
