// Helpers for the data layer's and the handlers' tests (server/**/*.test.ts, in the Workers runtime). Never imported by
// the Worker. The audit log can't be emptied (its triggers), so tests reset everything else and count lines by delta.
import type { RequireObject } from '../auth/matrix.ts'
import type { Principal } from '../auth/principal.ts'
import type { ApiCtx } from './handler-kit.ts'
import type { At } from './members.ts'
import { SYSTEM_MEMBER_ID } from './ids.ts'
import type { Stores } from './stores.ts'
import type { Stmt } from './sql.ts'

/** Every person removed, every setting and grant gone. Member rows stay (the audit log names them). */
export async function reset(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("UPDATE members SET status = 'removed' WHERE kind = 'person' AND status <> 'removed'"),
    db.prepare('DELETE FROM settings'),
    db.prepare('DELETE FROM support_grants'),
  ])
}

export interface LineRow {
  id: number
  at_ms: number
  actor_id: string
  action: string
  target_kind: string | null
  target_id: string | null
  args_json: string
  req_id: string
}

export const lastLineId = async (db: D1Database): Promise<number> => (await db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').first<number>('n')) ?? 0

export const linesSince = async (db: D1Database, id: number): Promise<LineRow[]> =>
  (await db.prepare('SELECT * FROM audit_log WHERE id > ? ORDER BY id').bind(id).all<LineRow>()).results

/** Everything a write can change, as rows, to compare before and after. */
export async function snapshot(db: D1Database): Promise<unknown[]> {
  const out: unknown[] = []
  for (const t of ['members', 'settings', 'support_grants', 'audit_log']) out.push((await db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).results)
  return out
}

/** The audit hook that breaks every audit insert: the batch must fail and take the change with it. */
export const brokenAudit = (s: Stmt): Stmt => ({ sql: s.sql.replace('INSERT INTO audit_log', 'INSERT INTO audit_log_missing'), params: s.params })

let n = 0
/** A unique request id for one test call. */
export const reqId = (): string => `req-${++n}-${Math.random().toString(16).slice(2, 8)}`

export const at = (actorId: string, nowMs = 1_800_000_000_000): At => ({ actorId, requestId: reqId(), nowMs })

/** A person: invited by the system row, then bound by signing in as `subject`. Returns its member id. */
export async function person(stores: Stores, opts: { email: string; subject: string; role: 'member' | 'admin'; name?: string }): Promise<string> {
  const invited = await stores.members.invite({ name: opts.name ?? 'Pat Example', email: opts.email, role: opts.role }, at(SYSTEM_MEMBER_ID))
  if ('refused' in invited) throw new Error(`person: ${invited.refused}`)
  const signed = await stores.members.resolvePerson({ subject: opts.subject, email: opts.email, requestId: reqId(), nowMs: 1_800_000_000_000 })
  if (!('ok' in signed)) throw new Error(`person: ${signed.refused}`)
  return signed.ok.memberId
}

export const personPrincipal = (memberId: string, role: 'member' | 'admin'): Principal => ({ kind: 'person', memberId, role, subject: `sub-${memberId}`, requestId: reqId() })

/**
 * A handler's context. `requireObject` records each object and applies the owner rule (a `personal` row): enough to
 * prove a handler calls it with the right object before it writes; the matrix's own tests cover the rule itself.
 */
export function ctx(stores: Stores, principal: Principal, init: { method?: string; path: string; body?: unknown; params?: Record<string, string>; nowMs?: number }) {
  const objects: Parameters<RequireObject>[0][] = []
  const requireObject: RequireObject = object => {
    objects.push(object)
    const self = principal.kind === 'service' && principal.name === 'monitor' ? null : principal.memberId
    if (object.ownerId !== undefined && object.ownerId !== self) throw new Error('refused: not_owner')
  }
  const c: ApiCtx = {
    request: new Request(`http://brand.localhost:8787${init.path}`, {
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
    }),
    principal,
    params: init.params ?? {},
    requestId: principal.requestId,
    nowMs: init.nowMs ?? 1_800_000_000_000,
    stores,
    access: { requireObject },
  }
  return { c, objects }
}
