// The channel list's store (p5-w4.md sections 7 and 10): read the listed channels, and save a whole new list in one
// batch with its audit line. The save is guarded on the rev it was read at: every statement checks the list's rev and
// the rev bump runs last, so a stale save changes nothing and answers `conflict`. Member ids only; no notice text.
import type { AuditArgs } from '../../shared/contract/audit.ts'
import type { NotifyChannelList } from '../../shared/contract/notify-slack.ts'
import { auditInsert } from '../db/audit.ts'
import type { AuditHook } from '../db/audit.ts'
import { writeStamp } from '../db/ids.ts'
import type { At } from '../db/members.ts'
import { all, first, runBatch, stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'

const REV = 'COALESCE((SELECT rev FROM notify_channel_list WHERE id = 1), 0)'

export type ChannelSave = { channels: { channelId: string; name: string }[]; alertsChannelId: string | null; ifRev: number }

export function notifyChannelStore({ db, hook = s => s }: { db: D1Database; hook?: AuditHook }) {
  async function list(): Promise<NotifyChannelList> {
    const rev = (await first<{ rev: number }>(db, stmt(`SELECT ${REV} AS rev`)))!.rev
    const rows = await all<{ channel_id: string; name: string; alerts: number }>(db, stmt(
      'SELECT channel_id, name, alerts FROM notify_channels WHERE removed_at_ms IS NULL ORDER BY lower(name), channel_id',
    ))
    return { rev, channels: rows.map(r => ({ channelId: r.channel_id, name: r.name, alerts: r.alerts === 1 })) }
  }

  return {
    list,
    /** The new list, or `conflict` with the current one when `ifRev` is stale. */
    async save(input: ChannelSave, at: At): Promise<{ ok: NotifyChannelList } | { conflict: NotifyChannelList }> {
      const current = await list()
      if (current.rev !== input.ifRev) return { conflict: current }
      const stamp = writeStamp(at.requestId)
      const before = new Map(current.channels.map(c => [c.channelId, c]))
      const after = new Map(input.channels.map(c => [c.channelId, c]))
      const added = input.channels.filter(c => !before.has(c.channelId))
      const removed = current.channels.filter(c => !after.has(c.channelId))
      const kept = input.channels.filter(c => before.has(c.channelId))
      const guard = `AND ${REV} = ?`
      const stmts: Stmt[] = []
      for (const c of removed) {
        stmts.push(stmt(`UPDATE notify_channels SET removed_by = ?, removed_at_ms = ?, alerts = 0, req_id = ? WHERE channel_id = ? AND removed_at_ms IS NULL ${guard}`,
          at.actorId, at.nowMs, stamp, c.channelId, input.ifRev))
      }
      // Rows losing the alerts mark first, so the one-alerts-channel index never sees two at once.
      const alertsOf = (id: string) => (id === input.alertsChannelId ? 1 : 0)
      for (const c of [...kept].sort((a, b) => alertsOf(a.channelId) - alertsOf(b.channelId))) {
        const a = alertsOf(c.channelId)
        stmts.push(stmt(`UPDATE notify_channels SET name = ?, alerts = ?, req_id = ? WHERE channel_id = ? AND removed_at_ms IS NULL AND (name <> ? OR alerts <> ?) ${guard}`,
          c.name, a, stamp, c.channelId, c.name, a, input.ifRev))
      }
      for (const c of [...added].sort((x, y) => alertsOf(x.channelId) - alertsOf(y.channelId))) {
        stmts.push(stmt(
          `INSERT INTO notify_channels (channel_id, name, alerts, added_by, added_at_ms, removed_by, removed_at_ms, req_id)
           SELECT ?, ?, ?, ?, ?, NULL, NULL, ? WHERE ${REV} = ?
           ON CONFLICT (channel_id) DO UPDATE SET name = excluded.name, alerts = excluded.alerts, added_by = excluded.added_by,
             added_at_ms = excluded.added_at_ms, removed_by = NULL, removed_at_ms = NULL, req_id = excluded.req_id
           WHERE notify_channels.removed_at_ms IS NOT NULL`,
          c.channelId, c.name, alertsOf(c.channelId), at.actorId, at.nowMs, stamp, input.ifRev,
        ))
      }
      const prevAlerts = current.channels.find(c => c.alerts)?.channelId ?? null
      const args: AuditArgs = {
        action: 'notify.channels',
        added: added.map(c => c.channelId),
        removed: removed.map(c => c.channelId),
        ...(prevAlerts !== input.alertsChannelId ? { alerts: input.alertsChannelId } : {}),
      }
      // Written only when a row carries this write's stamp (a save that changed nothing writes no line).
      stmts.push(hook(auditInsert({ atMs: at.nowMs, actorId: at.actorId, args, target: null, requestId: at.requestId }, { table: 'notify_channels', where: '1 = 1', params: [], stamp })))
      stmts.push(stmt(
        `INSERT INTO notify_channel_list (id, rev, updated_at_ms) SELECT 1, ?, ? WHERE ${REV} = ?
         ON CONFLICT (id) DO UPDATE SET rev = excluded.rev, updated_at_ms = excluded.updated_at_ms`,
        input.ifRev + 1, at.nowMs, input.ifRev,
      ))
      const results = await runBatch(db, stmts)
      const bumped = results.at(-1)!.meta.changes === 1
      return bumped ? { ok: await list() } : { conflict: await list() }
    },
  }
}

export type NotifyChannelStore = ReturnType<typeof notifyChannelStore>
