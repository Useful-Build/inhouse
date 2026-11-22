// P8 C1's health signals over the data jobs (#346 review M2). Each reads the request's stores (`stores.dataHealth`), and
// its detail is counts, ages and store names only.
// - `backup_fresh`: the newest complete backup (a manifest) is at most 26 hours old.
// - `retention_fresh`: every retention store has a `done` run in the deletion log within 26 hours (the handler runs
//   store by store, so each store's own newest `done` counts).
// - `retention_overdue`: no store holds a row older than its cutoff plus two days (the daily run's slack). It reads D1
//   only, so the BrandAgent's own storage isn't in it (its job's freshness is), and a chat busy in the object is too
//   rare to exclude here: a chat with a live or waiting session has recent activity, so it isn't past its period.
//   This is the detection the R2 lifecycle proposal leaves to retention: there's no age rule on files/, sessions/ or
//   library/, so a job that stops shows here instead.
// A deployment younger than 26 hours (its first migration, `d1_migrations.applied_at`) hasn't had its first nightly run
// yet: backup_fresh and retention_fresh read green then, saying so, so a fresh brand's health route isn't red until 01:30.
// `backup_failed` and `retention_failed` stay log lines too.
import { listAll } from '../../../ops/delete/r2.ts'
import { deletionLogEntrySchema } from '../../../ops/delete/log.ts'
import { DEFAULT_DAYS, periodsFor, retentionRules } from '../../../ops/retention/rules.ts'
import { tables } from '../../../ops/tables/index.ts'
import { retentionStores } from '../retention-handlers.ts'
import { backupManifestKey } from '../../db/r2-keys.ts'
import type { KeyedBucket } from '../../db/r2-keys.ts'
import { first, stmt } from '../../db/sql.ts'
import type { Signal, SignalResult } from './types.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const FRESH_MS = 26 * HOUR
export const OVERDUE_SLACK_MS = 2 * DAY

type Bucket = Pick<KeyedBucket, 'get' | 'list'>

/** When the deployment's first migration was applied (UTC), or null when D1 doesn't say. */
export async function deployedAtMs(db: D1Database): Promise<number | null> {
  const r = await first<{ at: string | null }>(db, stmt('SELECT MIN(applied_at) AS at FROM d1_migrations'))
  const ms = r?.at ? Date.parse(`${r.at.replace(' ', 'T')}Z`) : NaN
  return Number.isFinite(ms) ? ms : null
}
const young = (deployed: number | null, nowMs: number) => deployed !== null && nowMs - deployed < FRESH_MS

/** The newest complete backup's age: red when there's none (after the first day), or it's older than 26 hours. */
export async function backupFresh(db: D1Database, bucket: Bucket, nowMs: number): Promise<SignalResult> {
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix: 'backups/d1/', delimiter: '/', cursor })
    for (const p of page.delimitedPrefixes) ids.push(p.slice('backups/d1/'.length, -1))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  // Ids sort by time; the newest with a manifest is the newest complete backup.
  for (const id of ids.sort().reverse()) {
    const obj = await bucket.get(backupManifestKey(id))
    if (!obj) continue
    const m = JSON.parse(await obj.text()) as { takenAtMs: number; tables: { parts: unknown[] }[] }
    const age = nowMs - m.takenAtMs
    const parts = m.tables.reduce((n, t) => n + t.parts.length, 0)
    const detail = `${Math.floor(age / HOUR)}h old, ${parts} parts`
    return age <= FRESH_MS ? { ok: true, detail } : { ok: false, detail }
  }
  return young(await deployedAtMs(db), nowMs) ? { ok: true, detail: 'no backup yet (deployed under 26h ago)' } : { ok: false, detail: 'no complete backup' }
}

/** Every retention store has a `done` run within 26 hours: red names the ones that don't. */
export async function retentionFresh(db: D1Database, bucket: Bucket, nowMs: number, stores: readonly string[] = retentionStores().map(e => e.name)): Promise<SignalResult> {
  const since = `deletion-log/${String(nowMs - FRESH_MS - 1).padStart(13, '0')}.`
  // listAll only lists (ops/delete/r2.ts); the signal's bucket is the stores' read view of the same binding.
  const done = (await listAll(bucket as R2Bucket, 'deletion-log/', since)).filter(o => o.key.endsWith('-done.json'))
  const seen = new Set<string>()
  for (const o of done) {
    const body = await bucket.get(o.key)
    if (!body) continue
    const e = deletionLogEntrySchema.parse(JSON.parse(await body.text()))
    if (e.kind === 'retention') for (const c of e.cutoffs ?? []) seen.add(c.store)
  }
  const stale = stores.filter(s => !seen.has(s))
  if (stale.length > 0 && young(await deployedAtMs(db), nowMs)) return { ok: true, detail: 'no run yet (deployed under 26h ago)' }
  return stale.length === 0 ? { ok: true, detail: `${stores.length} stores` } : { ok: false, detail: `no run in 26h: ${stale.join(', ')}` }
}

/** Per store, a count of rows older than its cutoff plus the slack (D1 stores only). */
function overdueChecks(nowMs: number): { store: string; sql: string; params: number[] }[] {
  const periods = periodsFor(tables)
  const own = (store: string) => nowMs - (periods[store] ?? 0) * DAY - OVERDUE_SLACK_MS
  const fixed = (p: keyof typeof DEFAULT_DAYS) => nowMs - DEFAULT_DAYS[p] * DAY - OVERDUE_SLACK_MS
  const checks: { store: string; sql: string; params: number[] }[] = [
    { store: 'chats', sql: 'SELECT COUNT(*) AS n FROM chats WHERE last_at_ms < ? OR (deleted_at_ms IS NOT NULL AND deleted_at_ms < ?)', params: [own('chats'), fixed('trash')] },
    { store: 'tool_calls', sql: 'SELECT COUNT(*) AS n FROM tool_calls WHERE at_ms < ?', params: [own('tool_calls')] },
    { store: 'chat_files', sql: "SELECT COUNT(*) AS n FROM library_marks WHERE source = 'chat' AND deleted_at_ms < ?", params: [fixed('trash')] },
    { store: 'memories', sql: "SELECT COUNT(*) AS n FROM memories WHERE status = 'forgotten' AND updated_at_ms < ?", params: [fixed('forgottenMemory')] },
    { store: 'routine_slots', sql: 'SELECT COUNT(*) AS n FROM routine_slots s WHERE claimed_at_ms < ? AND NOT EXISTS (SELECT 1 FROM today_items t WHERE t.slot_key = s.slot_key)', params: [own('routine_slots')] },
    { store: 'notices', sql: 'SELECT COUNT(*) AS n FROM notices WHERE at_ms < ?', params: [own('notices')] },
    { store: 'library_uploads', sql: "SELECT COUNT(*) AS n FROM library_uploads u WHERE (u.state = 'pending' AND u.created_at_ms < ?) OR EXISTS (SELECT 1 FROM library_marks m WHERE m.file_id = u.id AND m.source = 'upload' AND m.deleted_at_ms < ?)", params: [fixed('pendingUpload'), fixed('trash')] },
  ]
  // The plain d1 rules (Activity, Today, the egress record): their own age column.
  for (const [store, rule] of Object.entries(retentionRules)) {
    if (rule.kind === 'd1') checks.push({ store, sql: `SELECT COUNT(*) AS n FROM "${store}" WHERE "${rule.ageColumn}" < ?`, params: [own(store)] })
  }
  return checks
}

/** No store holds a row past its cutoff plus two days: red names each store that does, with its count. */
export async function retentionOverdue(db: D1Database, nowMs: number): Promise<SignalResult> {
  const late: string[] = []
  for (const c of overdueChecks(nowMs)) {
    const r = await first<{ n: number }>(db, stmt(c.sql, ...c.params))
    if (!r) throw new Error(`retention_overdue: no count from ${c.store}`)
    if (r.n > 0) late.push(`${c.store} ${r.n}`)
  }
  return late.length === 0 ? { ok: true } : { ok: false, detail: `past retention: ${late.join(', ')}` }
}

/** What the stores give the signals (server/db/stores.ts `dataHealth`). */
export interface DataHealth {
  backupFresh(nowMs: number): Promise<SignalResult>
  retentionFresh(nowMs: number): Promise<SignalResult>
  retentionOverdue(nowMs: number): Promise<SignalResult>
}

export const dataHealth = ({ db, bucket }: { db: D1Database; bucket: Bucket }): DataHealth => ({
  backupFresh: nowMs => backupFresh(db, bucket, nowMs),
  retentionFresh: nowMs => retentionFresh(db, bucket, nowMs),
  retentionOverdue: nowMs => retentionOverdue(db, nowMs),
})

export function dataSignals(now: () => number = () => Date.now()): readonly Signal[] {
  return [
    { name: 'backup_fresh', check: ({ stores }) => stores.dataHealth.backupFresh(now()) },
    { name: 'retention_fresh', check: ({ stores }) => stores.dataHealth.retentionFresh(now()) },
    { name: 'retention_overdue', check: ({ stores }) => stores.dataHealth.retentionOverdue(now()) },
  ]
}
