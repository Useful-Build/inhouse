// Helpers for C1's coverage tests (ops/coverage/chat-watch-connectors/*.test.ts, in the Workers runtime). Never imported
// by the Worker. Rows go in by plain SQL and R2 puts, in any shape a store could leave.
import { PERSON_DATA_TABLES } from '../../../server/do/brand-agent/ports.ts'
import type { PersonDataAnswer, PersonDataTable } from '../../../server/do/brand-agent/ports.ts'
import { chatFileKey, sessionKey } from '../../../server/db/r2-keys.ts'
import type { Snapshot } from '../../delete/test-support.ts'

export interface ChatSpec {
  id: string
  owner: string
  /** Epoch ms of the chat's last activity. */
  lastAtMs: number
  /** Set: the chat is in the trash since then. */
  deletedAtMs?: number
  /** A word in every message, so a search can find this chat's rows. */
  marker: string
  /** Whether its output file is in the Library's trash, and since when. */
  fileMarkedAtMs?: number
}

/** A chat with a user message and an agent answer, a tool call, an output file (row and bytes), a transcript part and the file's Library mark. */
export async function addChat(db: D1Database, bucket: R2Bucket, c: ChatSpec): Promise<{ fileId: string; fileKey: string; sessionKey: string }> {
  const fileId = `f_${c.id}`
  const fileKey = chatFileKey(c.id, fileId)
  const session = sessionKey(c.id, 's1', 'h1', 'm', '0')
  await db.batch([
    db.prepare('INSERT INTO chats (id, owner_id, title, deleted_at_ms, created_at_ms, last_at_ms) VALUES (?, ?, ?, ?, ?, ?)').bind(c.id, c.owner, `Chat ${c.marker}`, c.deletedAtMs ?? null, c.lastAtMs - 1000, c.lastAtMs),
    db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, author_id, text, at_ms) VALUES (?, ?, 'r', 't', 0, 'user', ?, ?, ?)").bind(`${c.id}.u`, c.id, c.owner, `ask ${c.marker}`, c.lastAtMs - 1000),
    db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, author_id, text, at_ms) VALUES (?, ?, 'r', 't', 1, 'agent', NULL, ?, ?)").bind(`${c.id}.a`, c.id, `answer ${c.marker}`, c.lastAtMs),
    db.prepare("INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES (?, 0, ?, ?, 'pre', 'shop.read', 'allow', 2, 'ab', ?)").bind(`t_${c.id}`, c.id, c.owner, c.lastAtMs),
    db.prepare("INSERT INTO chat_files (id, chat_id, kind, path, name, content_type, bytes, sha256, r2_key, state, created_by, created_at_ms) VALUES (?, ?, 'output', ?, 'out.txt', 'text/plain', 5, 'ab', ?, 'saved', NULL, ?)").bind(fileId, c.id, `/out/${c.id}.txt`, fileKey, c.lastAtMs),
    db.prepare("INSERT INTO library_marks (file_id, source, deleted_at_ms, deleted_by) VALUES (?, 'chat', ?, ?)").bind(fileId, c.fileMarkedAtMs ?? null, c.fileMarkedAtMs === undefined ? null : c.owner),
  ])
  await bucket.put(fileKey, `bytes ${c.marker}`, { httpMetadata: { contentType: 'text/plain' } })
  await bucket.put(session, `transcript ${c.marker}`, { httpMetadata: { contentType: 'application/json' } })
  return { fileId, fileKey, sessionKey: session }
}

export async function addMemory(db: D1Database, m: { id: string; owner: string | null; createdBy: string; marker: string; status?: 'active' | 'waiting' | 'forgotten'; updatedAtMs: number }): Promise<void> {
  await db.prepare('INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(m.id, m.owner === null ? 'brand' : 'person', m.owner, `fact ${m.marker}`, m.status ?? 'active', m.createdBy, m.updatedAtMs, m.updatedAtMs).run()
}

export async function addNotice(db: D1Database, n: { id: string; audience: 'team' | 'admins' | 'member'; member?: string; person?: string; atMs: number }): Promise<void> {
  await db.prepare("INSERT INTO notices (id, audience, audience_member_id, template, fields_json, body, icon, person_id, at_ms, link_json, source) VALUES (?, ?, ?, 't', '{}', 'body text', 'bell', ?, ?, '{}', 'test')")
    .bind(n.id, n.audience, n.member ?? null, n.person ?? null, n.atMs).run()
}

export async function addRead(db: D1Database, member: string, notice: string, atMs: number): Promise<void> {
  await db.prepare('INSERT INTO notice_reads (member_id, notice_id, at_ms) VALUES (?, ?, ?)').bind(member, notice, atMs).run()
}

export async function addActivity(db: D1Database, a: { id: string; actor: string | null; subject: string | null; atMs: number }): Promise<void> {
  await db.prepare("INSERT INTO activity_lines (id, at_ms, kind, template, fields_json, actor_id, subject_id, source, source_key) VALUES (?, ?, 'change', 't', '{}', ?, ?, 'test', ?)")
    .bind(a.id, a.atMs, a.actor, a.subject, a.id).run()
}

/**
 * A BrandAgent stand-in for `personData`: per-person row counts per table, deleted to zero by `delete`, `busy` for the
 * people in `busy`. It keeps every call. The real object's own rules are P3's (its tests); this only plays them back.
 */
export function agentDouble(rows: Record<string, Partial<Record<PersonDataTable, number>>>) {
  const busy = new Set<string>()
  const calls: { personId: string; mode: 'count' | 'delete' }[] = []
  const countsOf = (id: string) => Object.fromEntries(PERSON_DATA_TABLES.map(t => [t, rows[id]?.[t] ?? 0])) as Record<PersonDataTable, number>
  return {
    busy,
    calls,
    rows,
    async personData(p: { personId: string; mode: 'count' | 'delete' }): Promise<PersonDataAnswer> {
      calls.push(p)
      if (p.mode === 'delete' && busy.has(p.personId)) return { busy: true }
      const counts = countsOf(p.personId)
      if (p.mode === 'delete') rows[p.personId] = {}
      return { counts }
    },
  }
}

/** A snapshot without the search indexes' own tables (they follow their sources by trigger; checked by search instead). */
export const withoutIndexes = (s: Snapshot): Snapshot => ({ d1: Object.fromEntries(Object.entries(s.d1).filter(([t]) => !t.includes('_fts'))), r2: s.r2 })
