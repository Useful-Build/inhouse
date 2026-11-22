// The three compliance payloads (https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance, read
// 2026-11-22). Only the ids are read: the customer's `email` and `phone` are never parsed out, kept or logged.
import { z } from 'zod'
import { PrivacyTopicSchema } from '../../../shared/contract/audit.ts'

export type PrivacyTopic = z.infer<typeof PrivacyTopicSchema>

/** A Shopify id: a positive whole number (sent as a JSON number; a numeric string is taken too). */
const ShopifyId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)])
const OrderIds = z.array(ShopifyId).max(10_000)
const Customer = z.object({ id: ShopifyId })

const DataRequest = z.object({ shop_id: ShopifyId, customer: Customer, orders_requested: OrderIds.optional(), data_request: z.object({ id: ShopifyId }) })
const CustomerRedact = z.object({ shop_id: ShopifyId, customer: Customer, orders_to_redact: OrderIds.optional() })
const ShopRedact = z.object({ shop_id: ShopifyId })

export interface ParsedRequest {
  shopId: number
  customerId: string | null
  orderIds: number[] | null
  dataRequestId: string | null
}

/** The ids a topic's payload names, or null when it isn't that topic's shape. */
export function parsePayload(topic: PrivacyTopic, json: unknown): ParsedRequest | null {
  switch (topic) {
    case 'customers/data_request': {
      const p = DataRequest.safeParse(json)
      return p.success ? { shopId: p.data.shop_id, customerId: String(p.data.customer.id), orderIds: p.data.orders_requested ?? [], dataRequestId: String(p.data.data_request.id) } : null
    }
    case 'customers/redact': {
      const p = CustomerRedact.safeParse(json)
      return p.success ? { shopId: p.data.shop_id, customerId: String(p.data.customer.id), orderIds: p.data.orders_to_redact ?? [], dataRequestId: null } : null
    }
    case 'shop/redact': {
      const p = ShopRedact.safeParse(json)
      return p.success ? { shopId: p.data.shop_id, customerId: null, orderIds: null, dataRequestId: null } : null
    }
  }
}
