// The connector hub's registry entry (P4 H0; wrangler.hub.jsonc binds it): the SignIn Durable Object, one per
// connector account, holding that account's sealed token (client credentials on P4, so no person connects it) and
// short-lived `pending:` items that sweep themselves. Nothing in it names a member today: P5's per-person connectors
// add `connectedBy`, and their registry change lands with P5 (C1's PR C). Not restored: a lost record is reconnected.
import type { TableEntry } from './types.ts'

export const hubTables: readonly TableEntry[] = [
  { kind: 'do', name: 'SignIn', retention: 'config', personKeys: [], export: false },
]
