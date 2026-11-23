// Every R2 prefix the product writes (ops/tables/completeness.test.ts fails when one isn't in the table registry).
// P3's owners add their prefixes at their own anchor below, each with its registry entry and key builders, in the same PR.
export const R2_PREFIXES = [
  'photos/',

  // W3 (p3-w3.md): 'sessions/' (PR 1), 'files/' (PR 2); entries in ops/tables/files.ts.
  'sessions/',
  // INVARIANT (see CHAT_FILES_PREFIX): every live object here has a chat_files row naming its key.
  'files/',

  // W4 (p3-w4.md): the audit log's daily copy (entry in ops/tables/usage.ts).
  'audit-copy/',

  // P4 W5 (p4-w5.md): Library uploads (entry in ops/tables/library.ts).
  'library/',

  // P8 G1 and G2: backups, restores and the deletion log (entries in ops/tables/p8.ts).
  'backups/',
  'restore/',
  'deletion-log/',
] as const

/** An id that goes into a key: no separator, so it can't leave its place in the layout. */
const segment = (what: string, value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`r2-keys: ${what} ${JSON.stringify(value)} can't go into a key`)
  return value
}

/** A member's photo object: `photos/<memberId>/<random>`, a new key on every upload (PR 3's photo route). */
export const photoKey = (memberId: string, random: string): string => `photos/${memberId}/${random}`

// W3's key builders (sessions/, files/).
/** The bucket a module writes only through these builders (the egress's store route). */
export type KeyedBucket = R2Bucket
/** A session's folder in the store: `sessions/<chatId>/<sessionId>/<projectHash>/` (p3-design 8.5). */
export const sessionPrefix = (chatId: string, sessionId: string, projectHash: string): string => `sessions/${chatId}/${sessionId}/${projectHash}/`
/** One stored part: `<sub>` is `m` (the main transcript) or `s/<encodeURIComponent(subpath)>` (a subagent's). */
export const sessionKey = (chatId: string, sessionId: string, projectHash: string, sub: string, part: string): string =>
  `${sessionPrefix(chatId, sessionId, projectHash)}${sub}/${part}.json`

/**
 * The prefix of every chat file's bytes (the orphan sweep lists it). INVARIANT: every live object under `files/` has a
 * `chat_files` row naming its key; the sweep deletes old objects with none. Any new holder of a `files/` key must be added
 * to the sweep's lookup (files-io/orphan-sweep.ts `namedSql`) in the same PR; `orphan-sweep.test.ts` pins the callers.
 */
export const CHAT_FILES_PREFIX = 'files/'
/** A chat file's bytes: `files/<chatId>/<fileId>` (an attachment or an output, p3-design 8.5). */
export const chatFileKey = (chatId: string, fileId: string): string => `${CHAT_FILES_PREFIX}${chatId}/${fileId}`
/** P8 C1: every file of one chat, `files/<chatId>/` (the chat cascade lists and deletes it). */
export const chatFilesPrefix = (chatId: string): string => `${CHAT_FILES_PREFIX}${segment('chatId', chatId)}/`
/** P8 C1: every session of one chat, `sessions/<chatId>/` (the chat cascade lists and deletes it). */
export const chatSessionsPrefix = (chatId: string): string => `sessions/${segment('chatId', chatId)}/`

// W4's key builders (audit-copy/).
/** One range of the audit log's daily copy: `audit-copy/<date>/<fromId>-<toId>.jsonl` (p3-design section 9). */
export const auditCopyKey = (date: string, fromId: number, toId: number): string => `audit-copy/${date}/${fromId}-${toId}.jsonl`

// P4 W5's key builder (library/).
/** A team upload's bytes: `library/<fileId>` (p4-w5 section 2). */
export const libraryKey = (fileId: string): string => `library/${fileId}`

// P8 G1 and G2's key builders (backups/, restore/, deletion-log/).
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
