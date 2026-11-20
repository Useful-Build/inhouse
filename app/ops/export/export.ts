// Export (P8 acceptance 3): the brand's data, or one person's, as an NDJSON stream. A plan counts (a dry run that writes
// nothing); the run takes only that plan and returns the stream: the caller decides where it goes (an export left in R2
// would be a new store holding personal data). Lines: a header listing every registry entry (so the export shows what
// isn't included and why), then `{ store, row }` per D1 row by primary key, `{ store, key, contentType, size, base64 }`
// per R2 object, and `{ end: true, counts }`. Brand: every `export: true` entry, all of it. Person: every row in which
// one of the entry's person keys equals the id, and every object under its `<memberId>` pattern; another person's
// account row that only references them (members.invited_by) is cut to its key columns, so a person's export never
// holds another person's name or email. Export removes nothing, so it doesn't log.
// R2 list and get: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ (read 2026-11-20)
import { all, first, stmt } from '../../server/db/sql.ts'
import type { SqlValue } from '../../server/db/sql.ts'
import { ident, isMemberId, listAll, personPrefix, readObject, registryOf } from '../delete/r2.ts'
import type { JobDeps } from '../delete/r2.ts'
import type { TableEntry } from '../tables/types.ts'

export type ExportScope = { kind: 'brand' } | { kind: 'person'; memberId: string }

export interface ExportPlan {
  readonly scope: ExportScope
  readonly atMs: number
  readonly registry: readonly TableEntry[]
  /** Rows or objects per included store. */
  readonly counts: Readonly<Record<string, number>>
}

export type ExportRefusal = 'bad_id' | 'not_found' | 'not_person'

const issued = new WeakSet<ExportPlan>()
/**
 * Rows per D1 query. Keyset paging (`WHERE (pk) > (last) ORDER BY pk LIMIT`): each page is one indexed read, however
 * deep. The ceiling is D1's queries per invocation (1,000 on Workers Paid): about 500 pages, so roughly 250,000 rows
 * across every exported table, less the plan's counts and the PRAGMA reads, per invocation.
 */
export const PAGE = 500

/** A D1 entry's filter for one person: each person key as a predicate, OR'ed. Null when nothing names them. */
export function personFilter(entry: TableEntry, memberId: string): { where: string; params: SqlValue[] } | null {
  const parts: string[] = []
  const params: SqlValue[] = []
  for (const key of entry.personKeys) {
    const [column, path] = key.split(':', 2) as [string, string | undefined]
    if (path !== undefined) {
      if (!/^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(path)) throw new Error(`export: ${entry.name}'s person key ${JSON.stringify(key)} has no plain JSON path`)
      parts.push(`json_extract(${ident(column)}, ?) = ?`)
      params.push(path, memberId)
    } else if (column.endsWith('_json')) {
      // A bare JSON column holding the id as its whole value (settings.value_json: an approver).
      parts.push(`${ident(column)} = json_quote(?)`)
      params.push(memberId)
    } else {
      parts.push(`${ident(column)} = ?`)
      params.push(memberId)
    }
  }
  return parts.length === 0 ? null : { where: parts.map(p => `(${p})`).join(' OR '), params }
}

/** The plain-column person keys (members: id, invited_by). */
const plainKeys = (entry: TableEntry) => entry.personKeys.filter(k => !k.includes(':') && !k.endsWith('_json'))

/** The columns rows are paged by: the primary key in its declared order, or the rowid when a table has none. */
async function primaryKey(db: D1Database, table: string): Promise<{ cols: string[]; rowid: boolean }> {
  const cols = await all<{ name: string; pk: number }>(db, stmt(`PRAGMA table_info(${ident(table)})`))
  if (cols.length === 0) throw new Error(`export: no table ${table}`)
  const pk = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => ident(c.name))
  return pk.length > 0 ? { cols: pk, rowid: false } : { cols: [ROWID], rowid: true }
}

/** The rowid's alias in a page's rows (dropped before a row is written). */
const ROWID = '_export_rowid'

function included(registry: readonly TableEntry[]): TableEntry[] {
  return registry.filter(e => {
    if (!e.export) return false
    if (e.kind === 'do') throw new Error(`export: no Durable Object reader yet for ${e.name}`)
    return true
  })
}

/** The objects one store contributes: all of them (brand), or those under the person's pattern. */
async function objectsOf(bucket: JobDeps['bucket'], entry: TableEntry, scope: ExportScope): Promise<R2Object[]> {
  if (scope.kind === 'brand') return listAll(bucket, entry.name)
  const prefix = personPrefix(entry, scope.memberId)
  return prefix === null ? [] : listAll(bucket, prefix)
}

async function countRows(db: D1Database, entry: TableEntry, scope: ExportScope): Promise<number> {
  const filter = scope.kind === 'person' ? personFilter(entry, scope.memberId) : { where: '1', params: [] }
  if (filter === null) return 0
  const r = await first<{ n: number }>(db, stmt(`SELECT COUNT(*) AS n FROM ${ident(entry.name)} WHERE ${filter.where}`, ...filter.params))
  if (!r) throw new Error(`export: no count from ${entry.name}`)
  return r.n
}

/** The dry run: counts only. A person export needs a person row (any status, pseudonymised or not). */
export async function planExport(deps: JobDeps, scope: ExportScope): Promise<{ ok: ExportPlan } | { refused: ExportRefusal }> {
  const registry = registryOf(deps)
  if (scope.kind === 'person') {
    if (!isMemberId(scope.memberId)) return { refused: 'bad_id' }
    const row = await first<{ kind: string }>(deps.db, stmt('SELECT kind FROM members WHERE id = ?', scope.memberId))
    if (!row) return { refused: 'not_found' }
    if (row.kind !== 'person') return { refused: 'not_person' }
  }
  const counts: Record<string, number> = {}
  for (const e of included(registry)) {
    counts[e.name] = e.kind === 'd1' ? await countRows(deps.db, e, scope) : (await objectsOf(deps.bucket, e, scope)).length
  }
  const plan: ExportPlan = Object.freeze({ scope: Object.freeze({ ...scope }), atMs: deps.at.nowMs, registry: Object.freeze([...registry]), counts: Object.freeze(counts) })
  issued.add(plan)
  return { ok: plan }
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function* lines(deps: JobDeps, plan: ExportPlan, pageSize: number): AsyncGenerator<unknown> {
  const { db, bucket } = deps
  const { scope } = plan
  yield {
    format: 1,
    kind: scope.kind,
    ...(scope.kind === 'person' ? { memberId: scope.memberId } : {}),
    atMs: plan.atMs,
    stores: plan.registry.map(e => ({ kind: e.kind, name: e.name, retention: e.retention, export: e.export })),
  }
  const counts: Record<string, number> = {}
  for (const entry of included(plan.registry)) {
    counts[entry.name] = 0
    if (entry.kind === 'd1') {
      const filter = scope.kind === 'person' ? personFilter(entry, scope.memberId) : { where: '1', params: [] }
      if (filter === null) continue
      const pk = await primaryKey(db, entry.name)
      // Another person's account row that only references this one: its key columns only.
      const cut = scope.kind === 'person' && entry.retention === 'account'
        ? (row: Record<string, unknown>) => pk.cols.some(c => row[c] !== scope.memberId)
          ? Object.fromEntries([...new Set([...pk.cols, ...plainKeys(entry)])].map(c => [c, row[c]]))
          : row
        : (row: Record<string, unknown>) => row
      const select = pk.rowid ? `SELECT rowid AS ${ROWID}, *` : 'SELECT *'
      const order = pk.cols.join(', ')
      let last: SqlValue[] | null = null
      for (;;) {
        const after: { where: string; params: SqlValue[] } = last === null
          ? { where: '', params: [] }
          : { where: ` AND (${order}) > (${pk.cols.map(() => '?').join(', ')})`, params: last }
        const rows: Record<string, unknown>[] = await all<Record<string, unknown>>(db, stmt(
          `${select} FROM ${ident(entry.name)} WHERE (${filter.where})${after.where} ORDER BY ${order} LIMIT ?`, ...filter.params, ...after.params, pageSize,
        ))
        for (const row of rows) {
          const { [ROWID]: _rowid, ...data } = row
          counts[entry.name]++
          yield { store: entry.name, row: cut(pk.rowid ? data : row) }
        }
        if (rows.length < pageSize) break
        const end = rows[rows.length - 1]
        last = pk.cols.map(c => end[c] as SqlValue)
      }
    } else {
      for (const obj of await objectsOf(bucket, entry, scope)) {
        const { bytes, contentType } = await readObject(bucket, obj.key)
        counts[entry.name]++
        yield { store: entry.name, key: obj.key, contentType, size: bytes.byteLength, base64: base64(bytes) }
      }
    }
  }
  yield { end: true, counts }
}

/** The export as NDJSON. Reads as the stream is pulled; a storage failure errors the stream (no `end` line). */
export function runExport(deps: JobDeps, plan: ExportPlan, opts: { pageSize?: number } = {}): ReadableStream<Uint8Array> {
  if (!issued.has(plan)) throw new Error('export: runs only from a plan made by planExport')
  const pageSize = opts.pageSize ?? PAGE
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('export: pageSize must be 1 to 1,000')
  const it = lines(deps, plan, pageSize)
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await it.next()
      if (next.done) controller.close()
      else controller.enqueue(encoder.encode(JSON.stringify(next.value) + '\n'))
    },
    async cancel() {
      await it.return(undefined)
    },
  })
}
