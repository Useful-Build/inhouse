// The table registry's entry (P2 plan, "The table registry"; P8 builds retention, export and person deletion on it).
// Every D1 table, Durable Object store and R2 prefix the product writes has exactly one entry
// (completeness.test.ts), added in the PR that adds the store.

/**
 * How long a store's rows live (P8's terms):
 * - `audit`: never shortened or edited, excluded from retention and person deletion (decision Q3); names people by
 *   member id only.
 * - `account`: kept while the brand's deployment lives; a person deletion pseudonymises their row in place (the id stays).
 * - `config`: kept while the deployment lives; a person deletion removes the rows the person key names.
 * - `retention_period`: removed once older than the brand's retention period (Data and access), and with the person.
 * - `person`: removed with the person it belongs to, and replaced in place when they change it (a photo).
 */
export type RetentionClass = 'audit' | 'account' | 'config' | 'retention_period' | 'person'

export interface TableEntry {
  /** `d1`: a table in server/migrations; `do`: a Durable Object class in wrangler.product.jsonc; `r2`: a key prefix. */
  kind: 'd1' | 'do' | 'r2'
  /** The table name, the Durable Object class name, or the R2 prefix (ending in `/`). */
  name: string
  retention: RetentionClass
  /**
   * Every place a person's member id sits: a column (d1; `column:$.path` for a member id inside a JSON column), a field
   * (do) or a key segment (r2, as `<memberId>` in the pattern). Empty when the store holds nothing of a person's.
   */
  personKeys: readonly string[]
  /** Included in "Export everything" (P8). */
  export: boolean
  /**
   * `d1` only: a derived index (an FTS5 table), rebuilt from the tables in `from` rather than backed up. The backup
   * skips it and its FTS5 shadow tables and lists it in the manifest; a restore records it as needing a rebuild (P8).
   */
  derived?: { from: readonly string[] }
}
