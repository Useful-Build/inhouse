// A backup that can't be taken, named: `code` says which rule it broke, the message names the table or value.

export type BackupErrorCode =
  | 'bad_identifier' | 'missing_table' | 'virtual_table' | 'no_rule' | 'rule_without_entry' | 'rule_cycle'
  | 'rule_after_unknown' | 'append_only_key' | 'snapshot_too_large' | 'unsupported_value' | 'row_too_large'
  | 'no_migration' | 'no_columns' | 'unregistered_table' | 'rule_for_derived' | 'derived_from_unknown' | 'derived_not_virtual'
  | 'mode_rule'

export class BackupError extends Error {
  readonly code: BackupErrorCode
  constructor(code: BackupErrorCode, detail: string) {
    super(`backup: ${code} (${detail})`)
    this.code = code
    this.name = 'BackupError'
  }
}

/** A restore that refuses before writing: `reason` is `<code>: <detail>`, as the restore record stores it. */
export class RestoreRefusal extends Error {
  readonly reason: string
  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'RestoreRefusal'
    this.reason = this.message
  }
}
