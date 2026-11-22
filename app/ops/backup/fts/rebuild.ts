// The search index rebuild after a restore (P8 C1; acceptance 4, "rebuilds the search index"). The backup skips the
// derived FTS5 tables and the restore's target is freshly migrated, so it already has both indexes and their triggers,
// which fill them as the canonical rows go in. The rebuild makes each index exact whatever the triggers did, and
// FTS5's integrity check against its source proves it. In order:
//  1. read G1's restore record and refuse unless its status is `restored_unreconciled`;
//  2. check that the record's derived list, the registry's derived entries and P3's DERIVED_SEARCH_TABLES name the same
//     tables from the same sources (a string `from` read as a one-item list; shadows and `state` aside);
//  3. P3's `rebuildSearchIndexes(target)`, then `integrity-check` with rank 1 (compared with the source) on each index;
//  4. write `restore/<restoreId>/fts.json` in a `finally`. The state moves to `rebuilt` there, never in G1's record
//     (G1 writes that once, in its own `finally`; a second writer would race it).
// A refusal (steps 1 and 2) writes nothing. R's reconcile calls this first and reads fts.json before the outbox resumes.
// No C1 job drops or recreates a table: a runbook that uses D1's own export or Time Travel instead runs those steps
// (drop both virtual tables, export, recreate them from 0141 and 0142) and then `rebuildSearchIndexes`.
// FTS5 'rebuild', 'integrity-check' (rank 1 for an external content table): https://www.sqlite.org/fts5.html, read
// 2026-11-22.
import { restoreKey } from '../../../server/db/r2-keys.ts'
import { DERIVED_SEARCH_TABLES, rebuildSearchIndexes } from '../../../server/mcp/search-index.ts'
import type { DerivedSearchTable } from '../../../server/mcp/search-index.ts'
import { z } from 'zod'
import { tables as realRegistry } from '../../tables/index.ts'
import type { TableEntry } from '../../tables/types.ts'
import { RestoreRecordSchema } from '../manifest.ts'
import { ident } from '../tables.ts'

/** `restore/<restoreId>/fts.json`: each derived table's rebuild, its source's row count and its state. */
export const FtsRecordSchema = z.object({
  format: z.literal(1),
  restoreId: z.string().min(1),
  atMs: z.number().int().nonnegative(),
  tables: z.array(z.object({
    name: z.string().min(1),
    from: z.array(z.string().min(1)).min(1),
    /** The source's row count after the check; absent on a failed table. */
    sourceRows: z.number().int().nonnegative().optional(),
    state: z.enum(['rebuilt', 'failed']),
    error: z.string().optional(),
  })),
})
export type FtsRecord = z.infer<typeof FtsRecordSchema>

export interface RebuildDeps {
  bucket: R2Bucket
  /** The restored database (the record's target). */
  target: D1Database
  restoreId: string
  /** The record's time; defaults to the wall clock. */
  nowMs?: number
  /** Tests only: the registry and P3's list, to check the comparison. */
  registry?: readonly TableEntry[]
  searchTables?: readonly DerivedSearchTable[]
}

export type RebuildResult = { ok: FtsRecord } | { refused: string } | { failed: string }

type Derived = { name: string; from: string[] }
const normal = (list: readonly Derived[]) => JSON.stringify([...list].map(d => ({ name: d.name, from: [...d.from] })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
const names = (list: readonly Derived[]) => list.map(d => `${d.name}<-${d.from.join('+')}`).sort().join(', ')
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function rebuildAfterRestore(deps: RebuildDeps): Promise<RebuildResult> {
  const { bucket, target, restoreId } = deps
  // 1. The restore record.
  const obj = await bucket.get(restoreKey(restoreId, 'record.json'))
  if (!obj) return { refused: 'no_record' }
  const record = RestoreRecordSchema.parse(JSON.parse(await obj.text()))
  if (record.status !== 'restored_unreconciled') return { refused: `restore_status: ${record.status}` }

  // 2. Three lists, one set of indexes.
  const fromRecord: Derived[] = record.d1.derived.map(d => ({ name: d.name, from: d.from }))
  const fromRegistry: Derived[] = (deps.registry ?? realRegistry).filter(e => e.kind === 'd1' && e.derived).map(e => ({ name: e.name, from: [...(e.derived?.from ?? [])] }))
  const fromP3: Derived[] = (deps.searchTables ?? DERIVED_SEARCH_TABLES).map(t => ({ name: t.name, from: [t.from] }))
  if (normal(fromRecord) !== normal(fromRegistry) || normal(fromRecord) !== normal(fromP3)) {
    return { refused: `derived_mismatch: record [${names(fromRecord)}], registry [${names(fromRegistry)}], search-index [${names(fromP3)}]` }
  }

  // 3 and 4. The rebuild, the check, and the record whatever happens.
  const sorted = [...fromRecord].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const done = new Map<string, number>()
  let error: string | undefined
  let fts!: FtsRecord
  try {
    await rebuildSearchIndexes(target)
    for (const d of sorted) {
      await target.prepare(`INSERT INTO ${ident(d.name)}(${ident(d.name)}, rank) VALUES ('integrity-check', 1)`).run()
      const n = await target.prepare(`SELECT COUNT(*) AS n FROM ${ident(d.from[0])}`).first<{ n: number }>()
      if (!n) throw new Error(`no count from ${d.from[0]}`)
      done.set(d.name, n.n)
    }
  } catch (err) {
    error = messageOf(err)
  } finally {
    fts = FtsRecordSchema.parse({
      format: 1, restoreId, atMs: deps.nowMs ?? Date.now(),
      tables: sorted.map(d => (error === undefined
        ? { name: d.name, from: d.from, sourceRows: done.get(d.name) as number, state: 'rebuilt' }
        : { name: d.name, from: d.from, state: 'failed', error })),
    })
    await bucket.put(restoreKey(restoreId, 'fts.json'), JSON.stringify(fts), { httpMetadata: { contentType: 'application/json' } })
  }
  return error === undefined ? { ok: fts } : { failed: error }
}
