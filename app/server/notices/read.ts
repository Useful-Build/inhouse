// The bell's read side (routes 60 and 61): who sees a notice, the 50 newest with their read state, and marking read.
// Visible to me: audience `team`; `admins` when I'm an Admin; `member` when the notice names me. Inhouse sees none (OC 4:
// the matrix keeps it off these rows). Read state is on the server, so the dot stays cleared after a reload (S5).
import { all, runBatch, stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'

export interface NoticeRow {
  id: string
  audience: 'team' | 'admins' | 'member'
  template: string
  fields_json: string
  body: string | null
  icon: string
  person_id: string | null
  at_ms: number
  waiting: 0 | 1
  link_json: string
  unread: 0 | 1
}

export interface Viewer { id: string; admin: boolean }

/** The visibility rule, as SQL over `notices n`; binds `(admin flag, member id)`. */
const VISIBLE = "(n.audience = 'team' OR (n.audience = 'admins' AND ? = 1) OR (n.audience = 'member' AND n.audience_member_id = ?))"
const visibleArgs = (v: Viewer): [number, string] => [v.admin ? 1 : 0, v.id]

/** D1 binds at most 100 parameters per statement; a read call carries up to 100 ids. */
const IDS_PER_STATEMENT = 90

export function noticeReader({ db }: { db: D1Database }) {
  return {
    /** The 50 newest notices `v` may see, newest first, each with whether `v` hasn't read it, and the names of the members shown. */
    async list(v: Viewer): Promise<{ rows: NoticeRow[]; names: Map<string, string> }> {
      const rows = await all<NoticeRow>(db, stmt(
        `SELECT n.id, n.audience, n.template, n.fields_json, n.body, n.icon, n.person_id, n.at_ms, n.waiting, n.link_json,
                (r.notice_id IS NULL) AS unread
         FROM notices n LEFT JOIN notice_reads r ON r.notice_id = n.id AND r.member_id = ?
         WHERE ${VISIBLE} ORDER BY n.at_ms DESC, n.id DESC LIMIT 50`,
        v.id, ...visibleArgs(v),
      ))
      const ids = [...new Set(rows.map(r => r.person_id).filter((x): x is string => x !== null))]
      const names = new Map<string, string>()
      for (let i = 0; i < ids.length; i += IDS_PER_STATEMENT) {
        const chunk = ids.slice(i, i + IDS_PER_STATEMENT)
        const got = await all<{ id: string; name: string }>(db, stmt(
          `SELECT id, name FROM members WHERE id IN (${chunk.map(() => '?').join(',')}) AND name IS NOT NULL AND pseudonymised_at_ms IS NULL`, ...chunk,
        ))
        for (const m of got) names.set(m.id, m.name)
      }
      return { rows, names }
    },

    /**
     * Marks the ids `v` can see as read (`INSERT OR IGNORE ... SELECT ... WHERE id IN (...) AND <visible>`); the rest are
     * skipped without an error, so the answer never tells a person which ids exist. Reading twice is the same as once.
     */
    async markRead(v: Viewer, ids: readonly string[], atMs: number): Promise<void> {
      const unique = [...new Set(ids)]
      const stmts: Stmt[] = []
      for (let i = 0; i < unique.length; i += IDS_PER_STATEMENT) {
        const chunk = unique.slice(i, i + IDS_PER_STATEMENT)
        stmts.push(stmt(
          `INSERT OR IGNORE INTO notice_reads (member_id, notice_id, at_ms)
           SELECT ?, n.id, ? FROM notices n WHERE n.id IN (${chunk.map(() => '?').join(',')}) AND ${VISIBLE}`,
          v.id, atMs, ...chunk, ...visibleArgs(v),
        ))
      }
      if (stmts.length > 0) await runBatch(db, stmts)
    },
  }
}
export type NoticeReader = ReturnType<typeof noticeReader>
