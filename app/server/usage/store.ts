// P3's `usage` store slot (p3-design section 12). Owner: W4 (p3-w4.md). A placeholder from PR0: `Stores` (db/stores.ts)
// already has the slot, so the owner fills only this file. Every method takes data and returns data (the store
// contract in server/routes.ts).

/** What the `usage` store offers. Empty until W4 fills it. */
export type UsageStore = Record<never, never>

export function usageStore(_deps: { db: D1Database }): UsageStore {
  return {}
}
