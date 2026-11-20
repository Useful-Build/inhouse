// Every R2 prefix the product writes (ops/tables/completeness.test.ts fails when one isn't in the table registry).
export const R2_PREFIXES = ['photos/', 'backups/', 'restore/', 'deletion-log/'] as const

/** An id that goes into a key: no separator, so it can't leave its place in the layout. */
const segment = (what: string, value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`r2-keys: ${what} ${JSON.stringify(value)} can't go into a key`)
  return value
}

/** A member's photo object: `photos/<memberId>/<random>`, a new key on every upload (PR 3's photo route). */
export const photoKey = (memberId: string, random: string): string => `photos/${memberId}/${random}`

/** A backup's manifest, written last (P8 G1): `backups/d1/<backupId>/manifest.json`. No manifest, no backup. */
export const backupManifestKey = (backupId: string): string => `backups/d1/${segment('backupId', backupId)}/manifest.json`

/** One part (up to 1,000 rows, NDJSON) of one table in a backup: `backups/d1/<backupId>/<table>/<00000>.ndjson`. */
export const backupPartKey = (backupId: string, table: string, part: number): string =>
  `backups/d1/${segment('backupId', backupId)}/${segment('table', table)}/${String(part).padStart(5, '0')}.ndjson`

/** A file of one restore (P8 G1): `restore/<restoreId>/<name>`, `name` a relative path such as `record.json`. */
export const restoreKey = (restoreId: string, name: string): string => {
  if (!name || name.startsWith('/') || name.split('/').some(s => s === '' || s === '..')) throw new Error(`r2-keys: restore file name ${JSON.stringify(name)} can't go into a key`)
  return `restore/${segment('restoreId', restoreId)}/${name}`
}

/**
 * One deletion-log entry (P8 G2): `deletion-log/<atMs, 13 digits>-<runId>-<step, 4 digits>-<phase>.json`. A listing
 * sorts by time across runs and, within one run (one clock, so one `atMs`), by `step`: the run numbers its entries
 * 0, 1, 2... in write order.
 */
export const deletionLogKey = (atMs: number, runId: string, step: number, phase: string): string => {
  if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > 9_999_999_999_999) throw new Error(`r2-keys: atMs ${JSON.stringify(atMs)} can't go into a key`)
  if (!Number.isSafeInteger(step) || step < 0 || step > 9999) throw new Error(`r2-keys: step ${JSON.stringify(step)} can't go into a key`)
  return `deletion-log/${String(atMs).padStart(13, '0')}-${segment('runId', runId)}-${String(step).padStart(4, '0')}-${segment('phase', phase)}.json`
}
