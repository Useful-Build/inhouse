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
   */
  mode: 'snapshot' | 'append_only'
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
  return { rules: restoreOrder(rules), derived }
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
