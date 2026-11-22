// Retention (P8 acceptance 1): removes what is past each `retention_period` store's period. A plan (a dry run that
// writes nothing and counts) fixes each store's cutoff, `at.nowMs - days * 86_400_000`; the run takes only that plan
// and uses its cutoffs, never a new clock. A D1 row goes when its age column is strictly before the cutoff, an R2
// object when its `uploaded` time is. Every other class (the audit log included) is never touched: a period given for
// one throws. The run logs its cutoffs first, then deletes in bounded rounds (a D1 statement removes at most
// `roundSize` rows by primary key, an R2 call 1,000 keys), each round's ids or keys in a `progress` entry, so no
// statement nears D1's time limit and no entry grows with the table; `done` holds the totals. It doesn't refuse on a
// changed count (the cutoff, not the count, defines what goes); its result reports the difference.
// C1: a `custom` rule runs its store's job (ops/coverage/chat-watch-connectors/retention-jobs.ts: the chat cascade, a
// condition, a composite key, an order, the BrandAgent's storage), on any class (a config store's forgotten facts
// included, from its fixed period, never from `periods`). A custom store another store's job removes (a chat's
// messages) has no job of its own; one with neither throws by name. Custom jobs run after the d1 and r2 rules, each on
// the units its plan fixed (at most `limit`); `maxRounds` bounds a d1 rule's rounds. The result says whether work remains.
// Plan one store at a time (as the handler does) for exact counts: in one plan, a row two jobs could take (an old chat's
// tool call, by the chat cascade and by its own age) is counted by both, and the run's difference shows it.
// D1 batch and RETURNING: https://developers.cloudflare.com/d1/worker-api/d1-database/ (read 2026-11-20)
import { all, stmt } from '../../server/db/sql.ts'
import { runLog } from '../delete/log.ts'
import { deleteKeys, ident, listAll, registryOf } from '../delete/r2.ts'
import type { JobDeps } from '../delete/r2.ts'
import { MAX_LIMIT, RETENTION_JOBS, SERVED_BY } from '../coverage/chat-watch-connectors/retention-jobs.ts'
import type { JobContext, JobPlan, RetentionJob } from '../coverage/chat-watch-connectors/retention-jobs.ts'
import type { TableEntry } from '../tables/types.ts'
import { retentionRules } from './rules.ts'
import type { RetentionRule } from './rules.ts'

export interface RetentionDeps extends JobDeps {
  /** Defaults to `retentionRules` (rules.ts); tests pass fixtures. */
  rules?: Readonly<Record<string, RetentionRule>>
  /** C1: the BrandAgent's storage, when retention runs inside the object (its job and the chat cascade's object rows). */
  sql?: SqlStorage
}

interface CustomTarget {
  entry: TableEntry
  job: RetentionJob
  cutoffMs: number | null
  plan: JobPlan
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
  /** C1's custom jobs, each with the units its plan fixed. */
  readonly custom?: readonly CustomTarget[]
  /** At most this many units per custom job (the handler's budget). */
  readonly limit?: number
}

const issued = new WeakSet<RetentionPlan>()

function targetsFor(registry: readonly TableEntry[], rules: Readonly<Record<string, RetentionRule>>, periods: Readonly<Record<string, number>>, nowMs: number): { targets: Target[]; custom: Omit<CustomTarget, 'plan'>[] } {
  for (const [store, days] of Object.entries(periods)) {
    const entry = registry.find(e => e.name === store)
    if (!entry) throw new Error(`retention: ${store} is not a registered store`)
    if (entry.retention !== 'retention_period') throw new Error(`retention: ${store} is ${entry.retention}, not retention_period: it takes no period`)
    if (!Number.isSafeInteger(days) || days < 1) throw new Error(`retention: ${store}'s period must be a whole number of days, at least 1`)
  }
  // C1: a custom rule runs its store's job, whatever the store's class; one with no job (and no other store's job
  // serving it) refuses by name, so nothing past retention is skipped silently.
  const custom: Omit<CustomTarget, 'plan'>[] = []
  for (const entry of registry) {
    if (rules[entry.name]?.kind !== 'custom') continue
    const job = RETENTION_JOBS[entry.name]
    if (job === undefined) {
      if (SERVED_BY[entry.name] !== undefined) continue
      throw new Error(`retention: ${entry.name}'s rule is custom, and no job serves it, so retention refuses to plan it`)
    }
    let cutoffMs: number | null = null
    if (entry.retention === 'retention_period') {
      const days = periods[entry.name]
      if (days === undefined) throw new Error(`retention: no period given for ${entry.name}`)
      cutoffMs = nowMs - days * DAY_MS
    }
    custom.push({ entry, job, cutoffMs })
  }
  const targets: Target[] = []
  for (const entry of registry) {
    if (entry.retention !== 'retention_period') continue
    // A derived index has no rows of its own to age: its triggers follow its source. It takes a derived rule, no period.
    if (entry.derived) {
      if (rules[entry.name]?.kind !== 'derived') throw new Error(`retention: ${entry.name} is derived: its rule must be derived`)
      continue
    }
    if (rules[entry.name]?.kind === 'custom') continue
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
  return { targets, custom }
}

const jobContext = (deps: RetentionDeps, atMs: number, cutoffMs: number | null, limit: number): JobContext => ({ db: deps.db, bucket: deps.bucket, sql: deps.sql, atMs, cutoffMs, limit })

const pastD1 = (t: Target & { rule: { kind: 'd1' } }) =>
  stmt(`SELECT COUNT(*) AS n FROM ${ident(t.entry.name)} WHERE ${ident(t.rule.ageColumn)} < ?`, t.cutoffMs)

async function pastObjects(bucket: JobDeps['bucket'], t: Target): Promise<string[]> {
  return (await listAll(bucket, t.entry.name)).filter(o => o.uploaded.getTime() < t.cutoffMs).map(o => o.key)
}

/** The dry run: writes nothing. `periods` in days, one per `retention_period` store, no defaults. */
export async function planRetention(deps: RetentionDeps, input: { periods: Readonly<Record<string, number>>; limit?: number }): Promise<RetentionPlan> {
  const limit = input.limit ?? MAX_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`retention: limit must be 1 to ${MAX_LIMIT}`)
  const { targets, custom: customTargets } = targetsFor(registryOf(deps), deps.rules ?? retentionRules, input.periods, deps.at.nowMs)
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
  const custom: CustomTarget[] = []
  const cutoffs = targets.map(t => ({ store: t.entry.name, cutoffMs: t.cutoffMs }))
  for (const c of customTargets) {
    const jobPlan = await c.job.plan(jobContext(deps, deps.at.nowMs, c.cutoffMs, limit))
    for (const [store, n] of Object.entries(jobPlan.counts)) counts[store] = (counts[store] ?? 0) + n
    cutoffs.push(...jobPlan.cutoffs)
    custom.push({ ...c, plan: jobPlan })
  }
  const plan: RetentionPlan = Object.freeze({
    atMs: deps.at.nowMs,
    cutoffs: Object.freeze(cutoffs),
    counts: Object.freeze(counts),
    targets: Object.freeze(targets),
    custom: Object.freeze(custom),
    limit,
  })
  issued.add(plan)
  return plan
}

export interface RetentionResult {
  runId: string
  removed: Record<string, number>
  /** Each store whose removed count isn't the planned one (rows aged past the cutoff, or went, in between). */
  differences: { store: string; planned: number; removed: number }[]
  /** C1: work remains (a custom job had more units than its limit, or a d1 rule hit `maxRounds`). */
  more: boolean
}

/** Rows one D1 statement removes at most (by primary key), and so the ids one `progress` entry holds. */
export const ROUND_SIZE = 500

export async function runRetention(deps: RetentionDeps, plan: RetentionPlan, opts: { roundSize?: number; maxRounds?: number } = {}): Promise<RetentionResult> {
  if (!issued.has(plan)) throw new Error('retention: runs only from a plan made by planRetention')
  const roundSize = opts.roundSize ?? ROUND_SIZE
  if (!Number.isSafeInteger(roundSize) || roundSize < 1 || roundSize > 1000) throw new Error('retention: roundSize must be 1 to 1,000')
  const { db, bucket, at } = deps
  const log = runLog(bucket, deps.clock ?? Date.now, { kind: 'retention', actorId: at.actorId, cutoffs: [...plan.cutoffs] })
  await log.write('start')

  const removed: { store: string; count: number }[] = []
  let more = false
  for (const t of plan.targets) {
    let count = 0
    if (t.rule.kind === 'd1') {
      const [table, age, id] = [ident(t.entry.name), ident(t.rule.ageColumn), ident(t.rule.idColumn)]
      for (let rounds = 0; ; rounds++) {
        if (opts.maxRounds !== undefined && rounds >= opts.maxRounds) {
          more = true
          break
        }
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

  // C1's custom jobs, on the units their plans fixed.
  const customRemoved: Record<string, number> = {}
  for (const c of plan.custom ?? []) {
    const got = await c.job.run(jobContext(deps, plan.atMs, c.cutoffMs, plan.limit ?? MAX_LIMIT), c.plan, async entries => {
      await log.write('progress', { removed: entries })
    })
    for (const [store, n] of Object.entries(got)) customRemoved[store] = (customRemoved[store] ?? 0) + n
    if (c.plan.more) more = true
  }
  for (const [store, n] of Object.entries(customRemoved)) {
    const there = removed.find(r => r.store === store)
    if (there) there.count += n
    else removed.push({ store, count: n })
  }

  await log.write('done', { removed })
  const counts = Object.fromEntries(removed.map(r => [r.store, r.count]))
  return {
    runId: log.runId,
    removed: counts,
    differences: Object.keys(plan.counts).filter(s => plan.counts[s] !== (counts[s] ?? 0)).map(s => ({ store: s, planned: plan.counts[s], removed: counts[s] ?? 0 })),
    more,
  }
}
