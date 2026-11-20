// P3's `chats` store slot (p3-design section 12). Owner: W1 (p3-w1.md). A placeholder from PR0: `Stores` (db/stores.ts)
// already has the slot, so the owner fills only this file. Every method takes data and returns data (the store
// contract in server/routes.ts).

/** What the `chats` store offers. Empty until W1 fills it. */
export type ChatStore = Record<never, never>

export function chatStore(_deps: { db: D1Database }): ChatStore {
  return {}
}
