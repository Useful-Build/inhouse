// What R's deletion-log replay (ops/backup/reconcile/replay.ts) needs from C1 to repeat C1's deletions after a restore
// (#346 review H1). Reconcile calls a retention run's custom stores through `replayRetention`, and a person
// run's chat cascade and bell through `personRunners` (R's `PersonRunner` shape; the BrandAgent's runner is R's own
// `brandAgentRunner`). Both apply rules, never logged row ids, so each is idempotent and safe to repeat.
import type { KeyedBucket } from '../../../server/db/r2-keys.ts'
import { runBatch, stmt } from '../../../server/db/sql.ts'
import type { PersonRunner } from '../../backup/reconcile/replay.ts'
import { deleteChatRows, quietChats } from './brand-agent-storage.ts'
import { cascadeRowStatements, chatIds, deleteCascadeObjects, ownedBy } from './chat-cascade.ts'
import { MAX_LIMIT, RETENTION_JOBS, SERVED_BY } from './retention-jobs.ts'
import type { AgeTag, LoggedCutoff } from './retention-jobs.ts'

/**
 * Repeats `store`'s custom retention job at the cutoffs one logged run wrote for it (`age` tags included), in rounds
 * until nothing is left past them: no limit, no clock. A store another store's job serves replays as nothing (that
 * job's store carries the cutoffs). Throws by name on a store with no job, or a cutoff the job needs and the log lacks.
 */
export async function replayRetention(store: string, deps: { db: D1Database; bucket: KeyedBucket; sql?: SqlStorage }, cutoffs: readonly Omit<LoggedCutoff, 'store'>[]): Promise<Record<string, number>> {
  const job = RETENTION_JOBS[store]
  if (job === undefined) {
    if (SERVED_BY[store] !== undefined) return {}
    throw new Error(`replay: ${store} has no retention job`)
  }
  const fixed = Object.fromEntries(cutoffs.map(c => [c.age ?? 'own', c.cutoffMs])) as Partial<Record<AgeTag, number>>
  // The chat job checks each id twice in its BrandAgent safety query.
  const limit = store === 'chats' && deps.sql ? Math.floor(MAX_LIMIT / 2) : MAX_LIMIT
  const ctx = { db: deps.db, bucket: deps.bucket, sql: deps.sql, atMs: null, cutoffMs: fixed.own ?? null, cutoffs: fixed, limit }
  const removed: Record<string, number> = {}
  for (;;) {
    const plan = await job.plan(ctx)
    if (plan.units.length === 0) break
    const got = await job.run(ctx, plan, async () => {})
    for (const [s, n] of Object.entries(got)) removed[s] = (removed[s] ?? 0) + n
    if (!plan.more) break
  }
  return removed
}

/** Reapply the object side of one logged chat cascade round, even if D1 has already lost those chats. */
export function replayChatRows(sql: SqlStorage, ids: readonly string[]): boolean {
  if (quietChats(sql, ids).length !== ids.length) return false
  deleteChatRows(sql, ids)
  return true
}

/**
 * C1's custom person-deletion parts as R's runners, by store: `chats` runs the chat cascade over the person's own chats
 * (objects first, then one batch, children first); the stores the cascade serves answer nothing done; `notices` deletes
 * the person's member notices after all their reads. `ok` counts rows and objects removed.
 */
export function personRunners(deps: { db: D1Database; bucket: KeyedBucket }): Readonly<Record<string, PersonRunner>> {
  const served: PersonRunner = { async deletePerson() { return { ok: 0 } } }
  return {
    chats: {
      async deletePerson(memberId) {
        const objects = await deleteCascadeObjects(deps.bucket, await chatIds(deps.db, ownedBy(memberId)))
        const results = await runBatch(deps.db, cascadeRowStatements(ownedBy(memberId)).map(b => ({ ...b.stmt, sql: `${b.stmt.sql} RETURNING 1 AS gone` })))
        return { ok: objects['files/'].length + objects['sessions/'].length + results.reduce((n, r) => n + r.results.length, 0) }
      },
    },
    chat_messages: served,
    tool_calls: served,
    chat_files: served,
    'files/': served,
    'sessions/': served,
    notices: {
      async deletePerson(memberId) {
        const theirs = 'SELECT id FROM notices WHERE audience_member_id = ?'
        const results = await runBatch(deps.db, [
          stmt(`DELETE FROM notice_reads WHERE notice_id IN (${theirs}) RETURNING 1 AS gone`, memberId),
          stmt('DELETE FROM notices WHERE audience_member_id = ? RETURNING 1 AS gone', memberId),
        ])
        return { ok: results.reduce((n, r) => n + r.results.length, 0) }
      },
    },
  }
}
