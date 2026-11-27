// Export (P8 acceptance 3): the brand's data, or one person's, as an NDJSON stream. A plan counts (a dry run that writes
// nothing); the run takes only that plan and returns the stream: the caller decides where it goes (an export left in R2
// would be a new store holding personal data). Lines: a header listing every registry entry (so the export shows what
// isn't included and why), then `{ store, row }` per D1 row by primary key, `{ store, key, contentType, size, base64 }`
// per R2 object, and `{ end: true, counts }`. Export removes nothing, so it doesn't log.
//
// Three scopes:
// - `brand` (the ops CLI): every `export: true` entry, all of it.
// - `person` (C1): every row in which one of the entry's person keys equals the id, and every object under its
//   `<memberId>` pattern; another person's account row that only references them (members.invited_by) is cut to its key
//   columns, so a person's export never holds another person's name or email. A person's chats go whole (the chat
//   cascade's scope): every message in their chats (the agent's answers too), the chats' tool calls, files and file
//   bytes, matched by the chat's owner in addition to each row's person keys.
// - `brandForCaller` (route 95, "Export everything"): the brand's shared data and the caller's own, store by store as
//   brand-for-caller.ts declares; never another person's personal rows. Its header marks each store `all`, `part` or
//   `none`.
// Never a transcript, a Durable Object row or a derived index row (none of them is `export: true`).
//
// Memory stays bounded whatever the brand's size: D1 is read a keyset page at a time, R2 listed a page at a time by
// cursor, and each object's body streamed and base64'd in pieces of whole 3-byte groups (the line's prefix, the pieces,
// then its suffix), so no object is ever held whole. The stream has no queue of its own (high-water mark 0): nothing is
// read until the download asks for it.
// R2 list and get: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ (read 2026-11-20)
import { all, first, stmt } from '../../server/db/sql.ts'
import type { SqlValue } from '../../server/db/sql.ts'
import { chatFilesPrefix } from '../../server/db/r2-keys.ts'
import { ident, isMemberId, listPages, personPrefix, registryOf } from '../delete/r2.ts'
import type { JobDeps } from '../delete/r2.ts'
import type { TableEntry } from '../tables/types.ts'
import { BRAND_FOR_CALLER, OWN_CHATS } from './brand-for-caller.ts'
import type { CallerPolicy, ExportCaller, RowFilter } from './brand-for-caller.ts'

export type { ExportCaller } from './brand-for-caller.ts'

export type ExportScope = { kind: 'brand' } | { kind: 'person'; memberId: string } | { kind: 'brandForCaller'; caller: ExportCaller }

/** D1 queries and R2 calls. */
export interface ExportCost {
  readonly d1: number
  readonly r2: number
}

export interface ExportPlan {
  readonly scope: ExportScope
  readonly atMs: number
  readonly registry: readonly TableEntry[]
  /** Rows or objects per included store. */
  readonly counts: Readonly<Record<string, number>>
  /** The plan's own calls plus what the run is expected to make (at `PAGE` rows a query). */
  readonly cost: ExportCost
}

export type ExportRefusal = 'bad_id' | 'not_found' | 'not_person' | 'too_large'

const issued = new WeakSet<ExportPlan>()
/**
 * Rows per D1 query. Keyset paging (`WHERE (pk) > (last) ORDER BY pk LIMIT`): each page is one indexed read, however
 * deep.
 */
export const PAGE = 500

/**
 * One request's ceilings (Workers Paid, read 2026-11-24): 1,000 D1 queries per invocation
 * (https://developers.cloudflare.com/d1/platform/limits/) and 10,000 subrequests, every D1 and R2 call included
 * (https://developers.cloudflare.com/workers/platform/limits/). Route 95 streams inside the request that planned it, so
 * the plan's calls and the run's must fit together, with room left for the request path (sign-in, the grant, the audit
 * line): 900 D1 queries (about 400 pages, so roughly 200,000 rows across every exported table) and 9,000 R2 calls
 * (a get per object, a list per 1,000). A plan given this budget stops counting, and refuses `too_large`, once it's
 * past it.
 */
export const REQUEST_BUDGET: ExportCost = { d1: 900, r2: 9_000 }

class OverBudget extends Error {}

/** Counts the calls a plan makes and expects; throws `OverBudget` once past `budget` (none: never). */
function meter(budget: ExportCost | undefined) {
  const used = { d1: 0, r2: 0 }
  const check = () => {
    if (budget && (used.d1 > budget.d1 || used.r2 > budget.r2)) throw new OverBudget()
  }
  return {
    used,
    d1(n = 1) { used.d1 += n; check() },
    r2(n = 1) { used.r2 += n; check() },
  }
}
type Meter = ReturnType<typeof meter>

/** A D1 entry's filter for one person: each person key as a predicate, OR'ed. Null when nothing names them. */
export function personFilter(entry: TableEntry, memberId: string): RowFilter | null {
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

/** C1: the stores whose person export is the person's own chats', by the chat column. */
const CHAT_SCOPED: Readonly<Record<string, string>> = {
  chat_messages: 'chat_id', tool_calls: 'chat_id', chat_files: 'chat_id',
  // Stage 1 M3-B (#506): a batch's items name no person; they're the person's when their batch's chat is.
  outbox_items: 'chat_id',
}

/** A D1 entry's rows for one person: rows that name them or belong to their chats. */
function personScope(entry: TableEntry, memberId: string): RowFilter | null {
  // Skill ownership belongs to its maker. An editor link alone does not expose the skill body in their export.
  if (entry.name === 'brand_skills') return { where: 'created_by = ?', params: [memberId] }
  const person = personFilter(entry, memberId)
  const column = CHAT_SCOPED[entry.name]
  if (column === undefined) return person
  const chat = `${ident(column)} IN (${OWN_CHATS})`
  return person === null ? { where: chat, params: [memberId] }
    : { where: `(${person.where} OR ${chat})`, params: [...person.params, memberId] }
}

/** The plain-column person keys (members: id, invited_by). */
const plainKeys = (entry: TableEntry) => entry.personKeys.filter(k => !k.includes(':') && !k.endsWith('_json'))

/** brandForCaller: the entry's declared policy; an exported store without one refuses by name. */
function policyOf(entry: TableEntry): CallerPolicy {
  const p = Object.hasOwn(BRAND_FOR_CALLER, entry.name) ? BRAND_FOR_CALLER[entry.name] : undefined
  if (p === undefined) throw new Error(`export: ${entry.name} has no brandForCaller policy (ops/export/brand-for-caller.ts)`)
  const fits = entry.kind === 'd1' ? p.kind === 'whole' || p.kind === 'rows' : p.kind !== 'rows'
  if (!fits) throw new Error(`export: ${entry.name}'s brandForCaller policy ${p.kind} doesn't fit a ${entry.kind} store`)
  return p
}

const ALL: RowFilter = { where: '1', params: [] }

/** A D1 entry's rows in this scope; null when it has none. */
function filterOf(entry: TableEntry, scope: ExportScope): RowFilter | null {
  switch (scope.kind) {
    case 'brand': return ALL
    case 'person': return personScope(entry, scope.memberId)
    case 'brandForCaller': {
      const p = policyOf(entry)
      return p.kind === 'rows' ? p.where(scope.caller) : ALL
    }
  }
}

type Row = Record<string, unknown>

/** Shared connector config may match the caller through either attribution column. */
export const PERSON_EXPORT_SHARED_CONFIG = ['connector_accounts', 'notify_channels'] as const

/** What a D1 row becomes in this scope's export. */
function projectOf(entry: TableEntry, scope: ExportScope, pkCols: readonly string[]): (row: Row) => Row {
  if (scope.kind === 'person' && entry.name === 'members') {
    // Another person's account row that only references this one: its key columns only.
    const keep = [...new Set([...pkCols, ...plainKeys(entry)])]
    return row => (row.id !== scope.memberId ? Object.fromEntries(keep.map(c => [c, row[c]])) : row)
  }
  if (scope.kind === 'person' && PERSON_EXPORT_SHARED_CONFIG.some(name => name === entry.name)) {
    return row => Object.fromEntries(Object.entries(row).filter(([key, value]) => !entry.personKeys.includes(key) || value === null || value === scope.memberId))
  }
  if (scope.kind === 'brandForCaller') {
    const p = policyOf(entry)
    if (p.kind === 'rows' && p.project) {
      const project = p.project
      return row => project(row, scope.caller)
    }
  }
  return row => row
}

/** The caller's own chats' file prefixes (`files/<chatId>/`), one D1 query. */
async function ownChatPrefixes(db: D1Database, memberId: string, m: Meter): Promise<string[]> {
  m.d1()
  const chats = await all<{ id: string }>(db, stmt(`${OWN_CHATS} ORDER BY id`, memberId))
  return chats.map(c => chatFilesPrefix(c.id))
}

/** The prefixes one R2 store contributes in this scope. */
async function prefixesOf(db: D1Database, entry: TableEntry, scope: ExportScope, m: Meter): Promise<string[]> {
  if (scope.kind === 'brand') return [entry.name]
  if (scope.kind === 'person') {
    if (entry.name === 'files/') return ownChatPrefixes(db, scope.memberId, m)
    const prefix = personPrefix(entry, scope.memberId)
    return prefix === null ? [] : [prefix]
  }
  const p = policyOf(entry)
  const { caller } = scope
  switch (p.kind) {
    case 'whole': return [entry.name]
    case 'own_objects': {
      if (caller.kind !== 'person') return []
      const prefix = personPrefix(entry, caller.memberId)
      if (prefix === null) throw new Error(`export: ${entry.name} is own_objects but has no <memberId> pattern`)
      return [prefix]
    }
    case 'own_chat_files':
      if (entry.name !== 'files/') throw new Error(`export: ${entry.name} is own_chat_files but isn't files/`)
      return caller.kind === 'person' ? ownChatPrefixes(db, caller.memberId, m) : []
    case 'rows': throw new Error(`export: ${entry.name} is an R2 store with a rows policy`)
  }
}

/** The columns rows are paged by: the primary key in its declared order, or the rowid when a table has none. */
async function primaryKey(db: D1Database, table: string): Promise<{ cols: string[]; rowid: boolean }> {
  const cols = await all<{ name: string; pk: number }>(db, stmt(`PRAGMA table_info(${ident(table)})`))
  if (cols.length === 0) throw new Error(`export: no table ${table}`)
  const pk = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => ident(c.name))
  return pk.length > 0 ? { cols: pk, rowid: false } : { cols: [ROWID], rowid: true }
}

/** The rowid's alias in a page's rows (dropped before a row is written). */
const ROWID = '_export_rowid'

function included(registry: readonly TableEntry[], scope: ExportScope): TableEntry[] {
  return registry.filter(e => {
    if (!e.export) return false
    if (e.kind === 'do') throw new Error(`export: no Durable Object reader yet for ${e.name}`)
    if (scope.kind === 'brandForCaller') policyOf(e)
    return true
  })
}

/** brandForCaller's header mark: how much of a store this caller's export holds. */
function share(entry: TableEntry, caller: ExportCaller): 'all' | 'part' | 'none' {
  if (!entry.export) return 'none'
  const p = policyOf(entry)
  switch (p.kind) {
    case 'whole': return 'all'
    case 'rows': return p.where(caller) === null ? 'none' : 'part'
    case 'own_objects': case 'own_chat_files': return caller.kind === 'person' ? 'part' : 'none'
  }
}

/**
 * The dry run: counts only. A person export needs a person row (any status, pseudonymised or not). With `budget`, the
 * plan refuses `too_large` as soon as its own calls and the run's expected ones pass it.
 */
export async function planExport(deps: JobDeps, scope: ExportScope, opts: { budget?: ExportCost } = {}): Promise<{ ok: ExportPlan } | { refused: ExportRefusal }> {
  const registry = registryOf(deps)
  const m = meter(opts.budget)
  try {
    if (scope.kind === 'person' || scope.kind === 'brandForCaller') {
      const memberId = scope.kind === 'person' ? scope.memberId : scope.caller.memberId
      if (!isMemberId(memberId)) return { refused: 'bad_id' }
    }
    if (scope.kind === 'person') {
      m.d1()
      const row = await first<{ kind: string }>(deps.db, stmt('SELECT kind FROM members WHERE id = ?', scope.memberId))
      if (!row) return { refused: 'not_found' }
      if (row.kind !== 'person') return { refused: 'not_person' }
    }
    const counts: Record<string, number> = {}
    for (const e of included(registry, scope)) {
      if (e.kind === 'd1') {
        const filter = filterOf(e, scope)
        if (filter === null) {
          counts[e.name] = 0
          continue
        }
        m.d1()
        const r = await first<{ n: number }>(deps.db, stmt(`SELECT COUNT(*) AS n FROM ${ident(e.name)} WHERE ${filter.where}`, ...filter.params))
        if (!r) throw new Error(`export: no count from ${e.name}`)
        counts[e.name] = r.n
        // The run: its PRAGMA, then a page per PAGE rows and the short (or empty) page that ends the store.
        m.d1(1 + Math.floor(r.n / PAGE) + 1)
      } else {
        // The run makes the same reads again (the chats query, every list page) and gets every object.
        const before = m.used.d1
        const prefixes = await prefixesOf(deps.db, e, scope, m)
        m.d1(m.used.d1 - before)
        let n = 0
        for (const prefix of prefixes) {
          for await (const page of listPages(deps.bucket, prefix)) {
            m.r2(2)
            n += page.length
            m.r2(page.length)
          }
        }
        counts[e.name] = n
      }
    }
    const plan: ExportPlan = Object.freeze({
      scope: Object.freeze(scope.kind === 'brandForCaller' ? { kind: scope.kind, caller: Object.freeze({ ...scope.caller }) } : { ...scope }),
      atMs: deps.at.nowMs,
      registry: Object.freeze([...registry]),
      counts: Object.freeze(counts),
      cost: Object.freeze({ ...m.used }),
    })
    issued.add(plan)
    return { ok: plan }
  } catch (err) {
    if (err instanceof OverBudget) return { refused: 'too_large' }
    throw err
  }
}

/** Bytes in per base64 piece: whole 3-byte groups (no padding mid-object), 32 KiB of base64 out. */
export const B64_PIECE = 3 * 8192

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000))
  return btoa(s)
}

const encoder = new TextEncoder()
const line = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value) + '\n')

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a)
  out.set(b, a.byteLength)
  return out
}

/**
 * One object's line, streamed: `{"store":…,"key":…,"contentType":…,"size":…,"base64":"`, then its body base64'd a piece
 * at a time as it's read, then `"}` and the newline. Fails when the bytes read aren't the object's size.
 */
async function* objectLine(bucket: R2Bucket, store: string, key: string): AsyncGenerator<Uint8Array> {
  const obj = await bucket.get(key)
  if (obj === null) throw new Error(`export: ${key} vanished while it was read`)
  const head = JSON.stringify({ store, key, contentType: obj.httpMetadata?.contentType ?? null, size: obj.size })
  // The reader is taken before the first yield, and every yield sits inside the try, so a download cancelled at any
  // point (the prefix included) reaches the finally and lets R2 stop sending.
  const reader = obj.body.getReader()
  let carry: Uint8Array = new Uint8Array(0)
  let read = 0
  let ended = false
  try {
    yield encoder.encode(`${head.slice(0, -1)},"base64":"`)
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      let chunk: Uint8Array = next.value
      read += chunk.byteLength
      if (carry.byteLength > 0) {
        const need = 3 - carry.byteLength
        if (chunk.byteLength < need) {
          carry = join(carry, chunk)
          continue
        }
        yield encoder.encode(base64(join(carry, chunk.subarray(0, need))))
        chunk = chunk.subarray(need)
      }
      const whole = chunk.byteLength - (chunk.byteLength % 3)
      for (let i = 0; i < whole; i += B64_PIECE) yield encoder.encode(base64(chunk.subarray(i, Math.min(i + B64_PIECE, whole))))
      carry = chunk.slice(whole)
    }
    ended = true
  } catch (err) {
    ended = true
    throw err
  } finally {
    // The download was cancelled mid-object: let R2 stop sending.
    if (!ended) await reader.cancel()
  }
  if (carry.byteLength > 0) yield encoder.encode(base64(carry))
  if (read !== obj.size) throw new Error(`export: ${key} read ${read} bytes of ${obj.size}`)
  yield encoder.encode('"}\n')
}

async function* chunks(deps: JobDeps, plan: ExportPlan, pageSize: number): AsyncGenerator<Uint8Array> {
  const { db, bucket } = deps
  const { scope } = plan
  const stores = plan.registry.map(e => ({
    kind: e.kind, name: e.name, retention: e.retention, export: e.export,
    ...(scope.kind === 'brandForCaller' ? { included: share(e, scope.caller) } : {}),
  }))
  yield line({
    format: 1,
    kind: scope.kind,
    ...(scope.kind === 'person' ? { memberId: scope.memberId } : {}),
    ...(scope.kind === 'brandForCaller' ? { memberId: scope.caller.memberId } : {}),
    atMs: plan.atMs,
    stores,
  })
  const counts: Record<string, number> = {}
  // The run's own calls aren't budgeted again: the plan counted them.
  const unmetered = meter(undefined)
  for (const entry of included(plan.registry, scope)) {
    counts[entry.name] = 0
    if (entry.kind === 'd1') {
      const filter = filterOf(entry, scope)
      if (filter === null) continue
      const pk = await primaryKey(db, entry.name)
      const project = projectOf(entry, scope, pk.cols)
      const select = pk.rowid ? `SELECT rowid AS ${ROWID}, *` : 'SELECT *'
      const order = pk.cols.join(', ')
      let last: SqlValue[] | null = null
      for (;;) {
        const after: RowFilter = last === null
          ? { where: '', params: [] }
          : { where: ` AND (${order}) > (${pk.cols.map(() => '?').join(', ')})`, params: last }
        const rows: Row[] = await all<Row>(db, stmt(
          `${select} FROM ${ident(entry.name)} WHERE (${filter.where})${after.where} ORDER BY ${order} LIMIT ?`, ...filter.params, ...after.params, pageSize,
        ))
        for (const row of rows) {
          const { [ROWID]: _rowid, ...data } = row
          counts[entry.name]++
          yield line({ store: entry.name, row: project(pk.rowid ? data : row) })
        }
        if (rows.length < pageSize) break
        const end = rows[rows.length - 1]
        last = pk.cols.map(c => end[c] as SqlValue)
      }
    } else {
      for (const prefix of await prefixesOf(db, entry, scope, unmetered)) {
        for await (const page of listPages(bucket, prefix)) {
          for (const obj of page) {
            counts[entry.name]++
            yield* objectLine(bucket, entry.name, obj.key)
          }
        }
      }
    }
  }
  yield line({ end: true, counts })
}

/** The export as NDJSON. Reads as the stream is pulled; a storage failure errors the stream (no `end` line). */
export function runExport(deps: JobDeps, plan: ExportPlan, opts: { pageSize?: number } = {}): ReadableStream<Uint8Array> {
  if (!issued.has(plan)) throw new Error('export: runs only from a plan made by planExport')
  const pageSize = opts.pageSize ?? PAGE
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('export: pageSize must be 1 to 1,000')
  const it = chunks(deps, plan, pageSize)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await it.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      await it.return(undefined)
    },
  }, { highWaterMark: 0 })
}
