// Settings (p2-design sections 5 and 6): rows keyed by (owner, key), owner a member id (personal) or 'brand' (brand and
// technical). A write is guarded by `rev` in the statement (ifRev 0: the row must not exist yet); rows are never
// deleted, so a reset stores null and still counts `rev` up. `g:name` lives on the member row (members.ts `rename`).
import { DEFAULT_DAYS } from '../../ops/retention/rules.ts'
import { settingSpec } from '../../shared/contract/settings.ts'
import type { SettingRecord, SettingScope, SettingValue } from '../../shared/contract/settings.ts'
import { RETENTION } from '../../shared/contract/settings-table.ts'
import type { AuditArgs } from '../../shared/contract/audit.ts'
import { auditInsert, redact } from './audit.ts'
import type { AuditHook } from './audit.ts'
import { writeStamp } from './ids.ts'
import type { At, MemberStore, Outcome } from './members.ts'
import { all, first, runBatch, stmt } from './sql.ts'
import type { Stmt } from './sql.ts'

/** The owner of every brand and technical setting. */
export const BRAND_OWNER = 'brand'

export const SETTING_DAYS = {
  '3 months': 90,
  '6 months': 180,
  '12 months': DEFAULT_DAYS.chats,
  '24 months': 730,
  'Until deleted': null,
} satisfies Record<(typeof RETENTION)[number], number | null>

export function retentionDaysOf(key: 'd:chats' | 'd:steps', value: unknown): number | null {
  if (value === null) return DEFAULT_DAYS[key === 'd:chats' ? 'chats' : 'steps']
  const choice = RETENTION.find(option => option === value)
  if (choice === undefined) throw new Error(`retention: invalid ${key} setting`)
  return SETTING_DAYS[choice]
}

const isRetentionKey = (key: string): key is 'd:chats' | 'd:steps' => key === 'd:chats' || key === 'd:steps'

interface SettingRow {
  owner: string
  key: string
  value_json: string
  rev: number
  updated_at_ms: number
  updated_by: string
  shortened_at_ms: number | null
}

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })

const record = (r: SettingRow): SettingRecord => ({
  key: r.key,
  value: JSON.parse(r.value_json) as SettingValue | null,
  rev: r.rev,
  updatedAt: instant(r.updated_at_ms),
  updatedBy: r.updated_by,
})

/** A key never set: no value, rev 0. */
const unset = (key: string): SettingRecord => ({ key, value: null, rev: 0, updatedAt: null, updatedBy: null })

export interface SettingWrite {
  /** A member id (personal) or 'brand'. */
  owner: string
  scope: SettingScope
  key: string
  /** Already parsed by the key's spec (or null, a reset). */
  value: SettingValue | null
  ifRev: number
}

export interface SettingStoreDeps {
  db: D1Database
  hashKey: string
  members: MemberStore
  hook?: AuditHook
}

export function settingStore({ db, hashKey, members, hook = s => s }: SettingStoreDeps) {
  const write = (stmts: Stmt[]) => runBatch(db, stmts.map(s => (s.sql.startsWith('INSERT INTO audit_log') ? hook(s) : s)))
  const read = (owner: string, key: string) => first<SettingRow>(db, stmt('SELECT * FROM settings WHERE owner = ? AND key = ?', owner, key))

  /** The line's arguments: the value as it is for an audit-safe key or a reset, else its length and hash. */
  const lineArgs = async (scope: SettingScope, key: string, value: SettingValue | null): Promise<AuditArgs> => {
    const spec = settingSpec(key)
    if (!spec) throw new Error('lineArgs: not a setting')
    if (value === null || spec.auditSafe) return { action: 'setting.changed', scope, key, value }
    return { action: 'setting.changed', scope, key, redacted: await redact(hashKey, typeof value === 'string' ? value : JSON.stringify(value)) }
  }

  const nameRecord = (r: { name: string | null; rev: number }): SettingRecord => ({ key: 'g:name', value: r.name, rev: r.rev, updatedAt: null, updatedBy: null })

  return {
    /** Every setting of `scope` that has been written for `owner` (personal: plus `g:name` from the member row). */
    async list(owner: string, scope: SettingScope): Promise<SettingRecord[]> {
      const rows = await all<SettingRow>(db, stmt('SELECT * FROM settings WHERE owner = ? ORDER BY key', owner))
      const items = rows.filter(r => settingSpec(r.key)?.scope === scope).map(record)
      if (scope === 'personal') {
        const m = await members.row(owner)
        if (m) items.unshift(nameRecord(m))
      }
      return items
    },

    /**
     * One setting's write and its `setting.changed` line, in one batch. `a:<n>` with a member id also needs that id to
     * be an open person row, in the same statement (`bad_approver` otherwise).
     */
    async write(w: SettingWrite, at: At): Promise<Outcome<SettingRecord, 'bad_approver' | 'not_found'>> {
      if (w.key === 'g:name') {
        if (typeof w.value !== 'string') throw new Error('g:name takes a name')
        const done = await members.rename({ id: w.owner, name: w.value, ifRev: w.ifRev, audit: await redact(hashKey, w.value) }, at)
        if ('refused' in done) return done
        return 'ok' in done ? { ok: nameRecord(done.ok) } : { conflict: nameRecord(done.conflict) }
      }
      const approver = /^a:/.test(w.key) && typeof w.value === 'string' && w.value !== 'anyone' ? w.value : null
      const approverGuard = approver === null ? '' : " AND EXISTS (SELECT 1 FROM members WHERE id = ? AND kind = 'person' AND status IN ('invited', 'active'))"
      const approverParams = approver === null ? [] : [approver]
      let shortened = false
      if (w.owner === BRAND_OWNER && isRetentionKey(w.key)) {
        const group = w.key === 'd:chats' ? 'chats' : 'steps'
        const newDays = retentionDaysOf(w.key, w.value)
        if (w.ifRev === 0) {
          shortened = (newDays ?? Infinity) < DEFAULT_DAYS[group]
        } else {
          const prev = await read(w.owner, w.key)
          if (!prev || prev.rev !== w.ifRev) return { conflict: prev ? record(prev) : unset(w.key) }
          const oldDays = retentionDaysOf(w.key, JSON.parse(prev.value_json))
          shortened = (newDays ?? Infinity) < (oldDays ?? Infinity)
        }
      }
      const stamp = writeStamp(at.requestId)
      const json = JSON.stringify(w.value)
      const change = w.ifRev === 0
        ? stmt(
          `INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id, shortened_at_ms)
           SELECT ?, ?, ?, 1, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM settings WHERE owner = ? AND key = ?)${approverGuard}`,
          w.owner, w.key, json, at.nowMs, at.actorId, stamp, shortened ? at.nowMs : null, w.owner, w.key, ...approverParams,
        )
        : stmt(
          `UPDATE settings SET value_json = ?, rev = rev + 1, updated_at_ms = ?, updated_by = ?, req_id = ?,
             shortened_at_ms = CASE WHEN ? = 1 THEN ? ELSE shortened_at_ms END
           WHERE owner = ? AND key = ? AND rev = ?${approverGuard}`,
          json, at.nowMs, at.actorId, stamp, shortened ? 1 : 0, shortened ? at.nowMs : null, w.owner, w.key, w.ifRev, ...approverParams,
        )
      const line = auditInsert(
        { atMs: at.nowMs, actorId: at.actorId, args: await lineArgs(w.scope, w.key, w.value), target: { kind: 'setting', id: w.key }, requestId: at.requestId },
        { table: 'settings', where: 'owner = ? AND key = ?', params: [w.owner, w.key], stamp },
      )
      const [result] = await write([change, line])
      const now = await read(w.owner, w.key)
      if (result.meta.changes > 0 && now) return { ok: record(now) }
      const current = now ? record(now) : unset(w.key)
      if (current.rev !== w.ifRev) return { conflict: current }
      return { refused: 'bad_approver' }
    },
  }
}

export type SettingStore = ReturnType<typeof settingStore>
