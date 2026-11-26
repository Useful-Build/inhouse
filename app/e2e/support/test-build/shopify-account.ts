// Stage 1 M2-H: the brand's Shopify account row in the local test build's D1, at the hub's own connect date. Until M2-D
// copies the hub's accounts into `connector_accounts`, nothing in the product writes that row for the client-credentials
// Shopify account, and the outbox refuses a request on an account with no connect date (`account_unavailable`,
// server/permissions/resolve.ts). An action's generation is that date, and the hub checks it at send, so it must be the
// hub's (`/api/tools` gives it as the Shopify tool's `since`). Used by e2e/real/actions-ui.spec.ts and the contract
// suite's real target, each in its own setup (never inside another spec's window). Local only: a deployed test build has
// no copy of its D1 here.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export const SHOPIFY_ACCOUNT_ID = 'shopify:store'
/**
 * A read of the hub's Shopify account (the test-fakes hook's `hub` op), made first so the account has its connect date
 * to give. Named here, not in src/: scripts/check-icons.mjs reads any underscored string in src/ as an icon name.
 */
export const SHOPIFY_READ = { op: 'hub', method: 'callTool', name: 'orders_search', args: { first: 1 } } as const

const persist = fileURLToPath(new URL('../../../.wrangler/test-build/v3/d1', import.meta.url))

/** The local D1's file (the one with `connector_accounts`); looked up on every call, as e2e/api/db.ts does. */
function dbFile(): string {
  const files = readdirSync(persist, { recursive: true, withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.sqlite')).map(d => join(d.parentPath, d.name))
  for (const f of files) {
    const db = new DatabaseSync(f, { readOnly: true })
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connector_accounts'").get() !== undefined) return f
    } finally {
      db.close()
    }
  }
  throw new Error(`No local D1 with connector_accounts under ${persist}.`)
}

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbFile())
  db.exec('PRAGMA busy_timeout = 10000')
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

type Prior = { last_state: string; connected_at_ms: number | null; disconnected_at_ms: number | null } | undefined

/**
 * Marks the Shopify account connected at `sinceMs` (the hub's connect date). Answers a function that puts the row back
 * as it was (removed, if there was none).
 */
export function connectShopifyAccount(sinceMs: number): () => void {
  if (!Number.isSafeInteger(sinceMs) || sinceMs <= 0) throw new Error(`The hub's Shopify connect date isn't a time: ${String(sinceMs)}`)
  const prior = withDb(db => {
    const before = db.prepare('SELECT last_state, connected_at_ms, disconnected_at_ms FROM connector_accounts WHERE account_id = ?').get(SHOPIFY_ACCOUNT_ID) as Prior
    db.prepare(
      `INSERT INTO connector_accounts (account_id, connector, last_state, last_state_at_ms, connected_at_ms) VALUES (?, 'shopify', 'connected', ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET last_state = 'connected', connected_at_ms = excluded.connected_at_ms, disconnected_at_ms = NULL`,
    ).run(SHOPIFY_ACCOUNT_ID, sinceMs, sinceMs)
    return before
  })
  return () => withDb(db => {
    if (prior === undefined) db.prepare('DELETE FROM connector_accounts WHERE account_id = ?').run(SHOPIFY_ACCOUNT_ID)
    else {
      db.prepare('UPDATE connector_accounts SET last_state = ?, connected_at_ms = ?, disconnected_at_ms = ? WHERE account_id = ?')
        .run(prior.last_state, prior.connected_at_ms, prior.disconnected_at_ms, SHOPIFY_ACCOUNT_ID)
    }
  })
}
