// Every R2 prefix the product writes (ops/tables/completeness.test.ts fails when one isn't in the table registry).
// P3's owners add their prefixes at their own anchor below, each with its registry entry and key builders, in the same PR.
export const R2_PREFIXES = [
  'photos/',

  // W3 (p3-w3.md): 'sessions/' (PR 1), 'files/' (PR 2); entries in ops/tables/files.ts.
  'sessions/',
  'files/',

  // W4 (p3-w4.md): the audit log's daily copy (entry in ops/tables/usage.ts).
  'audit-copy/',
] as const

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

/** A chat file's bytes: `files/<chatId>/<fileId>` (an attachment or an output, p3-design 8.5). */
export const chatFileKey = (chatId: string, fileId: string): string => `files/${chatId}/${fileId}`

// W4's key builders (audit-copy/).
/** One range of the audit log's daily copy: `audit-copy/<date>/<fromId>-<toId>.jsonl` (p3-design section 9). */
export const auditCopyKey = (date: string, fromId: number, toId: number): string => `audit-copy/${date}/${fromId}-${toId}.jsonl`
