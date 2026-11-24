// Helpers for the backup and restore tests (ops/backup/*.test.ts, in the Workers runtime). Never imported by a job.
import fc from 'fast-check'

/**
 * The P2 and P5 fixture tables with their primary keys, written out here rather than read from tables.ts: the oracle the round
 * trip compares with must not share the rules it checks.
 */
const ORACLE_TABLES: readonly [string, string][] = [
  ['members', 'id'], ['settings', 'owner, key'], ['support_grants', 'id'], ['audit_log', 'id'],
  ['connector_accounts', 'account_id'], ['notify_channels', 'channel_id'], ['notify_channel_list', 'id'], ['notify_sends', 'id'],
]

/** Invented P5 rows with member attribution and one send on each side of the retention boundary. */
export async function seedNotificationBackupRows(db: D1Database, memberId: string, atMs: number, oldAtMs: number): Promise<void> {
  const send = db.prepare(`INSERT INTO notify_sends
    (id, source, run_id, actor_id, kind, target, day, notice_sha256, outcome, at_ms)
    VALUES (?, 'agent', 'r_backup', ?, 'bell', ?, ?, ?, 'posted', ?)`)
  await db.batch([
    db.prepare(`INSERT INTO connector_accounts
      (account_id, connector, last_state, last_state_at_ms, connected_by, connected_at_ms)
      VALUES ('slack:backup', 'slack', 'connected', ?, ?, ?)`).bind(atMs, memberId, atMs),
    db.prepare(`INSERT INTO notify_channels (channel_id, name, added_by, added_at_ms)
      VALUES ('Cbackup', 'Backup notices', ?, ?)`).bind(memberId, atMs),
    db.prepare('INSERT INTO notify_channel_list (id, rev, updated_at_ms) VALUES (1, 2, ?)').bind(atMs),
    ...([['n_old', oldAtMs], ['n_keep', atMs]] as const).map(([id, timestamp]) =>
      send.bind(id, memberId, memberId, new Date(timestamp).toISOString().slice(0, 10), id, timestamp)),
  ])
}

/** Every fixture table, every column, in primary-key order: what a restore must reproduce. */
export async function dumpCanonical(db: D1Database): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const [name, orderBy] of ORACLE_TABLES) out[name] = (await db.prepare(`SELECT * FROM ${name} ORDER BY ${orderBy}`).all()).results
  return out
}

/** A D1Database that records every SQL text it's handed (prepare and exec), for the audit-table guard. */
export function recordingDb(db: D1Database, log: string[]): D1Database {
  return {
    prepare: (query: string) => { log.push(query); return db.prepare(query) },
    batch: (stmts: D1PreparedStatement[]) => db.batch(stmts),
    exec: (query: string) => { log.push(query); return db.exec(query) },
  } as unknown as D1Database
}

/** A D1Database whose every call fails, as a readable database whose read breaks mid-snapshot. */
export const failingDb = (): D1Database => ({
  prepare: () => { throw new Error('D1 is down (test)') },
  batch: () => Promise.reject(new Error('D1 is down (test)')),
  exec: () => Promise.reject(new Error('D1 is down (test)')),
}) as unknown as D1Database

/** What the restore must never send to the audit table (its triggers would refuse it anyway). */
export const FORBIDDEN_SQL = /UPDATE\s+"?audit_log\b|DELETE\s+FROM\s+"?audit_log\b|OR\s+REPLACE|\bREPLACE\s+INTO\b/i

/** Strings that break naive encoders: quotes, separators, escapes, JSON look-alikes, astral characters. */
const tricky = fc.constantFrom('', "'", '"', '\n', '\r\n', '\\', '\\n', '\u2028', '\u2029', '\u{1F600}', '\u00e9', '$[0]', '{"a":1}', '[1,2]', '123', 'null', '\t', '\u00a0', '\ufeff', '\u0000')
export const textArb = fc.oneof(tricky, fc.string({ unit: 'binary', maxLength: 40 }), fc.string({ maxLength: 40 }))
export const intArb = fc.oneof(fc.constantFrom(0, -1, 1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER), fc.maxSafeInteger(), fc.integer())

export interface Generated {
  members: Record<string, string | number | null>[]
  settings: Record<string, string | number | null>[]
  grants: Record<string, string | number | null>[]
  audit: Record<string, string | number | null>[]
}

/** Rows for every canonical table: members (some pseudonymised, some with a photo key), settings, grants, audit lines. */
export function generatedArb(existingMembers: readonly string[]): fc.Arbitrary<Generated> {
  const memberArb = fc.record({
    name: fc.option(textArb, { nil: null }), title: fc.option(textArb, { nil: null }), pseudonymised: fc.boolean(),
    photo: fc.boolean(), id: fc.stringMatching(/^[A-Za-z0-9_-]{22}$/), role: fc.constantFrom('member', 'admin'), created: fc.nat({ max: 2_000_000_000_000 }), reqId: fc.option(textArb, { nil: null }),
  })
  return fc.uniqueArray(memberArb, { selector: m => m.id, minLength: 3, maxLength: 25 }).chain(ms => {
    const members = ms.map((m, i) => {
      const id = `m_${m.id}`
      return {
        id, kind: 'person', role: m.role, status: m.pseudonymised ? 'removed' : 'invited',
        name: m.pseudonymised ? null : m.name, title: m.pseudonymised ? null : m.title,
        email_norm: m.pseudonymised ? null : `gen-${i}-${id.slice(2, 8).toLowerCase()}@example.test`,
        subject: m.pseudonymised ? `hashed-${id}` : null, service_name: null,
        photo_key: m.photo ? `photos/${id}/p${i}` : null, rev: 1 + (i % 4), created_at_ms: m.created,
        invited_by: 'm_system', removed_at_ms: m.pseudonymised ? m.created + 1 : null,
        pseudonymised_at_ms: m.pseudonymised ? m.created + 2 : null, req_id: m.reqId,
      }
    })
    const ids = [...existingMembers, ...members.map(m => m.id)]
    const who = fc.constantFrom(...ids)
    const settings = fc.uniqueArray(fc.record({
      owner: fc.oneof(fc.constant('brand'), who), key: fc.oneof(textArb, fc.string({ minLength: 1, maxLength: 20 })),
      value: fc.jsonValue({ maxDepth: 3 }), rev: fc.integer({ min: 1, max: 1_000_000 }), at: fc.nat(), by: who, req: textArb,
    }), { selector: s => JSON.stringify([s.owner, s.key]), maxLength: 40 })
      .map(ss => ss.map(s => ({ owner: s.owner, key: s.key, value_json: JSON.stringify(s.value) ?? 'null', rev: s.rev, updated_at_ms: s.at, updated_by: s.by, req_id: s.req })))
    const grants = fc.uniqueArray(fc.record({ id: fc.stringMatching(/^[A-Za-z0-9_-]{22}$/), by: who, created: fc.nat({ max: 1_900_000_000_000 }), span: fc.integer({ min: 1, max: 1_000_000_000 }), ended: fc.boolean(), req: fc.option(textArb, { nil: null }) }), { selector: g => g.id, maxLength: 15 })
      .map(gs => gs.map(g => ({
        id: `g_${g.id}`, created_by: g.by, created_at_ms: g.created, ends_at_ms: g.created + g.span,
        ended_at_ms: g.ended ? g.created + 1 : null, ended_by: g.ended ? g.by : null, expiry_logged: g.ended ? 1 : 0, rev: 1, req_id: g.req,
      })))
    // More than one read page's worth of lines (5,000 a page, so 6 parts of 1,000), each a line the audit reader parses.
    const audit = fc.array(fc.record({ actor: who, target: who, role: fc.constantFrom('member', 'admin'), at: fc.nat(), req: textArb }), { minLength: 5_001, maxLength: 5_400 })
      .map(ls => ls.map(l => ({
        at_ms: l.at, actor_id: l.actor, action: 'member.invited', target_kind: 'member', target_id: l.target,
        args_json: JSON.stringify({ memberId: l.target, role: l.role }), req_id: l.req,
      })))
    return fc.record({ members: fc.constant(members), settings, grants, audit })
  })
}

/** Inserts rows with one statement per table (a bound JSON array of objects), as plain SQL a test is allowed to send. */
export async function insertRows(db: D1Database, table: string, rows: readonly Record<string, string | number | null>[]): Promise<void> {
  if (rows.length === 0) return
  const cols = Object.keys(rows[0])
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    await db.prepare(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) SELECT ${cols.map(c => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?)`)
      .bind(JSON.stringify(chunk)).run()
  }
}

/**
 * A seed for `fc.sample`. The Workers pool doesn't show a passing test's console, so the caller puts it in the test's
 * title, where a failing run prints it; `ROUND_TRIP_SEED` in the test file replays one.
 */
export const testSeed = (): number => (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0

/** A registry entry for a derived FTS5 table the test creates, built from `settings`. */
export const derivedEntry = (name: string) => ({ kind: 'd1' as const, name, retention: 'config' as const, personKeys: [], export: false, derived: { from: ['settings'] } })
