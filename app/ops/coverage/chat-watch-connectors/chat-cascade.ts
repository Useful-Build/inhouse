// The chat cascade (P8 C1): what goes with a chat, shared by person deletion, retention and the person export. For each
// chat in scope (a person's own chats, soft-deleted ones included; or a chat past retention):
//  1. its objects under `files/<chatId>/` and `sessions/<chatId>/`, listed and deleted first, so a re-run still finds
//     the chat in D1 and lists its prefixes (an object already gone is fine);
//  2. in one D1 batch, children before the chat (D1 enforces foreign keys per statement): the chat's files' Library
//     marks (`source = 'chat'`), `chat_files`, `tool_calls`, `chat_messages` (their search index follows by trigger),
//     then the `chats` row;
//  3. its BrandAgent rows: `personData` for a person (person.ts), the in-object functions for retention
//     (brand-agent-storage.ts).
// Re-runs are idempotent: every step deletes what is still there.
import { chatFilesPrefix, chatSessionsPrefix } from '../../../server/db/r2-keys.ts'
import { all, first, stmt } from '../../../server/db/sql.ts'
import type { SqlValue, Stmt } from '../../../server/db/sql.ts'
import { deleteKeys, listAll } from '../../delete/r2.ts'

/** The D1 stores the cascade removes rows from, in delete order (children first). */
export const CASCADE_D1 = ['library_marks', 'chat_files', 'tool_calls', 'chat_messages', 'chats'] as const
/** The R2 prefixes it removes objects under, one folder per chat. */
export const CASCADE_R2 = ['files/', 'sessions/'] as const
export type CascadeStore = (typeof CASCADE_D1)[number] | (typeof CASCADE_R2)[number]

/** Which chats: a SQL condition on `chats` (as `c`) and its parameters. */
export interface ChatScope { where: string; params: SqlValue[] }

/** A person's own chats, soft-deleted ones included. */
export const ownedBy = (memberId: string): ChatScope => ({ where: 'c.owner_id = ?', params: [memberId] })
/** The chats in `ids`. */
export const chatsIn = (ids: readonly string[]): ChatScope => ({ where: `c.id IN (${ids.map(() => '?').join(', ') || 'NULL'})`, params: [...ids] })

const inScope = (scope: ChatScope) => `SELECT c.id FROM chats c WHERE ${scope.where}`

/** Each D1 store's rows in scope, as a condition on the store's own table. */
function rowsOf(store: (typeof CASCADE_D1)[number], scope: ChatScope): { table: string; where: string; params: SqlValue[] } {
  switch (store) {
    case 'chats': return { table: 'chats', where: `id IN (${inScope(scope)})`, params: scope.params }
    case 'library_marks': return { table: 'library_marks', where: `source = 'chat' AND file_id IN (SELECT id FROM chat_files WHERE chat_id IN (${inScope(scope)}))`, params: scope.params }
    default: return { table: store, where: `chat_id IN (${inScope(scope)})`, params: scope.params }
  }
}

/** The ids of the chats in scope, in id order. */
export async function chatIds(db: D1Database, scope: ChatScope, limit?: number): Promise<string[]> {
  const rows = await all<{ id: string }>(db, stmt(`SELECT c.id FROM chats c WHERE ${scope.where} ORDER BY c.id${limit === undefined ? '' : ' LIMIT ?'}`, ...scope.params, ...(limit === undefined ? [] : [limit])))
  return rows.map(r => r.id)
}

/** The objects of the chats in `ids`, per prefix. */
export async function cascadeObjects(bucket: R2Bucket, ids: readonly string[]): Promise<Record<(typeof CASCADE_R2)[number], string[]>> {
  const out: Record<(typeof CASCADE_R2)[number], string[]> = { 'files/': [], 'sessions/': [] }
  for (const id of ids) {
    out['files/'].push(...(await listAll(bucket, chatFilesPrefix(id))).map(o => o.key))
    out['sessions/'].push(...(await listAll(bucket, chatSessionsPrefix(id))).map(o => o.key))
  }
  return out
}

/** How many rows and objects the cascade would remove for `scope` (the chats' ids already read, for the objects). */
export async function countCascade(db: D1Database, bucket: R2Bucket, scope: ChatScope, ids: readonly string[]): Promise<Record<CascadeStore, number>> {
  const counts = {} as Record<CascadeStore, number>
  for (const store of CASCADE_D1) {
    const r = rowsOf(store, scope)
    const n = await first<{ n: number }>(db, stmt(`SELECT COUNT(*) AS n FROM ${r.table} WHERE ${r.where}`, ...r.params))
    if (!n) throw new Error(`chat cascade: no count from ${store}`)
    counts[store] = n.n
  }
  const objects = await cascadeObjects(bucket, ids)
  for (const p of CASCADE_R2) counts[p] = objects[p].length
  return counts
}

/** Step 1: deletes the chats' objects; returns the keys per prefix. */
export async function deleteCascadeObjects(bucket: R2Bucket, ids: readonly string[]): Promise<Record<(typeof CASCADE_R2)[number], string[]>> {
  const objects = await cascadeObjects(bucket, ids)
  await deleteKeys(bucket, [...objects['files/'], ...objects['sessions/']])
  return objects
}

/** Step 2's statements, children before the chat; run them in one batch (`runBatch`) with any other deletes. */
export function cascadeRowStatements(scope: ChatScope): { store: (typeof CASCADE_D1)[number]; stmt: Stmt }[] {
  return CASCADE_D1.map(store => {
    const r = rowsOf(store, scope)
    return { store, stmt: stmt(`DELETE FROM ${r.table} WHERE ${r.where}`, ...r.params) }
  })
}

/**
 * The person-scope safety check (B2): a message, tool call or chat file that names the person but sits in a chat they
 * don't own. The cascade removes only their own chats' rows, so any such row would stay; the plan refuses instead.
 */
export async function outsideOwnChats(db: D1Database, memberId: string): Promise<Record<string, number>> {
  const own = `SELECT id FROM chats WHERE owner_id = ?`
  const checks: [string, string][] = [['chat_messages', 'author_id'], ['tool_calls', 'member_id'], ['chat_files', 'created_by']]
  const out: Record<string, number> = {}
  for (const [table, column] of checks) {
    const n = await first<{ n: number }>(db, stmt(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ? AND chat_id NOT IN (${own})`, memberId, memberId))
    if (!n) throw new Error(`chat cascade: no count from ${table}`)
    if (n.n > 0) out[`${table}.${column}`] = n.n
  }
  return out
}
