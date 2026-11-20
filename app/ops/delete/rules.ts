// What a person deletion does to each registered store, by store name. The registry's `personKeys` say where a member
// id sits, not what to do with the row, so every store needs a rule here: the job throws by name on an entry with no
// rule, or a rule its retention class doesn't allow, so a store a later phase registers can't be skipped silently.
// C1 and F1 add their stores' rules.
import type { RetentionClass } from '../tables/types.ts'

export type DeletionRule =
  /** `account`: the member row is pseudonymised in place by P2's `memberStore.pseudonymise` (the id stays, Q3). */
  | { action: 'pseudonymise' }
  /** D1: the rows whose `column` equals the member id are deleted (the rows the person owns). */
  | { action: 'delete_rows'; column: string }
  /** R2: every object under the entry's `<memberId>` pattern is deleted. */
  | { action: 'delete_objects' }
  /** Nothing changes; `why` says so for the reviewer. */
  | { action: 'keep'; why: string }

export const deletionRules: Readonly<Record<string, DeletionRule>> = {
  members: { action: 'pseudonymise' },
  // Personal settings only (owner = the member). A brand setting they changed (`updated_by`) or that names them as an
  // approver (`value_json`) keeps the id, which is pseudonymous once their row is.
  settings: { action: 'delete_rows', column: 'owner' },
  support_grants: { action: 'keep', why: 'the brand access history: created_by and ended_by keep the pseudonymous id' },
  audit_log: { action: 'keep', why: 'decision Q3: never shortened or edited' },
  'photos/': { action: 'delete_objects' },
  'backups/': { action: 'keep', why: 'kept 30 days by the R2 lifecycle rule (Q3)' },
  'restore/': { action: 'keep', why: 'kept 30 days by the R2 lifecycle rule (Q3)' },
  'deletion-log/': { action: 'keep', why: 'the deletion log is never shortened' },
}

/** The actions each retention class allows. */
export const ALLOWED: Readonly<Record<RetentionClass, readonly DeletionRule['action'][]>> = {
  audit: ['keep'],
  backup: ['keep'],
  account: ['pseudonymise'],
  config: ['delete_rows', 'keep'],
  retention_period: ['delete_rows', 'delete_objects', 'keep'],
  person: ['delete_rows', 'delete_objects'],
}
