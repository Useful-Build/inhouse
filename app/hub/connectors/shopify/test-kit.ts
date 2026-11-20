// Test kit for the Shopify connector (tests only; route.ts and tools/ never import it, so it's never bundled).
// A ShopifyReadClient over H0's SignIn core and a recorded upstream: the same document check, grant, scope check and
// read call the hub runs, minus the Durable Object.
import type { z } from 'zod'
import type { CallerScope, HubResult } from '../../index/contract'
import { ok } from '../../index/errors'
import { parseKeyRing } from '../../crypto/keyring'
import type { ShopifyReadClient, ToolContext, ToolDef } from '../../registry/registry'
import { SignInCore } from '../../signin/core'
import type { Upstream } from '../../signin/providers/shopify'
import { FakeAlarm, MemStore, START_MS, ringJson } from '../../signin/testing/kit'
import { createShopifyUpstream, TEST_CLIENT_ID, TEST_CLIENT_SECRET, type ShopifyUpstreamOptions } from '../../../test/upstreams/shopify/server'
import { dataset as handDataset } from '../../../test/upstreams/shopify/recordings/hand/dataset'
import * as D from './documents'
import { shopifyConnector } from './route'
import { inventoryLevelsGet, inventoryLevelsGetParser } from './tools/inventory-levels-get'
import { orderGet, orderGetParser } from './tools/order-get'
import { ordersSearch, ordersSearchParser } from './tools/orders-search'
import { productsSearch, productsSearchParser } from './tools/products-search'
import { refundsSearch, refundsSearchParser } from './tools/refunds-search'
import { returnsSearch, returnsSearchParser } from './tools/returns-search'

export { handDataset }

export const SCOPE: CallerScope = { kind: 'server', job: 'test', requestId: 'req-test' }

export type ToolSpec = { tool: ToolDef<any>; operation: keyof typeof D.TOOL_OPERATIONS; document: string; parser: z.ZodType<unknown> }

export const TOOLS: Record<string, ToolSpec> = {
  orders_search: { tool: ordersSearch, operation: 'OrdersSearch', document: D.ORDERS_SEARCH, parser: ordersSearchParser },
  order_get: { tool: orderGet, operation: 'OrderGet', document: D.ORDER_GET, parser: orderGetParser },
  refunds_search: { tool: refundsSearch, operation: 'RefundsSearch', document: D.REFUNDS_SEARCH, parser: refundsSearchParser },
  returns_search: { tool: returnsSearch, operation: 'ReturnsSearch', document: D.RETURNS_SEARCH, parser: returnsSearchParser },
  products_search: { tool: productsSearch, operation: 'ProductsSearch', document: D.PRODUCTS_SEARCH, parser: productsSearchParser },
  inventory_levels_get: { tool: inventoryLevelsGet, operation: 'InventoryLevelsGet', document: D.INVENTORY_LEVELS_GET, parser: inventoryLevelsGetParser },
}

/** A read client over a fresh SignIn core and `upstream`. */
export function signInClient(upstream: Upstream, nowMs: () => number = () => START_MS): { client: ShopifyReadClient; core: SignInCore } {
  const ring = ringJson(['k1'], 'k1')
  const core = new SignInCore({
    store: new MemStore(),
    now: nowMs,
    alarm: new FakeAlarm(),
    upstream: async () => upstream,
    keyring: () => parseKeyRing(ring),
    shopify: () => ({ shop: 'example-fixture', clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET }),
    scopesFor: async id => (id === shopifyConnector.accountId ? shopifyConnector.scopes : null),
  })
  const client: ShopifyReadClient = {
    graphql: (document, variables, apiVersion) =>
      core.query({ accountId: shopifyConnector.accountId, document, variables, apiVersion: apiVersion ?? D.SHOPIFY_API_VERSION }),
  }
  return { client, core }
}

export const fakeClient = (dataset: unknown = handDataset, options: ShopifyUpstreamOptions = {}) =>
  signInClient(createShopifyUpstream(dataset, options)).client

/** A client that answers every call with this `data` (for parser and mapper properties). */
export const dataClient = (data: unknown): ShopifyReadClient => ({ graphql: async () => ok({ data }) })

export const ctxFor = (shopify: ShopifyReadClient, nowMs = START_MS): ToolContext => ({ shopify, scope: SCOPE, nowMs })

/** Parses input with the tool's own schema (as the gateway does) and runs it. */
export async function call(name: string, input: unknown, shopify: ShopifyReadClient, nowMs = START_MS): Promise<HubResult<unknown>> {
  const spec = TOOLS[name]
  if (!spec) throw new Error(`no tool ${name}`)
  const parsed = spec.tool.input.safeParse(input)
  if (!parsed.success) throw new Error(`bad input for ${name}: ${parsed.error.message}`)
  return spec.tool.run(ctxFor(shopify, nowMs), parsed.data)
}

export const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength

// Worst-case upstream data: every list at the length its document asks for, every string far past its cap in the
// costliest characters for JSON (a quote, an astral code point, a control character, a two-byte letter), every
// nullable present, every number at its widest.
export const WORST = {
  /** Exactly `cap` JSON bytes of four-byte code points, then costly overflow the cap must cut. Every cap is a multiple of 4. */
  str: (cap: number) => {
    if (cap % 4 !== 0) throw new Error('caps are multiples of 4')
    return '🏕'.repeat(cap / 4) + '\u0001"é🏕'.repeat(20)
  },
  id: `gid://shopify/${'A'.repeat(32)}/${'9'.repeat(20)}`,
  money: { shopMoney: { amount: '-90071992547409.91', currencyCode: 'USD' } },
  // Year 10000 once in UTC: `iso` becomes '+010000-…' (27 bytes), the widest a 4-digit-year input can produce.
  instant: '9999-12-31T23:59:59.999-23:59',
  enum: 'A'.repeat(40),
  int: -2147483648,
  cursor: 'A'.repeat(512),
}
const rep = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i))
const W = WORST
const L = D.LIMITS
const CAPS = D.CAPS
const more = { hasNextPage: true }
const page = { hasNextPage: true, endCursor: W.cursor }
const core = () => ({
  id: W.id,
  name: W.str(CAPS.orderName),
  processedAt: W.instant,
  cancelledAt: W.instant,
  displayFinancialStatus: W.enum,
  displayFulfillmentStatus: W.enum,
  returnStatus: W.enum,
  currentTotalPriceSet: W.money,
  totalRefundedSet: W.money,
})
const refundNode = (lines: number) => ({
  createdAt: W.instant,
  note: W.str(CAPS.refundNoteGet),
  totalRefundedSet: W.money,
  refundLineItems: { nodes: rep(lines, () => ({ quantity: W.int, restockType: W.enum, lineItem: { sku: W.str(CAPS.sku) } })), pageInfo: more },
})
const returnNode = (lines: number) => ({
  name: W.str(CAPS.returnName),
  status: W.enum,
  createdAt: W.instant,
  returnLineItems: {
    nodes: rep(lines, () => ({
      quantity: W.int,
      unprocessedQuantity: W.int,
      returnReasonDefinition: { name: W.str(CAPS.reason) },
      fulfillmentLineItem: { lineItem: { sku: W.str(CAPS.sku) } },
    })),
    pageInfo: more,
  },
})

export const WORST_NAME = `#${'A'.repeat(32)}`
export const WORST_SKU = 'S'.repeat(64)

/** The maximal input and upstream data per tool. */
export const MAXIMAL: Record<string, { input: unknown; data: unknown }> = {
  orders_search: {
    input: { first: L.ordersSearch.maxFirst },
    data: {
      orders: {
        nodes: rep(L.ordersSearch.maxFirst, () => ({
          ...core(),
          currentSubtotalLineItemsQuantity: 2147483647,
          lineItems: { nodes: rep(L.ordersSearch.lines, () => ({ sku: W.str(CAPS.sku), currentQuantity: W.int })), pageInfo: more },
        })),
        pageInfo: page,
      },
    },
  },
  order_get: {
    input: { name: WORST_NAME },
    data: {
      orders: {
        nodes: [
          {
            ...core(),
            name: WORST_NAME,
            lineItems: {
              nodes: rep(L.orderGet.lines, () => ({
                sku: W.str(CAPS.sku),
                title: W.str(CAPS.title),
                currentQuantity: W.int,
                unfulfilledQuantity: W.int,
                originalUnitPriceSet: W.money,
              })),
              pageInfo: more,
            },
            refunds: rep(L.orderGet.refunds + 1, () => refundNode(L.orderGet.refundLines)),
            returns: { nodes: rep(L.orderGet.returns, () => returnNode(L.orderGet.returnLines)), pageInfo: more },
          },
        ],
      },
    },
  },
  refunds_search: {
    input: { createdFrom: '2000-01-01T00:00:00Z', first: L.refundsSearch.maxFirst },
    data: {
      orders: {
        nodes: rep(L.refundsSearch.maxFirst, () => ({
          id: W.id,
          name: W.str(CAPS.orderName),
          refunds: rep(L.refundsSearch.scan, () => refundNode(L.refundsSearch.refundLines)),
        })),
        pageInfo: page,
      },
    },
  },
  returns_search: {
    input: { first: L.returnsSearch.maxFirst },
    data: {
      orders: {
        nodes: rep(L.returnsSearch.maxFirst, () => ({
          id: W.id,
          name: W.str(CAPS.orderName),
          returns: { nodes: rep(L.returnsSearch.returns, () => returnNode(L.returnsSearch.returnLines)), pageInfo: more },
        })),
        pageInfo: page,
      },
    },
  },
  products_search: {
    input: { first: L.productsSearch.maxFirst },
    data: {
      shop: { currencyCode: 'USD' },
      products: {
        nodes: rep(L.productsSearch.maxFirst, () => ({
          id: W.id,
          title: W.str(CAPS.title),
          status: W.enum,
          totalInventory: W.int,
          tracksInventory: true,
          variants: {
            nodes: rep(L.productsSearch.variants, () => ({ id: W.id, sku: W.str(CAPS.sku), title: W.str(CAPS.variantTitle), price: '-90071992547409.91' })),
            pageInfo: more,
          },
        })),
        pageInfo: page,
      },
    },
  },
  inventory_levels_get: {
    input: { sku: WORST_SKU },
    data: {
      productVariants: {
        nodes: rep(L.inventoryLevelsGet.first, () => ({
          id: W.id,
          sku: WORST_SKU,
          title: W.str(CAPS.variantTitle),
          product: { title: W.str(CAPS.title) },
          inventoryItem: {
            tracked: true,
            inventoryLevels: {
              nodes: rep(L.inventoryLevelsGet.levels, () => ({
                location: { name: W.str(CAPS.location) },
                quantities: D.QUANTITY_NAMES.map(name => ({ name, quantity: W.int })),
              })),
              pageInfo: more,
            },
          },
        })),
        pageInfo: more,
      },
    },
  },
}
