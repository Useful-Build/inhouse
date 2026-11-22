// The backup's format (P8 G1), shared by the backup, the restore's snapshot and its proof: each table as parts of NDJSON,
// one line per row, a JSON array of the column values in the manifest's column order. A part closes at 1,000 rows or
// 1,000,000 bytes, whichever comes first: the restore binds a whole part as one string, and D1 caps a string at
// 2,000,000 bytes (https://developers.cloudflare.com/d1/platform/limits/, read 2026-11-20).
import { BackupError } from './errors.ts'
import { ident } from './tables.ts'
import type { TableRule } from './tables.ts'

export const PART_ROWS = 1_000
export const PART_BYTES = 1_000_000
/**
 * Rows per query when an append-only table is paged (the backup, the snapshot, the proof): apart from the part size,
 * so a restore's D1 queries per 100,000 audit lines stay near 140 against the 1,000 a Worker invocation may make.
 */
export const READ_PAGE_ROWS = 5_000
/** A `snapshot` table is read whole inside one batch; past this the batch's result is too big to hold. */
export const SNAPSHOT_MAX_ROWS = 10_000

export type CellValue = string | number | null

const encoder = new TextEncoder()

/** One row as its NDJSON line (with the newline). A value other than a string, a finite number or null throws by name. */
export function encodeRow(table: string, columns: readonly string[], row: Record<string, unknown>): string {
  const cells = columns.map(c => {
    const v = row[c]
    if (v === null || typeof v === 'string') return v
    if (typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))) return v
    throw new BackupError('unsupported_value', `${table}.${c}`)
  })
  return `${JSON.stringify(cells)}\n`
}

/** Workers' streaming SHA-256 (`crypto.DigestStream`); the DOM lib's `Crypto` type, merged in here, hides it. */
export const newDigest = (): DigestStream => new (crypto as unknown as { DigestStream: typeof DigestStream }).DigestStream('SHA-256')

export const toHex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

export interface PartInfo { key: string; rows: number; sha256: string }
export interface TableDigest { rows: number; sha256: string; parts: PartInfo[] }

/**
 * Collects a table's lines into parts and hands each closed part to `put` (which returns its R2 key, or '' when the
 * bytes only need counting, as in the restore's proof). The table's sha256 runs over every part's bytes in order.
 */
export class TableWriter {
  private lines: string[] = []
  private bytes = 0
  private rows = 0
  private readonly parts: PartInfo[] = []
  private readonly digest = newDigest()
  private readonly hash = this.digest.getWriter()

  private readonly table: string
  private readonly put: (part: number, bytes: Uint8Array) => Promise<string>

  constructor(table: string, put: (part: number, bytes: Uint8Array) => Promise<string>) {
    this.table = table
    this.put = put
  }

  async add(line: string): Promise<void> {
    const size = encoder.encode(line).byteLength
    if (size > PART_BYTES) throw new BackupError('row_too_large', `${this.table}: ${size} bytes`)
    if (this.lines.length === PART_ROWS || this.bytes + size > PART_BYTES) await this.flush()
    this.lines.push(line)
    this.bytes += size
  }

  private async flush(): Promise<void> {
    if (this.lines.length === 0) return
    const bytes = encoder.encode(this.lines.join(''))
    await this.hash.write(bytes)
    const key = await this.put(this.parts.length, bytes)
    this.parts.push({ key, rows: this.lines.length, sha256: await sha256(bytes) })
    this.rows += this.lines.length
    this.lines = []
    this.bytes = 0
  }

  async finish(): Promise<TableDigest> {
    await this.flush()
    await this.hash.close()
    return { rows: this.rows, sha256: toHex(await this.digest.digest), parts: this.parts }
  }
}

/** A table's columns in declared order (`PRAGMA table_info`). */
export async function tableColumns(db: D1Database, table: string): Promise<string[]> {
  const cols = (await db.prepare(`PRAGMA table_info(${ident(table)})`).all<{ cid: number; name: string }>()).results
  if (cols.length === 0) throw new BackupError('no_columns', table)
  return cols.sort((a, b) => a.cid - b.cid).map(c => c.name)
}

const selectList = (columns: readonly string[]) => columns.map(ident).join(', ')
const orderList = (rule: TableRule) => rule.orderBy.map(ident).join(', ')

/** The point batch's read of a `snapshot` table: one row past the cap, so a table over it is caught. */
export const snapshotSelect = (db: D1Database, rule: TableRule, columns: readonly string[]): D1PreparedStatement =>
  db.prepare(`SELECT ${selectList(columns)} FROM ${ident(rule.name)} ORDER BY ${orderList(rule)} LIMIT ${SNAPSHOT_MAX_ROWS + 1}`)

/** An `append_only` table's id column. */
export function appendKey(rule: TableRule): string {
  if (rule.mode !== 'append_only' || rule.orderBy.length !== 1) throw new BackupError('append_only_key', rule.name)
  return rule.orderBy[0]
}

export const maxIdSelect = (db: D1Database, rule: TableRule): D1PreparedStatement =>
  db.prepare(`SELECT COALESCE(MAX(${ident(appendKey(rule))}), 0) AS max FROM ${ident(rule.name)}`)

/**
 * The rows of an `append_only` table with an id at or below `maxId`, a page of `pageRows` (default `READ_PAGE_ROWS`) at a time, in id order.
 * With `createdAtMost` (C1), only rows created at or before it: SQLite reuses the largest rowid of an INTEGER PRIMARY
 * KEY without AUTOINCREMENT, so a row inserted after the point batch can take a deleted row's id at or below `maxId`.
 */
export async function* appendRows(db: D1Database, rule: TableRule, columns: readonly string[], maxId: number, createdAtMost?: number): AsyncGenerator<Record<string, unknown>> {
  const key = ident(appendKey(rule))
  const bound = createdAtMost === undefined ? '' : ` AND ${ident(createdKey(rule))} <= ?`
  const pageRows = rule.pageRows ?? READ_PAGE_ROWS
  const sql = `SELECT ${selectList(columns)} FROM ${ident(rule.name)} WHERE ${key} > ? AND ${key} <= ?${bound} ORDER BY ${key} LIMIT ${pageRows}`
  let after = 0
  for (;;) {
    const page = (await db.prepare(sql).bind(after, maxId, ...(createdAtMost === undefined ? [] : [createdAtMost])).all<Record<string, unknown>>()).results
    for (const row of page) yield row
    if (page.length < pageRows) return
    after = page[page.length - 1][appendKey(rule)] as number
  }
}

const keyList = (rule: TableRule) => `(${orderList(rule)})`

/** C1: the creation column of a table read after the point batch (`insert_only`, `paged`, a bounded `append_only`). */
export function createdKey(rule: TableRule): string {
  if (rule.mode === 'snapshot' || rule.createdColumn === undefined) throw new BackupError('mode_rule', `${rule.name}: no createdColumn to bound by`)
  return rule.createdColumn
}

/** The point batch's read of a table bounded by its creation column: its largest creation value (the point) and its row count. */
export const pointSelect = (db: D1Database, rule: TableRule): D1PreparedStatement =>
  db.prepare(`SELECT COALESCE(MAX(${ident(createdKey(rule))}), 0) AS point, COUNT(*) AS n FROM ${ident(rule.name)}`)

/**
 * C1: every row of a table by primary key (one or more columns, compared as a row value), a page of `pageRows` (default `READ_PAGE_ROWS`) at
 * a time; with `createdAtMost`, only the rows created at or before it. The `paged` and `insert_only`
 * backups read with it, and the restore's proof re-reads a target with it.
 * Row values: https://sqlite.org/rowvalue.html (read 2026-11-22).
 */
export async function* keyRows(db: D1Database, rule: TableRule, columns: readonly string[], opts: { createdAtMost?: number } = {}): AsyncGenerator<Record<string, unknown>> {
  const pageRows = rule.pageRows ?? READ_PAGE_ROWS
  const created = opts.createdAtMost === undefined ? null : ident(createdKey(rule))
  const where = (after: boolean) => [created === null ? '' : `${created} <= ?`, after ? `${keyList(rule)} > (${rule.orderBy.map(() => '?').join(', ')})` : ''].filter(Boolean)
  const sql = (after: boolean) => {
    const w = where(after)
    return `SELECT ${selectList(columns)} FROM ${ident(rule.name)}${w.length > 0 ? ` WHERE ${w.join(' AND ')}` : ''} ORDER BY ${orderList(rule)} LIMIT ${pageRows}`
  }
  let last: unknown[] | null = null
  for (;;) {
    const args = [...(opts.createdAtMost === undefined ? [] : [opts.createdAtMost]), ...(last ?? [])]
    const page: Record<string, unknown>[] = (await db.prepare(sql(last !== null)).bind(...args).all<Record<string, unknown>>()).results
    for (const row of page) yield row
    if (page.length < pageRows) return
    last = rule.orderBy.map(c => page[page.length - 1][c])
  }
}

/**
 * The restore's write of one part: one statement, the part's rows bound once as a JSON array. Never `OR REPLACE`.
 * https://developers.cloudflare.com/d1/sql-api/query-json/ (json_each over a bound JSON array), read 2026-11-20.
 */
export const insertPartSql = (table: string, columns: readonly string[]): string =>
  `INSERT INTO ${ident(table)} (${selectList(columns)}) SELECT ${columns.map((_, i) => `json_extract(value, '$[${i}]')`).join(', ')} FROM json_each(?)`

/** A part's NDJSON lines (each with its newline). */
export const partLines = (text: string): string[] => (text === '' ? [] : text.split(/(?<=\n)/))

/**
 * Whether a part's line is one row of `width` cells as the backup writes it: a JSON array ending in a newline, each
 * cell a string, a finite number or null. The restore refuses a part with any other line before it writes.
 */
export function isRowLine(line: string, width: number): boolean {
  if (!line.endsWith('\n')) return false
  let cells: unknown
  try { cells = JSON.parse(line) } catch { return false }
  return Array.isArray(cells) && cells.length === width
    && cells.every(v => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))
}

/** Lines as the JSON array the insert binds. */
export const linesAsArray = (lines: readonly string[]): string => `[${lines.map(l => l.slice(0, -1)).join(',')}]`
