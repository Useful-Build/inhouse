// The migration check between a backup and a restore target (#585). PRs merge out of number order (0790 landed before
// 0780), and wrangler applies every file `d1_migrations` doesn't name yet in name order
// (https://developers.cloudflare.com/d1/reference/migrations/ read 2026-11-27), so two databases holding the same
// migrations can record them in a different apply order. The last row by id isn't a migration level: the check compares
// the whole set of applied names. Policy (runbook "Restore", step 2; the ops repo's house-restore-drill migrates the
// target to exactly the backup's migrations): the sets must be equal. A backup taken before a later migration, even an
// additive one, is refused on a target that has it; the reason names each migration missing or extra on the target.

/** The applied migration names as a set: sorted by name (code-unit order, as SQLite's BINARY collation), no duplicate. */
export function migrationSet(names: readonly string[]): string[] {
  const sorted = [...names].sort(byName)
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new Error(`d1_migrations names ${sorted[i]} twice`)
  return sorted
}

/** Code-unit order, which is SQLite's BINARY collation for these ASCII names. */
export function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Migrations the backup has and the target lacks (`missing`), and the target has and the backup lacks (`extra`). */
export function migrationDiff(backup: readonly string[], target: readonly string[]): { missing: string[]; extra: string[] } {
  const b = new Set(backup)
  const t = new Set(target)
  return { missing: [...b].filter(n => !t.has(n)).sort(byName), extra: [...t].filter(n => !b.has(n)).sort(byName) }
}

/** The names, at most 10, then how many more. */
function list(names: readonly string[]): string {
  return names.length <= 10 ? names.join(', ') : `${names.slice(0, 10).join(', ')} and ${names.length - 10} more`
}

/** The refusal detail when the sets differ (`missing on the target [..]; extra on the target [..]`), null when equal. */
export function migrationMismatch(backup: readonly string[], target: readonly string[]): string | null {
  const { missing, extra } = migrationDiff(backup, target)
  const parts = [
    ...(missing.length > 0 ? [`missing on the target [${list(missing)}]`] : []),
    ...(extra.length > 0 ? [`extra on the target [${list(extra)}]`] : []),
  ]
  return parts.length === 0 ? null : parts.join('; ')
}
