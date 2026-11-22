// A thin D1 layer: statements are plain `{ sql, params }` values, so the same builders run on D1 (one `DB.batch`, one
// transaction) and render as a SQL file for `wrangler d1 execute --file` (server/seed/first-admin.ts).
// D1 runs a batch as one transaction, statements in order, and rolls the whole batch back when one fails:
// https://developers.cloudflare.com/d1/worker-api/d1-database/ (batch), read 2026-11-20.

export type SqlValue = string | number | null

export interface Stmt {
  readonly sql: string
  readonly params: readonly SqlValue[]
}

export const stmt = (sql: string, ...params: SqlValue[]): Stmt => ({ sql, params })

/**
 * A D1 or R2 call that failed (p2-design section 4: 503 `unavailable`). The stores' one boundary to storage throws it,
 * so api.ts can tell a storage failure from a bug in the code (500 `unknown`). `message` names what failed, in fixed text;
 * `cause` keeps the storage error, whose message never goes into this one (P8a P-auth: a D1 or R2 message can name a
 * value, and every log above a store would carry it).
 */
export class StoreUnavailableError extends Error {
  constructor(what: string, cause: unknown) {
    super(`${what} failed`, { cause })
    this.name = 'StoreUnavailableError'
  }
}

/** Runs `call`, turning any failure into a `StoreUnavailableError`. */
export async function storage<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    throw err instanceof StoreUnavailableError ? err : new StoreUnavailableError(what, err)
  }
}

const prepare = (db: D1Database, s: Stmt): D1PreparedStatement => db.prepare(s.sql).bind(...s.params)

/** Runs the statements as one batch (one transaction). Returns each statement's result, in order. */
export async function runBatch(db: D1Database, stmts: readonly Stmt[]): Promise<D1Result[]> {
  return storage('D1', () => db.batch(stmts.map(s => prepare(db, s))))
}

export async function first<T>(db: D1Database, s: Stmt): Promise<T | null> {
  return storage('D1', () => prepare(db, s).first<T>())
}

export async function all<T>(db: D1Database, s: Stmt): Promise<T[]> {
  return storage('D1', async () => (await prepare(db, s).all<T>()).results)
}

/** A value as an SQLite literal. Strings are single-quoted with `'` doubled; a NUL or a non-integer number is refused. */
export function sqlLiteral(v: SqlValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('sqlLiteral: only safe integers')
    return String(v)
  }
  if (v.includes('\0')) throw new Error('sqlLiteral: NUL in a string')
  return `'${v.replaceAll("'", "''")}'`
}

/**
 * A statement as SQL text, each `?` replaced by its parameter's literal. The builders never put a `?` inside a
 * quoted string in their SQL text, so every `?` is a placeholder; the counts must match.
 */
export function renderStmt(s: Stmt): string {
  // Odd segments between single quotes are string literals (a doubled '' splits into an empty even segment).
  if (s.sql.split("'").some((seg, i) => i % 2 === 1 && seg.includes('?'))) throw new Error('renderStmt: a ? inside a quoted string')
  const pieces = s.sql.split('?')
  if (pieces.length - 1 !== s.params.length) throw new Error(`renderStmt: ${pieces.length - 1} placeholders, ${s.params.length} params`)
  return pieces.map((p, i) => (i === 0 ? p : sqlLiteral(s.params[i - 1]) + p)).join('').trim() + ';'
}
