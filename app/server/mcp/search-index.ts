// The search indexes (p3-design section 10, W6): two FTS5 external-content tables over memories.text and
// chat_messages.text (migration 0141). Derived, never canonical: P8's backup skips them and their shadow tables (the
// registry marks them `derived`, ops/tables/memory.ts) and, after a restore, calls `rebuildSearchIndexes`.
// D1 supports FTS5 (https://developers.cloudflare.com/d1/sql-api/sql-statements/, read 2026-11-20) and exports no
// database with a virtual table (https://developers.cloudflare.com/d1/best-practices/import-export-data/, read
// 2026-11-20: delete the virtual tables, export, recreate them).
import { runBatch, stmt } from '../db/sql.ts'

export interface DerivedSearchTable {
  /** The FTS5 virtual table. */
  readonly name: string
  /** The table it indexes (its `content=`); `n` is the rowid. */
  readonly from: string
  /** The shadow tables FTS5 keeps for it (an external-content table has no `_content`). */
  readonly shadow: readonly string[]
}

const shadow = (name: string) => ['data', 'idx', 'docsize', 'config'].map(s => `${name}_${s}`)

/** Every derived search table, with its source and its shadow tables. */
export const DERIVED_SEARCH_TABLES: readonly DerivedSearchTable[] = [
  { name: 'memories_fts', from: 'memories', shadow: shadow('memories_fts') },
  { name: 'chat_messages_fts', from: 'chat_messages', shadow: shadow('chat_messages_fts') },
]

/** Rebuilds each index from its source table, in one batch (FTS5's `'rebuild'` command). */
export async function rebuildSearchIndexes(db: D1Database): Promise<void> {
  await runBatch(db, DERIVED_SEARCH_TABLES.map(t => stmt(`INSERT INTO ${t.name}(${t.name}) VALUES ('rebuild')`)))
}
