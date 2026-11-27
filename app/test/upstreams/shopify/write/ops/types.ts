// One operation of the fake Shopify write upstream (Stage 1 M3-S1): the mutation it answers and what it does to the
// fake store. No npm packages (bundled into the hub's test build). The faults (`timeout`, `broken_body`, `throttle`)
// are the server's; an operation answers `succeed` and `refuse`.
import type { FakeShopifyWriteUpstream } from '../server.js'

export interface FakeWriteOp<K extends string = string> {
  /** The operation key its fault switch and call log use. */
  key: K
  /** The GraphQL operation name it answers (`mutation <name>`). */
  mutation: string
  /** The first root field's name, for a broken body. */
  root: string
  /** The query cost Shopify would ask for (the throttle fault reports it). */
  cost(variables: Record<string, unknown>): number
  /** The answer's `data`; `refuse` answers every root field with a user error and changes nothing. */
  run(fake: FakeShopifyWriteUpstream, variables: Record<string, unknown>, refuse: boolean): Record<string, unknown>
}

export const userError = (field: string[], message: string) => ({ field, message })
