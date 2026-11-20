// Retention (P8 acceptance 1): removes what is past each `retention_period` store's period. A plan (a dry run that
// writes nothing and counts) fixes each store's cutoff, `at.nowMs - days * 86_400_000`; the run takes only that plan
// and uses its cutoffs, never a new clock. A D1 row goes when its age column is strictly before the cutoff, an R2
// object when its `uploaded` time is. Every other class (the audit log included) is never touched: a period given for
// one throws. The run logs its cutoffs first and what it removed last (the deletion log). It doesn't refuse on a
// changed count (the cutoff, not the count, defines what goes); its result reports the difference.
// D1 batch and RETURNING: https://developers.cloudflare.com/d1/worker-api/d1-database/ (read 2026-11-20)
import { all, runBatch, stmt } from '../../server/db/sql.ts'
import { newRunId, writeLogEntry } from '../delete/log.ts'
import type { DeletionLogEntry } from '../delete/log.ts'
import { deleteKeys, ident, listAll, registryOf } from '../delete/r2.ts'
import type { JobDeps } from '../delete/r2.ts'
import type { TableEntry } from '../tables/types.ts'
import { retentionRules } from './rules.ts'
import type { RetentionRule } from './rules.ts'

export interface RetentionDeps extends JobDeps {
  /** Defaults to `retentionRules` (rules.ts); tests pass fixtures. */
  rules?: Readonly<Record<string, RetentionRule>>
}

const DAY_MS = 86_400_000

interface Target {
  entry: TableEntry
  rule: RetentionRule
  cutoffMs: number
}

export interface RetentionPlan {
  readonly atMs: number
  readonly cutoffs: readonly { store: string; cutoffMs: number }[]
  /** What is past retention now, per store. */
  readonly counts: Readonly<Record<string, number>>
  readonly targets: readonly Target[]
}

const issued = new WeakSet<RetentionPlan>()

function targetsFor(registry: readonly TableEntry[], rules: Readonly<Record<string, RetentionRule>>, periods: Readonly<Record<string, number>>, nowMs: number): Target[] {
  for (const [store, days] of Object.entries(periods)) {
    const entry = registry.find(e => e.name === store)
    if (!entry) throw new Error(`retention: ${store} is not a registered store`)
    if (entry.retention !== 'retention_period') throw new Error(`retention: ${store} is ${entry.retention}, not retention_period: it takes no period`)
    if (!Number.isSafeInteger(days) || days < 1) throw new Error(`retention: ${store}'s period must be a whole number of days, at least 1`)
  }
  const targets: Target[] = []
  for (const entry of registry) {
    if (entry.retention !== 'retention_period') continue
    const days = periods[entry.name]
    if (days === undefined) throw new Error(`retention: no period given for ${entry.name}`)
    const rule = rules[entry.name]
    if (rule === undefined) throw new Error(`retention: no rule for ${entry.kind} store ${entry.name} (add one to ops/retention/rules.ts)`)
    if (rule.kind !== entry.kind) throw new Error(`retention: ${entry.name} is ${entry.kind}, its rule is ${rule.kind}`)
    if (rule.kind === 'd1') {
      ident(entry.name)
      ident(rule.ageColumn)
      ident(rule.idColumn)
    }
    targets.push({ entry, rule, cutoffMs: nowMs - days * DAY_MS })
  }
  return targets
}

const pastD1 = (t: Target & { rule: { kind: 'd1' } }) =>
  stmt(`SELECT COUNT(*) AS n FROM ${ident(t.entry.name)} WHERE ${ident(t.rule.ageColumn)} < ?`, t.cutoffMs)

async function pastObjects(bucket: JobDeps['bucket'], t: Target): Promise<string[]> {
  return (await listAll(bucket, t.entry.name)).filter(o => o.uploaded.getTime() < t.cutoffMs).map(o => o.key)
}

/** The dry run: writes nothing. `periods` in days, one per `retention_period` store, no defaults. */
export async function planRetention(deps: RetentionDeps, input: { periods: Readonly<Record<string, number>> }): Promise<RetentionPlan> {
  const targets = targetsFor(registryOf(deps), deps.rules ?? retentionRules, input.periods, deps.at.nowMs)
  const counts: Record<string, number> = {}
  for (const t of targets) {
    if (t.rule.kind === 'd1') counts[t.entry.name] = (await all<{ n: number }>(deps.db, pastD1(t as Target & { rule: { kind: 'd1' } })))[0].n
    else counts[t.entry.name] = (await pastObjects(deps.bucket, t)).length
  }
  const plan: RetentionPlan = Object.freeze({
    atMs: deps.at.nowMs,
    cutoffs: Object.freeze(targets.map(t => ({ store: t.entry.name, cutoffMs: t.cutoffMs }))),
    counts: Object.freeze(counts),
    targets: Object.freeze(targets),
  })
  issued.add(plan)
  return plan
}

export interface RetentionResult {
  runId: string
  removed: Record<string, number>
  /** Each store whose removed count isn't the planned one (rows aged past the cutoff, or went, in between). */
  differences: { store: string; planned: number; removed: number }[]
}

export async function runRetention(deps: RetentionDeps, plan: RetentionPlan): Promise<RetentionResult> {
  if (!issued.has(plan)) throw new Error('retention: runs only from a plan made by planRetention')
  const { db, bucket, at } = deps
  const runId = newRunId()
  const entry = (phase: DeletionLogEntry['phase'], extra: Partial<DeletionLogEntry> = {}): DeletionLogEntry =>
    ({ format: 1, runId, phase, kind: 'retention', atMs: at.nowMs, actorId: at.actorId, cutoffs: [...plan.cutoffs], ...extra })
  await writeLogEntry(bucket, entry('start'))

  const removed: NonNullable<DeletionLogEntry['removed']> = []
  const d1 = plan.targets.filter((t): t is Target & { rule: { kind: 'd1'; ageColumn: string; idColumn: string } } => t.rule.kind === 'd1')
  if (d1.length > 0) {
    const results = await runBatch(db, d1.map(t =>
      stmt(`DELETE FROM ${ident(t.entry.name)} WHERE ${ident(t.rule.ageColumn)} < ? RETURNING ${ident(t.rule.idColumn)} AS id`, t.cutoffMs)))
    d1.forEach((t, i) => {
      const ids = (results[i].results as { id: unknown }[]).map(r => String(r.id))
      removed.push({ store: t.entry.name, ids, count: ids.length })
    })
  }
  for (const t of plan.targets) {
    if (t.rule.kind !== 'r2') continue
    const keys = await pastObjects(bucket, t)
    await deleteKeys(bucket, keys)
    removed.push({ store: t.entry.name, keys, count: keys.length })
  }

  await writeLogEntry(bucket, entry('done', { removed }))
  const counts = Object.fromEntries(removed.map(r => [r.store, r.count]))
  return {
    runId,
    removed: counts,
    differences: Object.keys(plan.counts).filter(s => plan.counts[s] !== counts[s]).map(s => ({ store: s, planned: plan.counts[s], removed: counts[s] })),
  }
}
