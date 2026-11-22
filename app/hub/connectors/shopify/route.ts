// The Shopify connector (P4 W1): six read tools over the Admin GraphQL API, pinned to 2026-10.
// Docs read 2026-11-20: https://shopify.dev/docs/api/usage/access-scopes (each scope below is needed by a tool:
// read_orders for orders and refunds, read_products for products and variants, read_inventory for stock,
// read_locations for a level's location name, read_returns for returns).
import type { ConnectorModule } from '../../registry/registry'
import { SHOPIFY_API_VERSION, SHOPIFY_READ_SCOPES } from './documents'
import { inventoryLevelsGet } from './tools/inventory-levels-get'
import { orderGet } from './tools/order-get'
import { ordersSearch } from './tools/orders-search'
import { productsSearch } from './tools/products-search'
import { refundsSearch } from './tools/refunds-search'
import { returnsSearch } from './tools/returns-search'

/** Read and required are the same list (OC 1): a grant passes only with exactly these. No write_*, no read_customers. */
export const shopifyConnector: ConnectorModule = {
  id: 'shopify',
  accountId: 'shopify:store',
  apiVersion: SHOPIFY_API_VERSION,
  scopes: { read: SHOPIFY_READ_SCOPES, required: SHOPIFY_READ_SCOPES },
  tools: [ordersSearch, orderGet, refundsSearch, returnsSearch, productsSearch, inventoryLevelsGet],
}
