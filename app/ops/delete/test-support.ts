// Helpers for P8 G2's job tests (ops/{delete,retention,export}/**/*.test.ts, in the Workers runtime). Never imported by
// the Worker. Data goes in by plain SQL and R2 puts (faster than the stores, and any shape a store could leave); the
// audit log can't be emptied (its triggers), so tests compare whole snapshots of every table and object instead.
import { photoKey } from '../../server/db/r2-keys.ts'

export interface Snapshot {
  d1: Record<string, Record<string, unknown>[]>
  r2: Record<string, { contentType: string | null; base64: string }>
}

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('')
export const token = (): string => hex(6)

const b64 = (bytes: Uint8Array) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** Every user table's rows (D1's own and SQLite's aside), each table ordered by every column, and every R2 object. */
export async function snapshotAll(db: D1Database, bucket: R2Bucket): Promise<Snapshot> {
  const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()).results
  const d1: Snapshot['d1'] = {}
  for (const { name } of names) {
    const cols = (await db.prepare(`PRAGMA table_info(${name})`).all<{ cid: number }>()).results
    d1[name] = (await db.prepare(`SELECT * FROM ${name} ORDER BY ${cols.map(c => c.cid + 1).join(', ')}`).all<Record<string, unknown>>()).results
  }
  const r2: Snapshot['r2'] = {}
  let cursor: string | undefined
  for (;;) {
    const page = await bucket.list({ cursor, include: ['httpMetadata'] })
    for (const o of page.objects) {
      const body = await bucket.get(o.key)
      if (!body) throw new Error(`snapshot: ${o.key} vanished`)
      r2[o.key] = { contentType: body.httpMetadata?.contentType ?? null, base64: b64(new Uint8Array(await body.arrayBuffer())) }
    }
    if (!page.truncated) break
    cursor = page.cursor
  }
  return { d1, r2 }
}

/** A `D1Database` that records the SQL of every statement prepared on it (and every `exec`), then runs it as is. */
export function recordingDb(db: D1Database): { db: D1Database; sql: string[] } {
  const sql: string[] = []
  const wrapped = {
    prepare(query: string) {
      sql.push(query)
      return db.prepare(query)
    },
    batch: (stmts: D1PreparedStatement[]) => db.batch(stmts),
    exec(query: string) {
      sql.push(query)
      return db.exec(query)
    },
    dump: () => { throw new Error('recordingDb: dump') },
    withSession: () => { throw new Error('recordingDb: withSession') },
  }
  return { db: wrapped as unknown as D1Database, sql }
}

/** Any statement that writes the audit log (anything naming it that isn't a SELECT). */
export const writesAudit = (sql: string): boolean => /audit_log/i.test(sql) && !/^\s*SELECT\b/i.test(sql) && !/^\s*PRAGMA\s+table_info/i.test(sql)

export interface PersonSpec {
  role: 'member' | 'admin'
  status: 'invited' | 'active' | 'removed'
}

/** A person row with a unique name, email, title and subject. Returns the id and those values. */
export async function addPerson(db: D1Database, spec: PersonSpec, invitedBy: string, nowMs: number) {
  const t = token()
  const p = { id: `m_t${t}`, name: `Name${t}`, email: `mail${t}@example.test`, title: `Title${t}`, subject: spec.status === 'invited' ? null : `sub-${t}` }
  await db.prepare(
    `INSERT INTO members (id, kind, role, status, name, title, email_norm, subject, created_at_ms, invited_by, removed_at_ms, req_id)
     VALUES (?, 'person', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(p.id, spec.role, spec.status, p.name, p.title, p.email, p.subject, nowMs, invitedBy, spec.status === 'removed' ? nowMs : null, `req-${t}`).run()
  return p
}

/** A photo object under the member's prefix, with bytes that hold a unique marker. Points the row at the latest. */
export async function addPhoto(db: D1Database, bucket: R2Bucket, memberId: string): Promise<{ key: string; marker: string }> {
  const marker = `PHOTO${token()}`
  const key = photoKey(memberId, token())
  await bucket.put(key, new TextEncoder().encode(marker), { httpMetadata: { contentType: 'image/png' } })
  await db.prepare('UPDATE members SET photo_key = ? WHERE id = ?').bind(key, memberId).run()
  return { key, marker }
}

export async function addSetting(db: D1Database, owner: string, value: unknown, updatedBy: string, nowMs: number): Promise<void> {
  await db.prepare('INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES (?, ?, ?, 1, ?, ?, ?)')
    .bind(owner, `k:${token()}`, JSON.stringify(value), nowMs, updatedBy, `req-${token()}`).run()
}

export async function addGrant(db: D1Database, createdBy: string, endedBy: string | null, nowMs: number): Promise<void> {
  await db.prepare('INSERT INTO support_grants (id, created_by, created_at_ms, ends_at_ms, ended_at_ms, ended_by, req_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(`g_${token()}`, createdBy, nowMs, nowMs + 3_600_000, endedBy === null ? null : nowMs + 1, endedBy, `req-${token()}`).run()
}

export async function addLine(db: D1Database, actorId: string, targetId: string | null, args: Record<string, unknown>, nowMs: number): Promise<void> {
  await db.prepare('INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(nowMs, actorId, 'test.line', targetId === null ? null : 'member', targetId, JSON.stringify(args), `req-${token()}`).run()
}

/** An export stream, read whole and split into its parsed lines. */
export async function readLines(stream: ReadableStream<Uint8Array>): Promise<{ text: string; lines: Record<string, unknown>[] }> {
  const text = await new Response(stream).text()
  if (!text.endsWith('\n')) throw new Error('export: the stream does not end with a newline')
  return { text, lines: text.slice(0, -1).split('\n').map(l => JSON.parse(l) as Record<string, unknown>) }
}

/** The snapshot without the deletion log (a run adds its own entries; everything else must match). */
export const withoutLog = (s: Snapshot): Snapshot => ({ d1: s.d1, r2: Object.fromEntries(Object.entries(s.r2).filter(([k]) => !k.startsWith('deletion-log/'))) })
