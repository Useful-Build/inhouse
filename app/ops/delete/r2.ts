// What P8's jobs (retention, export, person deletion) share, and their only R2 calls: their deps, the member id rule, the registry's person
// patterns and the R2 calls. The R2 calls never delete under the backup set or the deletion log (decision Q3: a
// deleted person leaves backups by the 30-day lifecycle rule; the deletion log is never shortened).
// R2 Workers API (list with prefix, cursor, truncated, limit max 1,000; delete with up to 1,000 keys; uploaded is a Date):
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ (read 2026-11-20)
import type { At } from '../../server/db/members.ts'
import { R2_PREFIXES } from '../../server/db/r2-keys.ts'
import { tables } from '../tables/index.ts'
import type { TableEntry } from '../tables/types.ts'

/** One clock per job: `at.nowMs` (tests pin it). `registry` defaults to the real one; tests pass fixtures. */
export interface JobDeps {
  db: D1Database
  bucket: R2Bucket
  at: At
  registry?: readonly TableEntry[]
}

export const registryOf = (deps: { registry?: readonly TableEntry[] }): readonly TableEntry[] => deps.registry ?? tables

const MEMBER_ID = /^m_[A-Za-z0-9_-]+$/
export const isMemberId = (id: string): boolean => MEMBER_ID.test(id)

/** A D1 name from the registry or a rule, checked before it goes into SQL text (never a value from a request). */
export function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`ops: ${JSON.stringify(name)} is not a plain SQL name`)
  return name
}

/** The R2 prefixes no job deletes under: the backup set (G1, kept 30 days) and the deletion log (never shortened). */
const KEPT_PREFIXES = R2_PREFIXES.filter(p => p === 'backups/' || p === 'restore/' || p === 'deletion-log/')
if (KEPT_PREFIXES.length !== 3) throw new Error('ops: r2-keys.ts no longer lists backups/, restore/ and deletion-log/')

/**
 * An r2 entry's prefix for one member: the person key holding `<memberId>` with the id in its place, or null when the
 * entry has none. The id is checked first, and the result must stay under the entry's own prefix.
 */
export function personPrefix(entry: TableEntry, memberId: string): string | null {
  if (!isMemberId(memberId)) throw new Error(`ops: ${JSON.stringify(memberId)} is not a member id`)
  const pattern = entry.personKeys.find(k => k.includes('<memberId>'))
  if (pattern === undefined) return null
  const prefix = pattern.replace('<memberId>', memberId)
  if (!prefix.startsWith(entry.name) || !prefix.endsWith('/') || prefix.includes('<')) throw new Error(`ops: ${entry.name}'s person pattern ${JSON.stringify(pattern)} is not a prefix under it`)
  return prefix
}

/** Every object under `prefix`, in key order (all pages). */
export async function listAll(bucket: R2Bucket, prefix: string, startAfter?: string): Promise<R2Object[]> {
  const out: R2Object[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await bucket.list({ prefix, cursor, startAfter: cursor === undefined ? startAfter : undefined, limit: 1000, include: ['httpMetadata'] })
    out.push(...page.objects)
    if (!page.truncated) return out
    cursor = page.cursor
  }
}

/** One object's bytes and content type; throws by key when it's gone (it was listed a moment before). */
export async function readObject(bucket: R2Bucket, key: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const body = await bucket.get(key)
  if (body === null) throw new Error(`ops: ${key} vanished while it was read`)
  return { bytes: new Uint8Array(await body.arrayBuffer()), contentType: body.httpMetadata?.contentType ?? null }
}

/** Deletes `keys`, 1,000 per call. Refuses, before deleting anything, a key under the backup set or the deletion log. */
export async function deleteKeys(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  const kept = keys.find(k => KEPT_PREFIXES.some(p => k.startsWith(p)))
  if (kept !== undefined) throw new Error(`ops: refusing to delete ${JSON.stringify(kept)} (the backup set and the deletion log are never deleted by a job)`)
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000))
}
