// How retention ages each `retention_period` store, by store name. The job throws by name on a `retention_period`
// entry with no rule here, so a store a later phase registers can't be skipped silently. P2 has no such store; C1 adds
// P3 to P5's, F1 P6 and P7's.
export type RetentionRule =
  /**
   * A D1 table: a row goes when `ageColumn` (epoch ms) is strictly before the cutoff. `idColumn` is the table's whole
   * primary key (one column): the run deletes by it in bounded rounds and logs it.
   */
  | { kind: 'd1'; ageColumn: string; idColumn: string }
  /** An R2 prefix: an object goes when its `uploaded` time is strictly before the cutoff; its key is logged. */
  | { kind: 'r2' }

export const retentionRules: Readonly<Record<string, RetentionRule>> = {}
