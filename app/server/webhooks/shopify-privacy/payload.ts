// The three compliance payloads (https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance, read
// 2026-11-22). Only the ids are read: the customer's `email` and `phone` are never parsed out, kept or logged. Each
// topic's schema is strict, so a body of another topic's shape (a customers/redact carrying `data_request`) or with a
// field Shopify doesn't send doesn't parse; the handler then records it unparsed, never drops it. Shopify may know a
// customer by email only, so `customer.id` may be null.
import { z } from 'zod'
import { PrivacyTopicSchema } from '../../../shared/contract/audit.ts'

export type PrivacyTopic = z.infer<typeof PrivacyTopicSchema>

/** The most order ids one request may name; a longer list is recorded unparsed. */
export const MAX_ORDER_IDS = 10_000

/** A Shopify id: a positive whole number (sent as a JSON number; a numeric string is taken too). */
const ShopifyId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)])
const OrderIds = z.array(ShopifyId).max(MAX_ORDER_IDS)
const Customer = z.object({ id: ShopifyId.nullable().optional(), email: z.string().nullable().optional(), phone: z.string().nullable().optional() }).strict()
const ShopDomain = z.string().optional()

const DataRequest = z.object({ shop_id: ShopifyId, shop_domain: ShopDomain, customer: Customer, orders_requested: OrderIds.optional(), data_request: z.object({ id: ShopifyId }).strict() }).strict()
const CustomerRedact = z.object({ shop_id: ShopifyId, shop_domain: ShopDomain, customer: Customer, orders_to_redact: OrderIds.optional() }).strict()
const ShopRedact = z.object({ shop_id: ShopifyId, shop_domain: ShopDomain }).strict()

export interface ParsedRequest {
  shopId: number
  customerId: string | null
  orderIds: number[] | null
  dataRequestId: string | null
}

const customerId = (c: z.infer<typeof Customer>) => (c.id === null || c.id === undefined ? null : String(c.id))

/** The ids a topic's payload names, or null when it isn't exactly that topic's shape. */
export function parsePayload(topic: PrivacyTopic, json: unknown): ParsedRequest | null {
  switch (topic) {
    case 'customers/data_request': {
      const p = DataRequest.safeParse(json)
      return p.success ? { shopId: p.data.shop_id, customerId: customerId(p.data.customer), orderIds: p.data.orders_requested ?? [], dataRequestId: String(p.data.data_request.id) } : null
    }
    case 'customers/redact': {
      const p = CustomerRedact.safeParse(json)
      return p.success ? { shopId: p.data.shop_id, customerId: customerId(p.data.customer), orderIds: p.data.orders_to_redact ?? [], dataRequestId: null } : null
    }
    case 'shop/redact': {
      const p = ShopRedact.safeParse(json)
      return p.success ? { shopId: p.data.shop_id, customerId: null, orderIds: null, dataRequestId: null } : null
    }
  }
}
