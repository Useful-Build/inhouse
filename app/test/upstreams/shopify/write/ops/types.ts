// One operation of the fake Shopify write upstream (Stage 1 M3-S1): the document it answers and what it does to the fake
// store. No npm packages (bundled into the hub's test build). The faults (`timeout`, `broken_body`, `throttle`) are the
// server's; an operation answers `succeed` and `refuse`.
//
// Stage 1 M3-S2 (#489): each operation names the exact document it answers (`document`), written here in the fake and
// never imported from the hub, and the fake answers only a request whose text reads the same (../gql.ts). A query (a
// refund's lookup, the shop's currency) is an operation too; it changes nothing and is logged as a read.
import type { FakeShopifyWriteUpstream } from '../server.js'

export interface FakeWriteOp<K extends string = string> {
  /** The operation key its fault switch and call log use. */
  key: K
  /** `mutation` changes the store and is logged as a write; `query` only reads. */
  kind: 'query' | 'mutation'
  /** The GraphQL operation name it answers (`mutation <name>`, `query <name>`). */
  name: string
  /** The exact document it answers, for these variables (a tags call has one root field per order). */
  document(variables: Record<string, unknown>): string
  /** The first root field's name, for a broken body. */
  root: string
  /** The query cost Shopify would ask for (the throttle fault reports it). */
  cost(variables: Record<string, unknown>): number
  /** The mutation takes `@idempotent(key: $idempotencyKey)`: the same key twice runs once (`../server.ts`). */
  idempotent?: true
  /** The answer's `data`; `refuse` answers every root field with a user error and changes nothing. */
  run(fake: FakeShopifyWriteUpstream, variables: Record<string, unknown>, refuse: boolean): Record<string, unknown>
}

export const userError = (field: string[], message: string) => ({ field, message })

export const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {})
