// Person deletion (P8 acceptance 3, decision Q3): a plan (a dry run that writes nothing and counts), then a run that
// takes only that plan, recounts and refuses `plan_stale` if anything changed. The run, in order: (1) the deletion
// log's `start` entry; (2) P2's `pseudonymise` (its SQL guard refuses the last active Admin: a `refused` entry, then
// stop); (3) one D1 batch deleting the rows the person owns; (4) the R2 objects under their pattern; (5) the `done`
// entry with what was removed. Log first: a logged request that fails half way is finished by a re-run or F1's
// replay (every step is idempotent); a deletion that acted but never logged would come back after a restore.
// No audit line: `pseudonymise` writes none and the audit table is never written here. The deletion log is the record.
// D1 batch (one transaction; meta.changes): https://developers.cloudflare.com/d1/worker-api/d1-database/ (read 2026-11-20)
import { memberStore } from '../../server/db/members.ts'
import type { MemberRow } from '../../server/db/members.ts'
import { first, runBatch, stmt } from '../../server/db/sql.ts'
import type { TableEntry } from '../tables/types.ts'
import { newRunId, writeLogEntry } from './log.ts'
import type { DeletionLogEntry } from './log.ts'
import { deleteKeys, ident, isMemberId, listAll, personPrefix, registryOf } from './r2.ts'
import type { JobDeps } from './r2.ts'
import { ALLOWED, deletionRules } from './rules.ts'
import type { DeletionRule } from './rules.ts'

export interface DeletionDeps extends JobDeps {
  /** Defaults to `deletionRules` (rules.ts); tests pass fixtures. */
  rules?: Readonly<Record<string, DeletionRule>>
}

export type DeletionRefusal = 'bad_id' | 'not_found' | 'not_person' | 'last_admin'

export interface PersonDeletionPlan {
  readonly memberId: string
  /** A run that pseudonymised the row and stopped: this plan finishes the rest. */
  readonly alreadyPseudonymised: boolean
  /** What the run will remove or pseudonymise, per store it acts on (`keep` stores aren't listed). */
  readonly counts: Readonly<Record<string, number>>
  readonly atMs: number
  readonly steps: readonly Step[]
}

type Step = { entry: TableEntry; rule: Exclude<DeletionRule, { action: 'keep' }> }

/** Only plans made by `planPersonDeletion` run (no plan, no run). */
const issued = new WeakSet<PersonDeletionPlan>()

/** Every registered store's rule, checked against its class. Throws by store name on a gap. */
function stepsFor(registry: readonly TableEntry[], rules: Readonly<Record<string, DeletionRule>>): Step[] {
  const steps: Step[] = []
  for (const entry of registry) {
    const rule = rules[entry.name]
    if (rule === undefined) throw new Error(`person deletion: no rule for ${entry.kind} store ${entry.name} (add one to ops/delete/rules.ts)`)
    if (!ALLOWED[entry.retention].includes(rule.action)) throw new Error(`person deletion: rule ${rule.action} isn't allowed for ${entry.name} (class ${entry.retention})`)
    if (rule.action === 'keep') continue
    if (entry.kind === 'do') throw new Error(`person deletion: no Durable Object reader yet for ${entry.name}`)
    if (rule.action === 'pseudonymise' && !(entry.kind === 'd1' && entry.name === 'members')) throw new Error(`person deletion: pseudonymise is P2's members row only, not ${entry.name}`)
    if (rule.action === 'delete_rows' && entry.kind !== 'd1') throw new Error(`person deletion: delete_rows on ${entry.kind} store ${entry.name}`)
    if (rule.action === 'delete_objects' && entry.kind !== 'r2') throw new Error(`person deletion: delete_objects on ${entry.kind} store ${entry.name}`)
    if (rule.action === 'delete_rows') {
      ident(entry.name)
      ident(rule.column)
    }
    steps.push({ entry, rule })
  }
  return steps
}

const memberRow = (db: D1Database, id: string) => first<MemberRow>(db, stmt('SELECT * FROM members WHERE id = ?', id))

/**
 * Why this id can't be deleted, or its row. The last-Admin check is the plan's; the run leaves it to P2's guard in
 * `pseudonymise`'s statement (one reviewed place), which a `refused` log entry then records.
 */
async function check(db: D1Database, memberId: string, lastAdmin: boolean): Promise<{ refused: DeletionRefusal } | { row: MemberRow }> {
  if (!isMemberId(memberId)) return { refused: 'bad_id' }
  const row = await memberRow(db, memberId)
  if (!row) return { refused: 'not_found' }
  if (row.kind !== 'person') return { refused: 'not_person' }
  if (lastAdmin && row.pseudonymised_at_ms === null && row.role === 'admin' && row.status === 'active') {
    const others = await first<{ n: number }>(db, stmt("SELECT COUNT(*) AS n FROM members WHERE kind = 'person' AND role = 'admin' AND status = 'active' AND id <> ?", memberId))
    if ((others?.n ?? 0) === 0) return { refused: 'last_admin' }
  }
  return { row }
}

async function countSteps(deps: DeletionDeps, steps: readonly Step[], memberId: string, row: MemberRow): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const { entry, rule } of steps) {
    if (rule.action === 'pseudonymise') counts[entry.name] = row.pseudonymised_at_ms === null ? 1 : 0
    else if (rule.action === 'delete_rows') {
      const r = await first<{ n: number }>(deps.db, stmt(`SELECT COUNT(*) AS n FROM ${ident(entry.name)} WHERE ${ident(rule.column)} = ?`, memberId))
      if (!r) throw new Error(`person deletion: no count from ${entry.name}`)
      counts[entry.name] = r.n
    } else {
      const prefix = personPrefix(entry, memberId)
      if (prefix === null) throw new Error(`person deletion: ${entry.name} has no <memberId> pattern to delete under`)
      counts[entry.name] = (await listAll(deps.bucket, prefix)).length
    }
  }
  return counts
}

/** The dry run: writes nothing; refuses the last active Admin, an Inhouse or service row, an unknown or malformed id. */
export async function planPersonDeletion(deps: DeletionDeps, input: { memberId: string }): Promise<{ ok: PersonDeletionPlan } | { refused: DeletionRefusal }> {
  const steps = stepsFor(registryOf(deps), deps.rules ?? deletionRules)
  const checked = await check(deps.db, input.memberId, true)
  if ('refused' in checked) return checked
  const plan: PersonDeletionPlan = Object.freeze({
    memberId: input.memberId,
    alreadyPseudonymised: checked.row.pseudonymised_at_ms !== null,
    counts: Object.freeze(await countSteps(deps, steps, input.memberId, checked.row)),
    atMs: deps.at.nowMs,
    steps: Object.freeze(steps),
  })
  issued.add(plan)
  return { ok: plan }
}

export type PersonDeletionResult =
  | { ok: { runId: string; removed: Record<string, number> } }
  | { refused: 'plan_stale'; planned: Readonly<Record<string, number>>; now: Record<string, number> }
  | { refused: DeletionRefusal }

/** Tests only: runs after each step (to fail the run there). */
export interface DeletionTesting {
  afterStep?: (step: 'start' | 'pseudonymise' | 'rows' | 'objects') => Promise<void>
}

const sameCounts = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

export async function runPersonDeletion(deps: DeletionDeps, plan: PersonDeletionPlan, testing: DeletionTesting = {}): Promise<PersonDeletionResult> {
  if (!issued.has(plan)) throw new Error('person deletion: runs only from a plan made by planPersonDeletion')
  const { db, bucket, at } = deps
  const { memberId, steps } = plan
  const checked = await check(db, memberId, false)
  if ('refused' in checked) return checked
  const now = await countSteps(deps, steps, memberId, checked.row)
  if (!sameCounts(plan.counts, now) || plan.alreadyPseudonymised !== (checked.row.pseudonymised_at_ms !== null)) return { refused: 'plan_stale', planned: plan.counts, now }

  const runId = newRunId()
  // Each entry takes the run's next step (0, 1, 2...): its write order, which the key sorts by within the run.
  let step = 0
  const entry = (phase: DeletionLogEntry['phase'], extra: Partial<DeletionLogEntry> = {}): DeletionLogEntry =>
    ({ format: 1, runId, step: step++, phase, kind: 'person', atMs: at.nowMs, actorId: at.actorId, memberId, ...extra })
  await writeLogEntry(bucket, entry('start'))
  await testing.afterStep?.('start')

  const removed: NonNullable<DeletionLogEntry['removed']> = []
  for (const { entry: e, rule } of steps) {
    if (rule.action !== 'pseudonymise') continue
    if (plan.alreadyPseudonymised) {
      removed.push({ store: e.name, count: 0 })
      continue
    }
    const done = await memberStore({ db }).pseudonymise(memberId, at)
    if ('refused' in done) {
      await writeLogEntry(bucket, entry('refused', { reason: done.refused }))
      return { refused: done.refused }
    }
    removed.push({ store: e.name, count: 1 })
  }
  await testing.afterStep?.('pseudonymise')

  const rowSteps = steps.filter(s => s.rule.action === 'delete_rows')
  if (rowSteps.length > 0) {
    const results = await runBatch(db, rowSteps.map(({ entry: e, rule }) =>
      stmt(`DELETE FROM ${ident(e.name)} WHERE ${ident((rule as { column: string }).column)} = ?`, memberId)))
    rowSteps.forEach(({ entry: e }, i) => removed.push({ store: e.name, count: results[i].meta.changes }))
  }
  await testing.afterStep?.('rows')

  for (const { entry: e, rule } of steps) {
    if (rule.action !== 'delete_objects') continue
    const prefix = personPrefix(e, memberId)
    if (prefix === null) throw new Error(`person deletion: ${e.name} has no <memberId> pattern to delete under`)
    const keys = (await listAll(bucket, prefix)).map(o => o.key)
    await deleteKeys(bucket, keys)
    removed.push({ store: e.name, keys, count: keys.length })
  }
  await testing.afterStep?.('objects')

  await writeLogEntry(bucket, entry('done', { removed }))
  return { ok: { runId, removed: Object.fromEntries(removed.map(r => [r.store, r.count])) } }
}
