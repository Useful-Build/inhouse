// Step 5 of a restore (P8a R; plan "The deletion log", "A restore, step by step"): every deletion made after a
// store's own point is made again, so a person deleted after the backup stays deleted. The log (G2's entries,
// ops/delete/log.ts) is read from the watermark (the earliest of the D1 point and each Durable Object's recovery
// time), and grouped by run. A run is applied to a store only when the run's last entry is at or after that store's
// own point: a D1 table and an R2 prefix the D1 point (R2 isn't rewound, so a replay there finds little), a Durable
// Object its recovery time. So nothing logged before the backup's point reaches the restored D1 (C1 review M2: a
// reused key would lose a row), and a Durable Object rewound further back gets the deletions in between.
// A table C1's backup reads in pages (`d1.paged`) isn't exact at the point: its rows are from somewhere between the
// backup's start and its end. Its point is still the backup's start (`takenAtMs`, the D1 point here), and the replay
// is inclusive, so every deletion logged during the read is applied again: none is missed, and nothing logged before
// the read began is touched (M2). So a paged table needs no point of its own.
//
// A person run deletes the member again with the store rules person deletion uses (ops/delete/rules.ts), in its order:
// pseudonymise the member row, then each custom store through its runner (the BrandAgent's `personData`, before the
// D1 batch: C1's run order), then the D1 rows, then the R2 objects. A retention run applies its logged cutoffs again
// (ops/retention/rules.ts). A run with a `refused` entry removed nothing and is skipped. The whole replay is planned
// before anything is written: a store with a custom rule and no runner (the chat cascade, the bell's ordered delete,
// until C1's runners land) refuses the replay by name, never skipped, and nothing is written. Every step is
// idempotent, so a replay stopped half way (a busy BrandAgent) is finished by a re-run. The replay writes no
// deletion-log entry: it repeats logged deletions, it doesn't make new ones.
import { memberStore } from '../../../server/db/members.ts'
import type { At } from '../../../server/db/members.ts'
import { R2_PREFIXES } from '../../../server/db/r2-keys.ts'
import { runBatch, stmt } from '../../../server/db/sql.ts'
import type { PersonDataAnswer } from '../../../server/do/brand-agent/ports.ts'
import { listDeletionLog } from '../../delete/log.ts'
import type { DeletionLogEntry } from '../../delete/log.ts'
import { deleteKeys, ident, listAll, personPrefix } from '../../delete/r2.ts'
import { ALLOWED, deletionRules } from '../../delete/rules.ts'
import type { DeletionRule } from '../../delete/rules.ts'
import { retentionRules } from '../../retention/rules.ts'
import type { RetentionRule } from '../../retention/rules.ts'
import type { TableEntry } from '../../tables/types.ts'
import { RestoreRefusal } from '../errors.ts'
import type { Reconcile, RestoreRecord } from '../manifest.ts'

const LOG_PREFIX = R2_PREFIXES.find(p => p === 'deletion-log/')
if (LOG_PREFIX === undefined) throw new Error('reconcile: r2-keys.ts no longer lists deletion-log/')

/** A custom store's person deletion (C1's runners): `{ stop }` names why it can't run now (the replay stops there). */
export interface PersonRunner {
  deletePerson(memberId: string): Promise<{ ok: number } | { stop: string }>
}

/** The BrandAgent's runner: `BrandAgentRpc.personData` in `delete` mode (shapes.md personData r4). `busy` stops the replay. */
export function brandAgentRunner(rpc: { personData(p: { personId: string; mode: 'count' | 'delete' }): Promise<PersonDataAnswer> }): PersonRunner {
  return {
    async deletePerson(memberId) {
      const answer = await rpc.personData({ personId: memberId, mode: 'delete' })
      if ('counts' in answer) return { ok: Object.values(answer.counts).reduce((a, b) => a + b, 0) }
      if ('busy' in answer) return { stop: 'busy' }
      return { stop: `refused_${answer.refused.code}` }
    },
  }
}

/** One logged run, as the replay sees it: what it deleted and its last listed entry's time. */
export interface LoggedRun {
  runId: string
  kind: DeletionLogEntry['kind']
  memberId?: string
  cutoffs?: { store: string; cutoffMs: number }[]
  lastAtMs: number
  refused: boolean
}

/** The listed entries grouped by run, in order of each run's first listed key. */
export function groupRuns(entries: readonly { key: string; entry: DeletionLogEntry }[]): LoggedRun[] {
  const runs = new Map<string, LoggedRun>()
  for (const { key, entry: e } of entries) {
    const run = runs.get(e.runId)
    if (run === undefined) {
      if (e.kind === 'person' && e.memberId === undefined) throw new RestoreRefusal('deletion_log_invalid', `${key}: a person entry without a member id`)
      if (e.kind === 'retention' && e.cutoffs === undefined) throw new RestoreRefusal('deletion_log_invalid', `${key}: a retention entry without cutoffs`)
      runs.set(e.runId, { runId: e.runId, kind: e.kind, memberId: e.memberId, cutoffs: e.cutoffs, lastAtMs: e.atMs, refused: e.phase === 'refused' })
      continue
    }
    if (run.kind !== e.kind || run.memberId !== e.memberId || JSON.stringify(run.cutoffs) !== JSON.stringify(e.cutoffs)) throw new RestoreRefusal('deletion_log_invalid', `${key}: its run's entries disagree`)
    run.lastAtMs = Math.max(run.lastAtMs, e.atMs)
    run.refused ||= e.phase === 'refused'
  }
  return [...runs.values()]
}

/** The stores a run reaches again: those whose own point is at or before the run's last entry. */
export const storesReached = (run: LoggedRun, candidates: readonly string[], pointOf: (store: string) => number): string[] =>
  candidates.filter(s => pointOf(s) <= run.lastAtMs)

/**
 * The first key to read: every entry at or after `watermarkMs` sorts after it (keys start with the 13-digit time, then
 * `-`, and `.` sorts after `-`). Undefined at 0: the whole log.
 */
export const watermarkStart = (watermarkMs: number): string | undefined =>
  watermarkMs === 0 ? undefined : `${LOG_PREFIX}${String(watermarkMs - 1).padStart(13, '0')}.`

type PersonStep =
  | { do: 'pseudonymise'; store: string }
  | { do: 'custom'; store: string; runner: PersonRunner }
  | { do: 'rows'; store: string; column: string }
  | { do: 'objects'; store: string; prefix: string }
type RetentionStep =
  | { do: 'age_rows'; store: string; ageColumn: string; idColumn: string; cutoffMs: number }
  | { do: 'age_objects'; store: string; cutoffMs: number }
type Planned = { run: LoggedRun; stores: string[]; steps: (PersonStep | RetentionStep)[] }

export interface ReplayDeps {
  bucket: R2Bucket
  target: D1Database
  at: At
  registry: readonly TableEntry[]
  deletion?: Readonly<Record<string, DeletionRule>>
  retention?: Readonly<Record<string, RetentionRule>>
  /** By store name: the runner of each custom store the replay can reach. A custom store without one refuses. */
  runners?: Readonly<Record<string, PersonRunner>>
}

function planPerson(deps: ReplayDeps, run: LoggedRun, stores: readonly string[]): PersonStep[] {
  const rules = deps.deletion ?? deletionRules
  const memberId = run.memberId as string
  const steps: PersonStep[] = []
  for (const name of stores) {
    const entry = deps.registry.find(e => e.name === name) as TableEntry
    const rule = rules[name]
    if (rule === undefined) throw new RestoreRefusal('replay_no_rule', name)
    if (!ALLOWED[entry.retention].includes(rule.action)) throw new RestoreRefusal('replay_rule_not_allowed', `${name}: ${rule.action}`)
    if (rule.action === 'keep' || rule.action === 'derived') continue
    if (rule.action === 'custom') {
      const runner = deps.runners?.[name]
      if (runner === undefined) throw new RestoreRefusal('replay_custom_unrun', `${name}'s rule is custom and its runner isn't built yet`)
      steps.push({ do: 'custom', store: name, runner })
    } else if (rule.action === 'pseudonymise') {
      if (!(entry.kind === 'd1' && name === 'members')) throw new RestoreRefusal('replay_rule_not_allowed', `${name}: pseudonymise`)
      steps.push({ do: 'pseudonymise', store: name })
    } else if (rule.action === 'delete_rows') {
      if (entry.kind !== 'd1') throw new RestoreRefusal('replay_rule_not_allowed', `${name}: delete_rows`)
      ident(name)
      steps.push({ do: 'rows', store: name, column: ident(rule.column) })
    } else {
      if (entry.kind !== 'r2') throw new RestoreRefusal('replay_rule_not_allowed', `${name}: delete_objects`)
      const prefix = personPrefix(entry, memberId)
      if (prefix === null) throw new RestoreRefusal('replay_rule_not_allowed', `${name}: no <memberId> pattern`)
      steps.push({ do: 'objects', store: name, prefix })
    }
  }
  return steps
}

function planRetention(deps: ReplayDeps, run: LoggedRun, stores: readonly string[]): RetentionStep[] {
  const rules = deps.retention ?? retentionRules
  const steps: RetentionStep[] = []
  for (const { store, cutoffMs } of run.cutoffs ?? []) {
    if (!stores.includes(store)) continue
    const rule = rules[store]
    if (rule === undefined) throw new RestoreRefusal('replay_no_rule', store)
    if (rule.kind === 'derived') continue
    if (rule.kind === 'custom') throw new RestoreRefusal('replay_custom_unrun', `${store}'s retention rule is custom and its job isn't built yet`)
    if (rule.kind === 'd1') steps.push({ do: 'age_rows', store: ident(store), ageColumn: ident(rule.ageColumn), idColumn: ident(rule.idColumn), cutoffMs })
    else steps.push({ do: 'age_objects', store, cutoffMs })
  }
  return steps
}

/** Rows one aging statement removes at most (by primary key), as retention's own rounds. */
const ROUND = 500

async function apply(deps: ReplayDeps, p: Planned): Promise<void> {
  const memberId = p.run.memberId as string
  const of = <K extends (PersonStep | RetentionStep)['do']>(k: K) => p.steps.filter((s): s is Extract<PersonStep | RetentionStep, { do: K }> => s.do === k)
  // Person deletion's order: the member row, the custom stores (the BrandAgent before the D1 batch), the rows, the objects.
  if (of('pseudonymise').length > 0) {
    const done = await memberStore({ db: deps.target }).pseudonymise(memberId, deps.at)
    // not_found: no row (a member added after the backup) or already pseudonymised; both leave nothing to do.
    if ('refused' in done && done.refused !== 'not_found') throw new RestoreRefusal('replay_stopped', `members: ${done.refused} (${memberId})`)
  }
  for (const s of of('custom')) {
    const done = await s.runner.deletePerson(memberId)
    if ('stop' in done) throw new RestoreRefusal('replay_stopped', `${s.store}: ${done.stop} (${memberId})`)
  }
  const rows = of('rows')
  if (rows.length > 0) await runBatch(deps.target, rows.map(r => stmt(`DELETE FROM ${r.store} WHERE ${r.column} = ?`, memberId)))
  for (const s of of('objects')) await deleteKeys(deps.bucket, (await listAll(deps.bucket, s.prefix)).map(o => o.key))
  for (const s of of('age_rows')) {
    for (;;) {
      const r = await deps.target.prepare(`DELETE FROM ${s.store} WHERE ${s.idColumn} IN (SELECT ${s.idColumn} FROM ${s.store} WHERE ${s.ageColumn} < ? ORDER BY ${s.idColumn} LIMIT ?)`)
        .bind(s.cutoffMs, ROUND).run()
      if (r.meta.changes < ROUND) break
    }
  }
  for (const s of of('age_objects')) await deleteKeys(deps.bucket, (await listAll(deps.bucket, s.store)).filter(o => o.uploaded.getTime() < s.cutoffMs).map(o => o.key))
}

/**
 * Replays the deletion log past the record's watermark onto the target, R2 and the Durable Objects. Throws a
 * `RestoreRefusal` (written nowhere: the caller records it) when the replay can't be planned or a step stops.
 */
export async function replayDeletionLog(deps: ReplayDeps, record: RestoreRecord): Promise<NonNullable<Reconcile['replay']>> {
  const d1Point = record.d1.restorePointMs
  const watermarkMs = record.watermarkMs
  if (d1Point === null || watermarkMs === null) throw new RestoreRefusal('record_invalid', 'no restore point')
  const recovered = new Map(record.durableObjects.map(d => [d.name, d.recoveredAtMs]))
  // A Durable Object a person deletion reaches must have a recorded recovery time, or the replay can't know its point.
  const rules = deps.deletion ?? deletionRules
  for (const e of deps.registry) {
    if (e.kind !== 'do') continue
    const rule = rules[e.name]
    if (rule !== undefined && rule.action !== 'keep' && !recovered.has(e.name)) throw new RestoreRefusal('do_recovery_unrecorded', e.name)
  }
  const pointOf = (store: string) => {
    const entry = deps.registry.find(e => e.name === store)
    if (!entry) throw new RestoreRefusal('replay_unknown_store', store)
    return entry.kind === 'do' ? (recovered.get(store) as number | undefined) ?? d1Point : d1Point
  }

  const listed = await listDeletionLog(deps.bucket, { after: watermarkStart(watermarkMs) })
  const runs = groupRuns(listed)
  const planned: Planned[] = []
  const skippedRefused: string[] = []
  for (const run of runs) {
    if (run.refused) { skippedRefused.push(run.runId); continue }
    if (run.kind === 'person') {
      const stores = storesReached(run, deps.registry.map(e => e.name), pointOf)
      planned.push({ run, stores, steps: planPerson(deps, run, stores) })
    } else {
      const cutoffStores = (run.cutoffs ?? []).map(c => c.store)
      for (const s of cutoffStores) pointOf(s)
      const stores = storesReached(run, cutoffStores, pointOf)
      planned.push({ run, stores, steps: planRetention(deps, run, stores) })
    }
  }
  for (const p of planned) await apply(deps, p)
  return {
    watermarkMs,
    throughKey: listed.length > 0 ? listed[listed.length - 1].key : null,
    runs: planned.map(p => ({ runId: p.run.runId, kind: p.run.kind, stores: p.stores })),
    skippedRefused,
  }
}
