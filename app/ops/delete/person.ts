// Person deletion (P8 acceptance 3, decision Q3): a plan (a dry run that writes nothing and counts), then a run that
// takes only that plan, recounts and refuses `plan_stale` if anything changed. The run, in order: (1) the deletion
// log's `start` entry; (2) P2's `pseudonymise` (its SQL guard refuses the last active Admin: a `refused` entry, then
// stop); (3) one D1 batch deleting the rows the person owns; (4) the R2 objects under their pattern; (5) the `done`
// entry with what was removed. Log first: a logged request that fails half way is finished by a re-run or F1's
// replay (every step is idempotent); a deletion that acted but never logged would come back after a restore.
// No audit line: `pseudonymise` writes none and the audit table is never written here. The deletion log is the record.
// C1 adds three custom parts, each a fixed runner: the chat cascade (chat-cascade.ts: the person's chats' objects, then
// their rows, children first), the bell's ordered delete (the person's member notices after their reads) and the
// BrandAgent's rows through `personData` (its `busy` refusal). With them the run is: the recount (a D1 or R2 difference
// refuses `plan_stale`, a BrandAgent one `busy`; nothing changes either way), `start`, `pseudonymise`, `personData`
// delete (`busy`: a `refused` entry, then stop; a re-run after the person's turns end finishes), the chat cascade's
// objects, one D1 batch (the `delete_rows` steps, then the notices, then the cascade's rows, children before parents),
// the objects under the person's pattern, `done`. personData's delete comes before the D1 batch: once it answers, no
// later D1 write for the person comes from the object (shapes.md personData r4).
// D1 batch (one transaction; meta.changes): https://developers.cloudflare.com/d1/worker-api/d1-database/ (read 2026-11-20)
import { memberStore } from '../../server/db/members.ts'
import type { MemberRow } from '../../server/db/members.ts'
import { first, runBatch, stmt } from '../../server/db/sql.ts'
import type { PersonDataAnswer } from '../../server/do/brand-agent/ports.ts'
import { CASCADE_R2, cascadeRowStatements, chatIds, countCascade, deleteCascadeObjects, outsideOwnChats, ownedBy } from '../coverage/chat-watch-connectors/chat-cascade.ts'
import type { TableEntry } from '../tables/types.ts'
import { runLog } from './log.ts'
import type { DeletionLogEntry } from './log.ts'
import { deleteKeys, ident, isMemberId, listAll, personPrefix, registryOf } from './r2.ts'
import type { JobDeps } from './r2.ts'
import { ALLOWED, deletionRules } from './rules.ts'
import type { DeletionRule } from './rules.ts'

export interface DeletionDeps extends JobDeps {
  /** Defaults to `deletionRules` (rules.ts); tests pass fixtures. */
  rules?: Readonly<Record<string, DeletionRule>>
}

/**
 * `busy`: the BrandAgent holds a live turn (or an unsettled hold, an unflushed final turn, a waiting chat) of the
 * person's; retried later, never forced. `outside_chats`: a message, tool call or chat file names the person in a chat
 * they don't own, which the cascade wouldn't remove.
 */
export type DeletionRefusal = 'bad_id' | 'not_found' | 'not_person' | 'last_admin' | 'busy' | 'outside_chats'

/** C1's custom rules, by the runner part that serves each store. A custom rule for any other store throws. */
const CUSTOM_PARTS: Readonly<Record<string, CustomPart>> = {
  chats: 'chat', chat_messages: 'chat', tool_calls: 'chat', chat_files: 'chat', 'files/': 'chat', 'sessions/': 'chat',
  BrandAgent: 'agent',
  notices: 'notices',
}
type CustomPart = 'chat' | 'agent' | 'notices'
/** The BrandAgent's counts go under `BrandAgent.<table>` in a plan's counts. */
const AGENT = 'BrandAgent.'

export interface PersonDeletionPlan {
  readonly memberId: string
  /** A run that pseudonymised the row and stopped: this plan finishes the rest. */
  readonly alreadyPseudonymised: boolean
  /** What the run will remove or pseudonymise, per store it acts on (`keep` stores aren't listed). */
  readonly counts: Readonly<Record<string, number>>
  readonly atMs: number
  readonly steps: readonly Step[]
  /** C1's custom parts the run does (none when absent). */
  readonly parts?: readonly CustomPart[]
}

type Step = { entry: TableEntry; rule: Extract<DeletionRule, { action: 'pseudonymise' | 'delete_rows' | 'delete_objects' }> }

/** Only plans made by `planPersonDeletion` run (no plan, no run). */
const issued = new WeakSet<PersonDeletionPlan>()

/** Every registered store's rule, checked against its class. Throws by store name on a gap. */
function stepsFor(registry: readonly TableEntry[], rules: Readonly<Record<string, DeletionRule>>): { steps: Step[]; parts: CustomPart[] } {
  const steps: Step[] = []
  const parts = new Set<CustomPart>()
  for (const entry of registry) {
    const rule = rules[entry.name]
    if (rule === undefined) throw new Error(`person deletion: no rule for ${entry.kind} store ${entry.name} (add one to ops/delete/rules.ts)`)
    if (!ALLOWED[entry.retention].includes(rule.action)) throw new Error(`person deletion: rule ${rule.action} isn't allowed for ${entry.name} (class ${entry.retention})`)
    // A derived index isn't a store of its own: its triggers follow its source's deletes. It takes a derived rule only.
    if (entry.derived && rule.action !== 'derived') throw new Error(`person deletion: ${entry.name} is derived: its rule must be derived`)
    if (rule.action === 'derived') {
      if (!entry.derived) throw new Error(`person deletion: ${entry.name} isn't derived, its rule is`)
      continue
    }
    if (rule.action === 'keep') continue
    // C1: a custom rule runs through its part's fixed runner; one with no runner refuses by name, so no run removes one
    // store's rows and leaves another's.
    if (rule.action === 'custom') {
      const part = CUSTOM_PARTS[entry.name]
      if (part === undefined) throw new Error(`person deletion: ${entry.name}'s rule is custom, and no runner serves it, so person deletion refuses to plan it`)
      parts.add(part)
      continue
    }
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
  return { steps, parts: [...parts].sort() }
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

/** The notices part: the person's member notices, and their reads that the `notice_reads` step (if any) leaves. */
function noticeStatements(memberId: string, readsStep: boolean) {
  const theirs = 'SELECT id FROM notices WHERE audience_member_id = ?'
  const readsWhere = `notice_id IN (${theirs})${readsStep ? ' AND member_id <> ?' : ''}`
  const readsParams = readsStep ? [memberId, memberId] : [memberId]
  return {
    count: [stmt(`SELECT COUNT(*) AS n FROM notice_reads WHERE ${readsWhere}`, ...readsParams), stmt('SELECT COUNT(*) AS n FROM notices WHERE audience_member_id = ?', memberId)],
    // Reads first: notice_reads references notices, and D1 enforces it per statement.
    run: [stmt(`DELETE FROM notice_reads WHERE ${readsWhere}`, ...readsParams), stmt('DELETE FROM notices WHERE audience_member_id = ?', memberId)],
  }
}
const readsStepIn = (steps: readonly Step[]) => steps.some(s => s.entry.name === 'notice_reads' && s.rule.action === 'delete_rows')

async function agentCounts(deps: DeletionDeps, memberId: string): Promise<Record<string, number>> {
  if (!deps.brandAgent) throw new Error('person deletion: the BrandAgent part needs deps.brandAgent (BrandAgentRpc.personData)')
  const answer: PersonDataAnswer = await deps.brandAgent.personData({ personId: memberId, mode: 'count' })
  if (!('counts' in answer)) throw new Error(`person deletion: personData count answered ${JSON.stringify(answer)}`)
  return Object.fromEntries(Object.entries(answer.counts).map(([t, n]) => [`${AGENT}${t}`, n]))
}

/** Every count the run acts on: the steps', then C1's parts'; or the reason the plan can't run. */
async function countAll(deps: DeletionDeps, steps: readonly Step[], parts: readonly CustomPart[], memberId: string, row: MemberRow): Promise<{ counts: Record<string, number> } | { refused: 'outside_chats'; outside: Record<string, number> }> {
  const counts = await countSteps(deps, steps, memberId, row)
  if (parts.includes('chat')) {
    const outside = await outsideOwnChats(deps.db, memberId)
    if (Object.keys(outside).length > 0) return { refused: 'outside_chats', outside }
    const scope = ownedBy(memberId)
    Object.assign(counts, await countCascade(deps.db, deps.bucket, scope, await chatIds(deps.db, scope)))
  }
  if (parts.includes('notices')) {
    const [reads, notices] = noticeStatements(memberId, readsStepIn(steps)).count
    const r = await first<{ n: number }>(deps.db, reads)
    const n = await first<{ n: number }>(deps.db, notices)
    if (!r || !n) throw new Error('person deletion: no count from notices')
    counts.notices = r.n + n.n
  }
  if (parts.includes('agent')) Object.assign(counts, await agentCounts(deps, memberId))
  return { counts }
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
  const { steps, parts } = stepsFor(registryOf(deps), deps.rules ?? deletionRules)
  const checked = await check(deps.db, input.memberId, true)
  if ('refused' in checked) return checked
  const counted = await countAll(deps, steps, parts, input.memberId, checked.row)
  if ('refused' in counted) return { refused: counted.refused }
  const plan: PersonDeletionPlan = Object.freeze({
    memberId: input.memberId,
    alreadyPseudonymised: checked.row.pseudonymised_at_ms !== null,
    counts: Object.freeze(counted.counts),
    atMs: deps.at.nowMs,
    steps: Object.freeze(steps),
    parts: Object.freeze(parts),
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
  afterStep?: (step: 'start' | 'pseudonymise' | 'agent' | 'cascade-objects' | 'rows' | 'objects') => Promise<void>
}

const sameCounts = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}
const only = (c: Readonly<Record<string, number>>, agent: boolean) => Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith(AGENT) === agent))

export async function runPersonDeletion(deps: DeletionDeps, plan: PersonDeletionPlan, testing: DeletionTesting = {}): Promise<PersonDeletionResult> {
  if (!issued.has(plan)) throw new Error('person deletion: runs only from a plan made by planPersonDeletion')
  const { db, bucket, at } = deps
  const { memberId, steps } = plan
  const parts = plan.parts ?? []
  const checked = await check(db, memberId, false)
  if ('refused' in checked) return checked
  const counted = await countAll(deps, steps, parts, memberId, checked.row)
  if ('refused' in counted) return { refused: counted.refused }
  const now = counted.counts
  if (!sameCounts(only(plan.counts, false), only(now, false)) || plan.alreadyPseudonymised !== (checked.row.pseudonymised_at_ms !== null)) return { refused: 'plan_stale', planned: plan.counts, now }
  // The BrandAgent's rows change while the person has a live turn (or a run token is pruned): retry later.
  if (!sameCounts(only(plan.counts, true), only(now, true))) return { refused: 'busy' }

  const log = runLog(bucket, deps.clock ?? Date.now, { kind: 'person', actorId: at.actorId, memberId })
  await log.write('start')
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
      await log.write('refused', { reason: done.refused })
      return { refused: done.refused }
    }
    removed.push({ store: e.name, count: 1 })
  }
  await testing.afterStep?.('pseudonymise')

  // C1: the BrandAgent's rows, before any D1 row (once personData's delete answers, no later D1 write for the person
  // comes from the object).
  if (parts.includes('agent')) {
    if (!deps.brandAgent) throw new Error('person deletion: the BrandAgent part needs deps.brandAgent (BrandAgentRpc.personData)')
    const answer = await deps.brandAgent.personData({ personId: memberId, mode: 'delete' })
    if ('busy' in answer) {
      // The member row is pseudonymised already: a distinct phase, so R's replay repeats the run (not `refused`).
      await log.write('stopped_after_pseudonymise', { reason: 'busy' })
      return { refused: 'busy' }
    }
    if (!('counts' in answer)) throw new Error(`person deletion: personData delete answered ${JSON.stringify(answer)}`)
    for (const [t, n] of Object.entries(answer.counts)) removed.push({ store: `${AGENT}${t}`, count: n })
  }
  await testing.afterStep?.('agent')

  // C1: the chat cascade's objects, before its rows (a re-run still finds the chats and lists their prefixes).
  if (parts.includes('chat')) {
    const objects = await deleteCascadeObjects(bucket, await chatIds(db, ownedBy(memberId)))
    for (const p of CASCADE_R2) removed.push({ store: p, keys: objects[p], count: objects[p].length })
  }
  await testing.afterStep?.('cascade-objects')

  // One batch, children before parents: the delete_rows steps (notice_reads before notices), the notices part, then
  // the cascade's rows (library marks, chat files, tool calls, messages, then the chats).
  const rowSteps = steps.filter(s => s.rule.action === 'delete_rows')
  const batch: { store: string; stmt: ReturnType<typeof stmt> }[] = rowSteps.map(({ entry: e, rule }) => ({
    store: e.name, stmt: stmt(`DELETE FROM ${ident(e.name)} WHERE ${ident((rule as { column: string }).column)} = ?`, memberId),
  }))
  if (parts.includes('notices')) for (const st of noticeStatements(memberId, readsStepIn(steps)).run) batch.push({ store: 'notices', stmt: st })
  if (parts.includes('chat')) batch.push(...cascadeRowStatements(ownedBy(memberId)))
  if (batch.length > 0) {
    // Each statement returns a row per row it deleted: D1's `meta.changes` counts rows its triggers changed too (the
    // search index's), so it isn't the store's count.
    const results = await runBatch(db, batch.map(b => ({ ...b.stmt, sql: `${b.stmt.sql} RETURNING 1 AS gone` })))
    const byStore = new Map<string, number>()
    batch.forEach((b, i) => byStore.set(b.store, (byStore.get(b.store) ?? 0) + results[i].results.length))
    for (const [store, count] of byStore) removed.push({ store, count })
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

  await log.write('done', { removed })
  return { ok: { runId: log.runId, removed: Object.fromEntries(removed.map(r => [r.store, r.count])) } }
}
