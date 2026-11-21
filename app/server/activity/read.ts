// Reading Activity (route 59): keyset pages newest first over `activity_lines`, with the names of the members the
// lines name (only members who still have one: a pseudonymised member has none, so they render as a former member).
import { all, stmt } from '../db/sql.ts'
import type { LineRow } from './render.ts'

export interface ActivityPageResult {
  rows: LineRow[]
  /** Current names by member id; a member without a name (pseudonymised) or without a row is absent. */
  names: Map<string, string>
  /** The page's last key when more lines follow, else null. */
  last: { atMs: number; n: number } | null
}

export function activityReader({ db }: { db: D1Database }) {
  return {
    /** Lines older than `before` (all when null), newest first, at most `limit`. */
    async page(page: { limit: number; before: { atMs: number; n: number } | null }): Promise<ActivityPageResult> {
      const b = page.before ?? { atMs: Number.MAX_SAFE_INTEGER, n: Number.MAX_SAFE_INTEGER }
      const found = await all<LineRow>(db, stmt(
        `SELECT n, id, at_ms, kind, min_stage, template, fields_json, actor_id, subject_id, trace FROM activity_lines
         WHERE at_ms < ? OR (at_ms = ? AND n < ?) ORDER BY at_ms DESC, n DESC LIMIT ?`,
        b.atMs, b.atMs, b.n, page.limit + 1,
      ))
      const more = found.length > page.limit
      const rows = found.slice(0, page.limit)
      const ids = [...new Set(rows.flatMap(r => [r.actor_id, r.subject_id]).filter((x): x is string => x !== null))]
      const names = new Map<string, string>()
      // D1 binds at most 100 parameters per statement: look the names up in chunks.
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90)
        const got = await all<{ id: string; name: string }>(db, stmt(
          `SELECT id, name FROM members WHERE id IN (${chunk.map(() => '?').join(',')}) AND name IS NOT NULL AND pseudonymised_at_ms IS NULL`, ...chunk,
        ))
        for (const m of got) names.set(m.id, m.name)
      }
      const lastRow = rows[rows.length - 1]
      return { rows, names, last: more && lastRow ? { atMs: lastRow.at_ms, n: lastRow.n } : null }
    },
  }
}
export type ActivityReader = ReturnType<typeof activityReader>
