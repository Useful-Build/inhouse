// The canonical tables (P8 G1): one rule per D1 table that can't be rebuilt from another. The canonical set is the
// table registry's `d1` entries (ops/tables) without `derived`, and each must have a rule here. A `derived` entry (an
// FTS5 index) is rebuilt from its source tables instead (ops/backup/fts, later): the backup skips it and its shadow
// tables. `canonicalTables` throws by name on anything else (an unregistered table, a virtual table that isn't derived).
// D1's own tables (`d1_migrations`, `sqlite_*`, `_cf_*`) aren't backed up: a restore's target is migrated to the
// same level instead.
import { tables as realRegistry } from '../tables/index.ts'
import type { TableEntry } from '../tables/types.ts'
import { BackupError } from './errors.ts'

export interface TableRule {
  name: string
  /** The primary key, in order. An `append_only` table's is one integer column (its id). */
  orderBy: readonly string[]
  /**
   * `snapshot`: read in full inside the point batch. `append_only`: rows are only ever added with a rising id, so the
   * point batch records its max id and the rows at or below it are read after.
   * `insert_only` (C1): rows are never updated but the key isn't one rising integer; the point batch records the
   * largest `createdColumn` value (the point) and the row count, and the rows created at or before the point are read
   * after, by primary key. A count that differs at the read marks the table `paged` in the manifest.
   * `paged` (C1): an updated table that can pass 10,000 rows, read by primary key after the point batch, keeping only
   * the rows created at or before its point (so a row whose parent was created after the point batch stays out). D1 has
   * no read snapshot across queries, so an update during the read may show: the manifest and the restore record mark it
   * `paged`.
   */
  mode: 'snapshot' | 'append_only' | 'insert_only' | 'paged'
  /**
   * The creation time column (epoch ms) that bounds the rows read after the point batch: required on `insert_only` and
   * `paged`, optional on `append_only` (where a deleted top row's rowid can be reused), never on `snapshot`.
   */
  createdColumn?: string
  /**
   * Rows per read page after the point batch (default `READ_PAGE_ROWS`, 5,000). Smaller for a table with unbounded
   * text columns, so a page stays under D1's 50 MB result limit at a 100 KB average row
   * (https://developers.cloudflare.com/d1/platform/limits/, read 2026-11-22); a page past it fails the backup loudly.
   */
  pageRows?: number
  /** Tables whose rows must be restored first (foreign keys). */
  after?: readonly string[]
  /** Columns that hold an R2 key (the restore reports the keys whose object is gone). */
  r2KeyColumns?: readonly string[]
}

export const TABLE_RULES: readonly TableRule[] = [
  { name: 'members', orderBy: ['id'], mode: 'snapshot', r2KeyColumns: ['photo_key'] },
  { name: 'settings', orderBy: ['owner', 'key'], mode: 'snapshot' },
  { name: 'support_grants', orderBy: ['id'], mode: 'snapshot' },
  // `actor_id` references members(id), and D1 enforces foreign keys.
  { name: 'audit_log', orderBy: ['id'], mode: 'append_only', after: ['members'] },
  // P3 and P4's tables (P8 C1). `after` comes from each table's foreign keys (tables.test.ts reads them from the
  // migrated schema). The updated tables that can pass 10,000 rows are `paged`; the never-updated composite-key ones
  // are `insert_only` by their creation time (tables.test.ts fails on any UPDATE or REPLACE of them in the product).
  { name: 'chats', orderBy: ['id'], mode: 'paged', createdColumn: 'created_at_ms', after: ['members'] },
  // Only ever inserted (`ON CONFLICT(id) DO NOTHING`, server/do/brand-agent/projection.ts); tables.test.ts fails on
  // any UPDATE or REPLACE in the product's code.
  { name: 'chat_messages', orderBy: ['n'], mode: 'append_only', createdColumn: 'at_ms', pageRows: 500, after: ['chats'] },
  // No foreign key, but a tool call belongs to its chat.
  { name: 'tool_calls', orderBy: ['turn_id', 'n'], mode: 'insert_only', createdColumn: 'at_ms', after: ['chats'] },
  { name: 'chat_files', orderBy: ['id'], mode: 'paged', createdColumn: 'created_at_ms', after: ['chats'], r2KeyColumns: ['r2_key'] },
  { name: 'usage_months', orderBy: ['month'], mode: 'snapshot' },
  { name: 'usage_jobs', orderBy: ['job_id'], mode: 'paged', createdColumn: 'created_at_ms' },
  { name: 'usage_turns', orderBy: ['turn_id'], mode: 'paged', createdColumn: 'created_at_ms', after: ['usage_months'] },
  { name: 'usage_extends', orderBy: ['turn_id', 'call_id'], mode: 'paged', createdColumn: 'at_ms', after: ['usage_turns'] },
  // The audit copy's cursor; its reset after a restore is F1's.
  { name: 'audit_copy_state', orderBy: ['id'], mode: 'snapshot' },
  { name: 'connector_accounts', orderBy: ['account_id'], mode: 'snapshot', after: ['members'] },
  { name: 'notify_channels', orderBy: ['channel_id'], mode: 'snapshot', after: ['members'] },
  { name: 'notify_channel_list', orderBy: ['id'], mode: 'snapshot' },
  { name: 'notify_sends', orderBy: ['id'], mode: 'paged', createdColumn: 'at_ms' },
  { name: 'team_requests', orderBy: ['id'], mode: 'paged', createdColumn: 'created_at_ms', after: ['members'] },
  { name: 'brand_skills', orderBy: ['id'], mode: 'snapshot', after: ['members'] },
  { name: 'memories', orderBy: ['n'], mode: 'snapshot', after: ['members'] },
  { name: 'routines', orderBy: ['id'], mode: 'snapshot', after: ['members'] },
  // A slot is created when it's claimed.
  { name: 'routine_slots', orderBy: ['slot_key'], mode: 'paged', createdColumn: 'claimed_at_ms', pageRows: 500, after: ['routines'] },
  { name: 'routine_alerts', orderBy: ['code'], mode: 'snapshot' },
  { name: 'today_items', orderBy: ['id'], mode: 'paged', createdColumn: 'created_at_ms', pageRows: 500, after: ['routine_slots'] },
  { name: 'today_aside', orderBy: ['item_id'], mode: 'snapshot', after: ['members'] },
  // `activity_no_update` refuses every UPDATE (0230).
  { name: 'activity_lines', orderBy: ['n'], mode: 'append_only', createdColumn: 'at_ms', after: ['members'] },
  { name: 'notices', orderBy: ['id'], mode: 'paged', createdColumn: 'at_ms', pageRows: 500, after: ['members'] },
  { name: 'notice_reads', orderBy: ['member_id', 'notice_id'], mode: 'insert_only', createdColumn: 'at_ms', after: ['members', 'notices'] },
  { name: 'library_uploads', orderBy: ['id'], mode: 'paged', createdColumn: 'created_at_ms', after: ['members'], r2KeyColumns: ['r2_key'] },
  { name: 'library_marks', orderBy: ['file_id'], mode: 'snapshot', after: ['members'] },
  // P8a: the egress record. `egress_fetches_no_update` refuses every UPDATE (0600), and rows only ever arrive with a
  // rising n.
  { name: 'egress_fetches', orderBy: ['n'], mode: 'append_only' },
  // M1-G: keyed token digests for the fetch leak check (0705). Upserted on re-sighting, capped at 50,000 rows.
  { name: 'egress_taint', orderBy: ['digest'], mode: 'paged', createdColumn: 'seen_at_ms' },
  // P8a F2: a few rows a year, and closing one updates it, so a whole snapshot.
  { name: 'privacy_requests', orderBy: ['id'], mode: 'snapshot' },
  // Stage 1 M2-A: the ceiling and the grants are small and updated (a revoke), so whole snapshots; a grant's holder
  // references members. The uses are updated too (a release) and grow with every grant-backed send: paged.
  { name: 'permission_ceiling', orderBy: ['operation'], mode: 'snapshot' },
  { name: 'permission_grants', orderBy: ['id'], mode: 'snapshot', after: ['members'] },
  { name: 'permission_uses', orderBy: ['id'], mode: 'paged', createdColumn: 'at_ms' },
  // Stage 1 M3-L: insert-only, growing with every batch item given back: paged.
  { name: 'permission_item_releases', orderBy: ['id'], mode: 'paged', createdColumn: 'at_ms' },
  // Stage 1 M2-B: the gate is one row; the actions are updated through their life and grow with every write: paged. A
  // restore holds the outbox (M2-R: every restored approved or sending row to "Needs a check").
  { name: 'outbox_gate', orderBy: ['id'], mode: 'snapshot' },
  { name: 'outbox_actions', orderBy: ['id'], mode: 'paged', createdColumn: 'created_at_ms' },
  // Stage 1 M3-B: a batch's items, updated through their send and growing with every batch: paged, restored after their
  // batches (no foreign key, but an item belongs to its batch). A restore holds them with their batch (every pending or
  // sending item of a held batch to "Needs a check").
  { name: 'outbox_items', orderBy: ['item_id'], mode: 'paged', createdColumn: 'created_at_ms', after: ['outbox_actions'] },
  // Stage 1 M2-Q: few rows, each updated once or twice (answered, delivered), so a whole snapshot.
  { name: 'questions', orderBy: ['id'], mode: 'snapshot' },
  // Stage 1 M3-R: the eval write log and its faults, written only on the eval deployment and cleared per case-repeat;
  // empty everywhere else, so whole snapshots.
  { name: 'eval_write_log', orderBy: ['n'], mode: 'snapshot' },
  { name: 'eval_write_fault', orderBy: ['operation'], mode: 'snapshot' },
]

/** A name that goes into SQL as a quoted identifier: letters, digits and `_` only. */
export const ident = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new BackupError('bad_identifier', name)
  return `"${name}"`
}

/** D1's own tables: never backed up (the target is migrated to the same level instead). */
const D1_INTERNAL = /^(?:d1_migrations$|sqlite_|_cf_)/
const isVirtual = (sql: string) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql)
/** An FTS5 virtual table: the only kind a `derived` entry may name (its shadow tables are skipped with it). */
const isFts5 = (sql: string) => isVirtual(sql) && /\bUSING\s+fts5\b/i.test(sql)

export interface DerivedTable { name: string; from: string[] }

/**
 * The canonical tables' rules in restore order (each table after the tables in its `after`), and the derived tables
 * (registry entries with `derived`, FTS5 indexes rebuilt rather than backed up, sorted by name), checked against the
 * registry and the database's own schema. Throws by name on: a table in the database that's in no entry (and isn't
 * D1's own or, per SQLite, a shadow of a registered virtual table), a virtual table whose entry isn't `derived`, a `derived`
 * entry that isn't an FTS5 virtual table, an entry with no table, a canonical entry with no rule, a rule with no entry
 * or for a derived table, a derived table built from a table that isn't canonical.
 */
export async function canonicalTables(db: D1Database, registry: readonly TableEntry[] = realRegistry, rules: readonly TableRule[] = TABLE_RULES): Promise<{ rules: TableRule[]; derived: DerivedTable[] }> {
  const entries = registry.filter(e => e.kind === 'd1')
  const canonical = entries.filter(e => !e.derived).map(e => e.name)
  const derived = entries.filter(e => e.derived).map(e => ({ name: e.name, from: [...(e.derived?.from ?? [])] })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const schema = new Map((await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all<{ name: string; sql: string | null }>()).results.map(r => [r.name, r.sql ?? '']))
  const shadows = await shadowTables(db, entries.filter(e => isVirtual(schema.get(e.name) ?? '')).map(e => e.name))
  for (const [name, sql] of schema) {
    if (D1_INTERNAL.test(name) || entries.some(e => e.name === name) || shadows.has(name)) continue
    throw new BackupError(isVirtual(sql) ? 'virtual_table' : 'unregistered_table', `${name}: in no registry entry`)
  }
  for (const d of derived) {
    const sql = schema.get(d.name)
    if (sql === undefined) throw new BackupError('missing_table', d.name)
    if (!isFts5(sql)) throw new BackupError('derived_not_virtual', `${d.name}: not an FTS5 virtual table`)
    if (rules.some(r => r.name === d.name)) throw new BackupError('rule_for_derived', d.name)
    if (d.from.length === 0 || d.from.some(f => !canonical.includes(f))) throw new BackupError('derived_from_unknown', `${d.name} from [${d.from.join(', ')}]`)
  }
  for (const name of canonical) {
    const sql = schema.get(name)
    if (sql === undefined) throw new BackupError('missing_table', name)
    if (isVirtual(sql)) throw new BackupError('virtual_table', `${name}: its entry isn't derived`)
    if (!rules.some(r => r.name === name)) throw new BackupError('no_rule', name)
  }
  for (const r of rules) if (!canonical.includes(r.name)) throw new BackupError('rule_without_entry', r.name)
  for (const r of rules) await checkMode(db, r)
  return { rules: restoreOrder(rules), derived }
}

/**
 * C1: an `insert_only` or `paged` rule names a real creation column, an `append_only` one may, and a `snapshot` one
 * doesn't. Throws `mode_rule` by name.
 */
async function checkMode(db: D1Database, r: TableRule): Promise<void> {
  if (r.mode === 'snapshot') {
    if (r.createdColumn !== undefined) throw new BackupError('mode_rule', `${r.name}: createdColumn is not for snapshot`)
    return
  }
  if (r.createdColumn === undefined) {
    if (r.mode !== 'append_only') throw new BackupError('mode_rule', `${r.name}: ${r.mode} needs a createdColumn`)
    return
  }
  const column = (await db.prepare(`PRAGMA table_info(${ident(r.name)})`).all<{ name: string; notnull: number; pk: number }>()).results.find(c => c.name === r.createdColumn)
  if (!column) throw new BackupError('mode_rule', `${r.name}: createdColumn ${r.createdColumn} is not a column`)
  // A NULL creation time fails `<= point`, so the bounded read would drop the row silently (B2, #336 round 2).
  if (column.notnull !== 1 && column.pk === 0) throw new BackupError('mode_rule', `${r.name}: createdColumn ${r.createdColumn} may be NULL`)
}

/**
 * The shadow tables SQLite itself keeps for the given virtual tables: `PRAGMA table_list` rows of type `shadow`
 * (https://sqlite.org/pragma.html#pragma_table_list) named `<owner>_...`. Taken from SQLite rather than from a list of
 * FTS5 suffixes, so only a table that really is a shadow (a contentless FTS5 table has no `_content`) is skipped, and
 * a virtual table whose entry isn't derived fails as itself, not as its shadows.
 */
export async function shadowTables(db: D1Database, owners: readonly string[]): Promise<Set<string>> {
  const rows = (await db.prepare('PRAGMA table_list').all<{ name: string; type: string }>()).results
  return new Set(rows.filter(r => r.type === 'shadow' && owners.some(o => r.name.startsWith(`${o}_`))).map(r => r.name))
}

/** The rules ordered so every table comes after the tables in its `after`; a cycle or an unknown name throws. */
export function restoreOrder(rules: readonly TableRule[]): TableRule[] {
  const byName = new Map(rules.map(r => [r.name, r]))
  const out: TableRule[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (r: TableRule) => {
    if (state.get(r.name) === 'done') return
    if (state.get(r.name) === 'visiting') throw new BackupError('rule_cycle', r.name)
    state.set(r.name, 'visiting')
    for (const dep of r.after ?? []) {
      const d = byName.get(dep)
      if (!d) throw new BackupError('rule_after_unknown', `${r.name} after ${dep}`)
      visit(d)
    }
    state.set(r.name, 'done')
    out.push(r)
  }
  for (const r of rules) visit(r)
  return out
}
