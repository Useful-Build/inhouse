// The fake Shopify write upstream's operations (Stage 1 M3-S1): one line per operation (a shared entry file, plan
// section 1). No npm packages (bundled into the hub's test build). Imports end in `.js` (resolved to the `.ts` file) so
// both the hub's bundler resolution and the app's nodenext resolution take them.
import { fakeCardOrders, fakeCardOrdersNoCustomer, fakeCardVariants } from './card-facts.js'
import { fakeDraftOrderCreate } from './draft-order-create.js'
import { fakeInventoryReduce, fakeInventoryRestock } from './inventory.js'
import { fakeRefundCreate, fakeRefundSuggestion, fakeShopCurrency } from './refund.js'
import { fakeOrderTagAdd, fakeOrderTagRemove } from './tags.js'
import type { FakeWriteOp } from './types.js'

const OPS = [
  fakeOrderTagAdd,
  fakeOrderTagRemove,
  fakeDraftOrderCreate,
  fakeInventoryRestock, // M3-S2
  fakeInventoryReduce, // M3-S2
  fakeRefundSuggestion, // M3-S2 (a query)
  fakeRefundCreate, // M3-S2
  fakeShopCurrency, // M3-S2 (a query)
  fakeCardOrders, // M3 card details (a query)
  fakeCardOrdersNoCustomer, // M3 card details (a query)
  fakeCardVariants, // M3 card details (a query)
] as const

/** The operation keys the fake answers (and keys its faults and call log by). */
export type FakeWriteOperationKey = (typeof OPS)[number]['key']

export const FAKE_WRITE_OPS: readonly FakeWriteOp<FakeWriteOperationKey>[] = OPS
