// The fake Shopify write upstream's operations (Stage 1 M3-S1): one line per operation (a shared entry file, plan
// section 1). No npm packages (bundled into the hub's test build). Imports end in `.js` (resolved to the `.ts` file) so
// both the hub's bundler resolution and the app's nodenext resolution take them.
import { fakeDraftOrderCreate } from './draft-order-create.js'
import { fakeOrderTagAdd, fakeOrderTagRemove } from './tags.js'
import type { FakeWriteOp } from './types.js'

const OPS = [
  fakeOrderTagAdd,
  fakeOrderTagRemove,
  fakeDraftOrderCreate,
] as const

/** The operation keys the fake answers (and keys its faults and call log by). */
export type FakeWriteOperationKey = (typeof OPS)[number]['key']

export const FAKE_WRITE_OPS: readonly FakeWriteOp<FakeWriteOperationKey>[] = OPS
