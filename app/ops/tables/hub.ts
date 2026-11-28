// The hub stores a sealed credential per brand connector account. Attribution uses member ids, and pending
// OAuth items expire. A lost connection is reconnected rather than restored from a database backup.
//
// Stage 1 M4-R1 (N35): the SignIn class also holds each connection by address (`mcp:<slug>`, its version 3 record, with
// the member who prepared it in `preparedBy`) and the `__connections__` index (account ids and slugs only). No backup:
// a lost object means prepare and confirm again; the product's D1 copy may pre-fill a screen, never restore a decision.
import type { TableEntry } from './types.ts'

export const hubTables: readonly TableEntry[] = [
  { kind: 'do', name: 'SignIn', retention: 'config', personKeys: ['connectedBy', 'pending.memberId', 'preparedBy'], export: false },
  // Stage 1 M2-C: the write-scoped Shopify app's sealed token (one record, no member ids).
  { kind: 'do', name: 'ShopifyWriteSignIn', retention: 'config', personKeys: [], export: false },
]
