// P3's `memory` store slot (p3-design section 12). Owner: W6 (p3-w6.md). A placeholder from PR0: `Stores` (db/stores.ts)
// already has the slot, so the owner fills only this file. Every method takes data and returns data (the store
// contract in server/routes.ts).

/** What the `memory` store offers. Empty until W6 fills it. */
export type MemoryStore = Record<never, never>

export function memoryStore(_deps: { db: D1Database }): MemoryStore {
  return {}
}
