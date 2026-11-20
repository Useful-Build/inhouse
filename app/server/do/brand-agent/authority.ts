// The BrandAgent's authority tasks (p3-design 4.10, 4.11): the `authority-sweep` reconciliation and the
// `grant-expiry:<grantId>` task. The object keeps a removed-member set and an ended-grant set (`authority`); P2's
// `removeMember` and `endGrant` tell it at once (`onMemberRemoved`, `onGrantEnded`), and the sweep reads D1 every
// 5 minutes while any socket or unfinished turn exists, so a lost call is repaired within 5 minutes (the lease bounds
// the rest). Both are idempotent by task id: each run reads D1 as it is and applies only what the sets lack.
//
// Settled here (each in the PR body):
// - `ensureSeeds()` is synchronous and can't read D1, so it ensures the sweep at once and the sweep's first run seeds
//   `grant-expiry` for every live grant (`ensure`: an existing task keeps its time).
// - The sweep reads from its cursor less 15 minutes (a removal committed while the last sweep's read was in flight is
//   seen by the next one); ids already in a set are skipped, so the overlap changes nothing twice.
// - A re-invited member keeps their member id (P2's `reinvite`): the sweep takes an id out of the removed set once D1
//   no longer says `removed`, but only a set row older than the sweep's read (a removal during the read stays).
import type { Scheduler, TaskResult } from './scheduler.ts'

export const SWEEP_ID = 'authority-sweep'
export const SWEEP_EVERY_MS = 5 * 60_000
export const SWEEP_OVERLAP_MS = 15 * 60_000
export const GRANT_EXPIRY_PREFIX = 'grant-expiry:'
const CURSOR_FLAG = 'authority_cursor_ms'

/**
 * Makes the sweep run by `atMs` (moves a ready one earlier, never later). A quarantined sweep (10 failures, D1 down) is
 * revived here, by the next submit, upgrade or attach: authority must not stop for good.
 */
export function sweepBy(sql: SqlStorage, scheduler: Scheduler, atMs: number) {
  const row = sql.exec<{ due_at_ms: number; state: string }>('SELECT due_at_ms, state FROM due_tasks WHERE id = ?', SWEEP_ID).toArray()[0]
  if (row && row.state === 'ready' && row.due_at_ms <= atMs) return
  scheduler.schedule({ id: SWEEP_ID, kind: 'authority-sweep', dueAtMs: atMs })
}

/** The sockets' side of authority (sockets.ts `SocketHub`). */
export interface SocketAuthority {
  closeMember(memberId: string): void
  closeGrant(grantId: string): void
  sweep(): { open: number; nextLeaseEndMs: number | null }
}

export interface AuthorityDeps {
  sql: SqlStorage
  db: D1Database
  scheduler: Scheduler
  now: () => number
  sockets: SocketAuthority | undefined
  onMemberRemoved(memberId: string): void
  onGrantEnded(grantId: string): void
}

/** `grant-expiry:<grantId>` at the grant's end; `ensure`, so a repeat changes nothing. */
export function ensureGrantExpiry(scheduler: Scheduler, grantId: string, endsAtMs: number) {
  scheduler.ensure({ id: `${GRANT_EXPIRY_PREFIX}${grantId}`, kind: 'grant-expiry', dueAtMs: endsAtMs })
}

const ids = (sql: SqlStorage, kind: 'member' | 'grant') =>
  new Set(sql.exec<{ id: string }>('SELECT id FROM authority WHERE kind = ?', kind).toArray().map(r => r.id))

/** One `authority-sweep` run. D1 failing throws: the scheduler retries with its backoff. */
export async function runAuthoritySweep(d: AuthorityDeps): Promise<TaskResult> {
  // Lease ends need no D1: closed first, so a D1 outage doesn't keep an idle expired socket open.
  d.sockets?.sweep()
  const readAt = d.now()
  const cursor = d.sql.exec<{ value: number | null }>('SELECT value FROM flags WHERE key = ?', CURSOR_FLAG).toArray()[0]?.value ?? null
  const from = cursor === null ? 0 : cursor - SWEEP_OVERLAP_MS
  const inSet = [...ids(d.sql, 'member')]
  const [removed, ended, live, back] = await d.db.batch([
    d.db.prepare("SELECT id FROM members WHERE status = 'removed' AND removed_at_ms >= ?").bind(from),
    d.db.prepare('SELECT id FROM support_grants WHERE (ended_at_ms IS NOT NULL AND ended_at_ms >= ?) OR (ends_at_ms <= ? AND ends_at_ms >= ?)').bind(from, readAt, from),
    d.db.prepare('SELECT id, ends_at_ms FROM support_grants WHERE ended_at_ms IS NULL AND ends_at_ms > ?').bind(readAt),
    d.db.prepare("SELECT id FROM members WHERE status != 'removed' AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(inSet)),
  ])
  // Applied in one synchronous step, against the sets as they are now.
  const members = ids(d.sql, 'member')
  for (const r of removed.results as { id: string }[]) if (!members.has(r.id)) d.onMemberRemoved(r.id)
  const grants = ids(d.sql, 'grant')
  for (const r of ended.results as { id: string }[]) if (!grants.has(r.id)) d.onGrantEnded(r.id)
  for (const r of live.results as { id: string; ends_at_ms: number }[]) ensureGrantExpiry(d.scheduler, r.id, r.ends_at_ms)
  for (const r of back.results as { id: string }[]) {
    d.sql.exec("DELETE FROM authority WHERE kind = 'member' AND id = ? AND at_ms < ?", r.id, readAt)
  }
  d.sql.exec('INSERT INTO flags (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', CURSOR_FLAG, readAt)
  const sockets = d.sockets?.sweep() ?? { open: 0, nextLeaseEndMs: null }
  const turns = d.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM turns WHERE state IN ('queued', 'starting', 'live', 'ending')").one().n
  if (sockets.open > 0 || turns > 0) {
    const now = d.now()
    d.scheduler.schedule({ id: SWEEP_ID, kind: 'authority-sweep', dueAtMs: Math.min(now + SWEEP_EVERY_MS, sockets.nextLeaseEndMs ?? Number.POSITIVE_INFINITY) })
  }
  return { done: true }
}

/** One `grant-expiry:<grantId>` run: ends the grant in the object once D1 says it ended; else waits for its end. */
export async function runGrantExpiry(d: AuthorityDeps, taskId: string): Promise<TaskResult> {
  const grantId = taskId.slice(GRANT_EXPIRY_PREFIX.length)
  const row = await d.db.prepare('SELECT ends_at_ms, ended_at_ms FROM support_grants WHERE id = ?').bind(grantId).first<{ ends_at_ms: number; ended_at_ms: number | null }>()
  const now = d.now()
  if (row && row.ended_at_ms === null && row.ends_at_ms > now) {
    d.scheduler.schedule({ id: taskId, kind: 'grant-expiry', dueAtMs: row.ends_at_ms })
    return { done: true }
  }
  // Ended, expired, or a grant D1 doesn't know (nothing can hold it): ended in the object.
  d.onGrantEnded(grantId)
  return { done: true }
}
