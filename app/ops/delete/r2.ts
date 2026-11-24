// What P8's jobs (retention, export, person deletion) share: their deps, the member id rule, the registry's person
// patterns and the jobs' only R2 calls. The R2 calls never delete under the backup set or the deletion log (decision Q3: a
// deleted person leaves backups by the 30-day lifecycle rule; the deletion log is never shortened).
// R2 Workers API (list with prefix, cursor, truncated, limit max 1,000; delete with up to 1,000 keys; uploaded is a Date):
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ (read 2026-11-20)
import type { At } from '../../server/db/members.ts'
import type { PersonDataAnswer } from '../../server/do/brand-agent/ports.ts'
import { R2_PREFIXES } from '../../server/db/r2-keys.ts'
import { tables } from '../tables/index.ts'
import type { TableEntry } from '../tables/types.ts'

/**
 * `at.nowMs` is the job's one clock for what it decides (a cutoff, a pseudonymised row's time); tests pin it. `clock`
 * stamps each deletion-log entry when it's written (default `Date.now`), so an entry sorts by when it happened, never
 * by when it was planned. `registry` defaults to the real one; tests pass fixtures.
 */
export interface JobDeps {
  db: D1Database
  bucket: R2Bucket
  at: At
  clock?: () => number
  registry?: readonly TableEntry[]
  /** C1: the BrandAgent's `personData` (its stub, or a double in tests), for the person deletion's BrandAgent part. */
  brandAgent?: { personData(p: { personId: string; mode: 'count' | 'delete' }): Promise<PersonDataAnswer> }
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

/** Every object under `prefix` after `startAfter`, in key order, following every page; at most `max` of them. */
export async function listAll(bucket: R2Bucket, prefix: string, startAfter?: string, max = Infinity): Promise<R2Object[]> {
  const out: R2Object[] = []
  let cursor: string | undefined
  while (out.length < max) {
    const page = await bucket.list({ prefix, cursor, startAfter: cursor === undefined ? startAfter : undefined, limit: 1000, include: ['httpMetadata'] })
    out.push(...page.objects)
    if (!page.truncated) break
    if (page.cursor === undefined) throw new Error(`ops: R2 listed ${prefix} as truncated with no cursor`)
    cursor = page.cursor
  }
  return out.slice(0, max)
}

/**
 * Every object under `prefix`, a listing page (up to 1,000) at a time, following the cursor: the caller holds one page,
 * never the whole listing.
 */
export async function* listPages(bucket: R2Bucket, prefix: string): AsyncGenerator<R2Object[]> {
  let cursor: string | undefined
  for (;;) {
    const page = await bucket.list({ prefix, cursor, limit: 1000 })
    yield page.objects
    if (!page.truncated) return
    if (page.cursor === undefined) throw new Error(`ops: R2 listed ${prefix} as truncated with no cursor`)
    cursor = page.cursor
  }
}

/** Deletes `keys`, 1,000 per call. Refuses, before deleting anything, a key under the backup set or the deletion log. */
export async function deleteKeys(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  const kept = keys.find(k => KEPT_PREFIXES.some(p => k.startsWith(p)))
  if (kept !== undefined) throw new Error(`ops: refusing to delete ${JSON.stringify(kept)} (the backup set and the deletion log are never deleted by a job)`)
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000))
}
