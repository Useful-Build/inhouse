// P3's `files` store slot (p3-design section 12). Owner: W3 (p3-w3.md). A placeholder from PR0: `Stores` (db/stores.ts)
// already has the slot, so the owner fills only this file. Every method takes data and returns data (the store
// contract in server/routes.ts).

/** What the `files` store offers. Empty until W3 fills it. */
export type FileStore = Record<never, never>

export function fileStore(_deps: { db: D1Database }): FileStore {
  return {}
}
