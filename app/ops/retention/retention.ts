// Retention (P8 acceptance 1): removes what is past each `retention_period` store's period. A plan (a dry run that
// writes nothing and counts) fixes each store's cutoff, `at.nowMs - days * 86_400_000`; the run takes only that plan
// and uses its cutoffs, never a new clock. A D1 row goes when its age column is strictly before the cutoff, an R2
// object when its `uploaded` time is. Every other class (the audit log included) is never touched: a period given for
// one throws. The run logs its cutoffs first, then deletes in bounded rounds (a D1 statement removes at most
// `roundSize` rows by primary key, an R2 call 1,000 keys), each round's ids or keys in a `progress` entry, so no
// statement nears D1's time limit and no entry grows with the table; `done` holds the totals. It doesn't refuse on a
// changed count (the cutoff, not the count, defines what goes); its result reports the difference.
// D1 batch and RETURNING: https://developers.cloudflare.com/d1/worker-api/d1-database/ (read 2026-11-20)
import { all, stmt } from '../../server/db/sql.ts'
import { runLog } from '../delete/log.ts'
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
  rule: Extract<RetentionRule, { kind: 'd1' | 'r2' }>
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
  // C1: a custom rule's job (the chat cascade, a condition, a Durable Object's storage) isn't built yet, so a plan that
  // would reach one refuses by name, whatever the store's class (a config store's forgotten facts included).
  for (const entry of registry) {
    if (rules[entry.name]?.kind === 'custom') throw new Error(`retention: ${entry.name}'s rule is custom, and its job isn't built yet (P8 C1), so retention refuses to plan it`)
  }
  const targets: Target[] = []
  for (const entry of registry) {
    if (entry.retention !== 'retention_period') continue
    // A derived index has no rows of its own to age: its triggers follow its source. It takes a derived rule, no period.
    if (entry.derived) {
      if (rules[entry.name]?.kind !== 'derived') throw new Error(`retention: ${entry.name} is derived: its rule must be derived`)
      continue
    }
    const days = periods[entry.name]
    if (days === undefined) throw new Error(`retention: no period given for ${entry.name}`)
    const rule = rules[entry.name]
    if (rule === undefined) throw new Error(`retention: no rule for ${entry.kind} store ${entry.name} (add one to ops/retention/rules.ts)`)
    if (rule.kind === 'derived' || rule.kind === 'custom') throw new Error(`retention: ${entry.name} isn't derived, its rule is ${rule.kind}`)
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
    if (t.rule.kind === 'd1') {
      // The rounds delete by `idColumn`, so it must be the table's whole primary key.
      const pk = (await all<{ name: string; pk: number }>(deps.db, stmt(`PRAGMA table_info(${ident(t.entry.name)})`))).filter(c => c.pk > 0).map(c => c.name)
      if (pk.length !== 1 || pk[0] !== t.rule.idColumn) throw new Error(`retention: ${t.entry.name}'s idColumn ${t.rule.idColumn} is not its primary key (${pk.join(', ') || 'none'})`)
    }
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

/** Rows one D1 statement removes at most (by primary key), and so the ids one `progress` entry holds. */
export const ROUND_SIZE = 500

export async function runRetention(deps: RetentionDeps, plan: RetentionPlan, opts: { roundSize?: number } = {}): Promise<RetentionResult> {
  if (!issued.has(plan)) throw new Error('retention: runs only from a plan made by planRetention')
  const roundSize = opts.roundSize ?? ROUND_SIZE
  if (!Number.isSafeInteger(roundSize) || roundSize < 1 || roundSize > 1000) throw new Error('retention: roundSize must be 1 to 1,000')
  const { db, bucket, at } = deps
  const log = runLog(bucket, deps.clock ?? Date.now, { kind: 'retention', actorId: at.actorId, cutoffs: [...plan.cutoffs] })
  await log.write('start')

  const removed: { store: string; count: number }[] = []
  for (const t of plan.targets) {
    let count = 0
    if (t.rule.kind === 'd1') {
      const [table, age, id] = [ident(t.entry.name), ident(t.rule.ageColumn), ident(t.rule.idColumn)]
      for (;;) {
        const rows = await all<{ id: unknown }>(db, stmt(
          `DELETE FROM ${table} WHERE ${id} IN (SELECT ${id} FROM ${table} WHERE ${age} < ? ORDER BY ${id} LIMIT ?) RETURNING ${id} AS id`,
          t.cutoffMs, roundSize,
        ))
        if (rows.length === 0) break
        const ids = rows.map(r => String(r.id))
        await log.write('progress', { removed: [{ store: t.entry.name, ids, count: ids.length }] })
        count += ids.length
        if (rows.length < roundSize) break
      }
    } else {
      const keys = await pastObjects(bucket, t)
      for (let i = 0; i < keys.length; i += 1000) {
        const round = keys.slice(i, i + 1000)
        await deleteKeys(bucket, round)
        await log.write('progress', { removed: [{ store: t.entry.name, keys: round, count: round.length }] })
        count += round.length
      }
    }
    removed.push({ store: t.entry.name, count })
  }

  await log.write('done', { removed })
  const counts = Object.fromEntries(removed.map(r => [r.store, r.count]))
  return {
    runId: log.runId,
    removed: counts,
    differences: Object.keys(plan.counts).filter(s => plan.counts[s] !== counts[s]).map(s => ({ store: s, planned: plan.counts[s], removed: counts[s] })),
  }
}
