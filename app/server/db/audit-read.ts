// Reading the audit log (p2-design section 8, routes 19 and 20): keyset pages newest first, each line with its actor's
// current name ("Former member" once pseudonymised) and the current names of the members its arguments name. The text
// of a line (`what`, `detail`) is app/shared/audit-text.ts's, composed by the handler from what this returns.
import { AuditArgsSchema } from '../../shared/contract/audit.ts'
import type { AuditArgs } from '../../shared/contract/audit.ts'
import { MemberIdSchema } from '../../shared/contract/members.ts'
import { FORMER_MEMBER } from './members.ts'
import { all, stmt } from './sql.ts'

/** One stored line, its arguments parsed back. */
export interface StoredLine {
  id: number
  atMs: number
  actorId: string
  who: string
  args: AuditArgs
}

interface LineRow {
  id: number
  at_ms: number
  actor_id: string
  action: string
  args_json: string
  actor_name: string | null
}

/** The member ids a line's arguments name (a member, an earlier identity, an approver's value). */
export function memberIdsIn(args: AuditArgs): string[] {
  const ids: string[] = []
  if ('memberId' in args) ids.push(args.memberId)
  if ('replaces' in args && args.replaces) ids.push(args.replaces)
  if (args.action === 'setting.changed' && typeof args.value === 'string' && MemberIdSchema.safeParse(args.value).success) ids.push(args.value)
  return ids
}

export function auditReader({ db }: { db: D1Database }) {
  return {
    /**
     * Lines with `id < beforeId` (all when null), newest first, at most `limit`; `names` holds the current name of every
     * member the lines' arguments name. `lastId` is the page's last id when more lines follow, else null.
     */
    async page(page: { limit: number; beforeId: number | null }): Promise<{ lines: StoredLine[]; names: Record<string, string>; lastId: number | null }> {
      const rows = await all<LineRow>(db, stmt(
        `SELECT a.id, a.at_ms, a.actor_id, a.action, a.args_json, m.name AS actor_name
         FROM audit_log a JOIN members m ON m.id = a.actor_id
         WHERE a.id < ? ORDER BY a.id DESC LIMIT ?`,
        page.beforeId ?? Number.MAX_SAFE_INTEGER, page.limit + 1,
      ))
      const more = rows.length > page.limit
      // A stored line always parses: the writer checked it against the same schema (fail loud if one doesn't).
      const lines = rows.slice(0, page.limit).map(r => ({
        id: r.id, atMs: r.at_ms, actorId: r.actor_id, who: r.actor_name ?? FORMER_MEMBER,
        args: AuditArgsSchema.parse({ action: r.action, ...(JSON.parse(r.args_json) as object) }),
      }))
      const ids = [...new Set(lines.flatMap(l => memberIdsIn(l.args)))]
      const names: Record<string, string> = {}
      // D1 binds at most 100 parameters per statement: look the names up in chunks.
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90)
        const found = await all<{ id: string; name: string | null }>(db, stmt(`SELECT id, name FROM members WHERE id IN (${chunk.map(() => '?').join(', ')})`, ...chunk))
        for (const m of found) names[m.id] = m.name ?? FORMER_MEMBER
      }
      return { lines, names, lastId: more ? lines[lines.length - 1].id : null }
    },
  }
}

export type AuditReader = ReturnType<typeof auditReader>
