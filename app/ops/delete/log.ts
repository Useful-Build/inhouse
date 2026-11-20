// The deletion log (P8 design notes): what every person deletion and retention run removed, ids, keys and counts only
// (never a name, an email, a value or content: Q3's rule for the audit log). One immutable R2 object per entry (R2 has
// no append), `deletion-log/<atMs, 13 digits>-<runId>-<step, 4 digits>-<phase>.json`, so a listing sorts by time, a
// run's entries by their step (write order), and a replay after a restore (F1) starts after a watermark key. Outside
// the backup set, registered as `audit`: never shortened.
import { z } from 'zod'
import { deletionLogKey } from '../../server/db/r2-keys.ts'
import { listAll } from './r2.ts'

const store = z.string().min(1)

export const deletionLogEntrySchema = z.strictObject({
  format: z.literal(1),
  runId: z.string().regex(/^[0-9a-f]{16}$/),
  /** The entry's place in its run: 0, 1, 2... in write order. */
  step: z.number().int().min(0).max(9999),
  phase: z.enum(['start', 'done', 'refused']),
  kind: z.enum(['person', 'retention']),
  atMs: z.number().int().nonnegative(),
  /** Always a member id (the job's `at.actorId`). */
  actorId: z.string().min(1),
  /** A person deletion's member id: what a replay deletes again. */
  memberId: z.string().regex(/^m_[A-Za-z0-9_-]+$/).optional(),
  /** A retention run's cutoff per store: what a replay applies again. */
  cutoffs: z.array(z.strictObject({ store, cutoffMs: z.number().int() })).optional(),
  removed: z.array(z.strictObject({ store, ids: z.array(z.string()).optional(), keys: z.array(z.string()).optional(), count: z.number().int().nonnegative() })).optional(),
  /** A `refused` entry's reason (a refusal code, never content). */
  reason: z.string().regex(/^[a-z_]+$/).optional(),
})

export type DeletionLogEntry = z.infer<typeof deletionLogEntrySchema>

/** 16 random hex characters. */
export const newRunId = (): string => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('')

/** Writes one entry (checked against the schema first). Returns its key. */
export async function writeLogEntry(bucket: R2Bucket, entry: DeletionLogEntry): Promise<string> {
  const checked = deletionLogEntrySchema.parse(entry)
  const key = deletionLogKey(checked.atMs, checked.runId, checked.step, checked.phase)
  await bucket.put(key, JSON.stringify(checked), { httpMetadata: { contentType: 'application/json' } })
  return key
}

/**
 * Every entry in key order (by time, then run id, then step), each parsed by the schema; `after` lists only the keys
 * after it (a replay's watermark). A key that isn't an entry, or an entry that doesn't parse, throws by key.
 */
export async function listDeletionLog(bucket: R2Bucket, opts: { after?: string } = {}): Promise<{ key: string; entry: DeletionLogEntry }[]> {
  const out: { key: string; entry: DeletionLogEntry }[] = []
  for (const obj of await listAll(bucket, 'deletion-log/', opts.after)) {
    const body = await bucket.get(obj.key)
    if (body === null) throw new Error(`deletion log: ${obj.key} vanished while listing`)
    const parsed = deletionLogEntrySchema.safeParse(JSON.parse(await body.text()))
    if (!parsed.success) throw new Error(`deletion log: ${obj.key} is not an entry (${parsed.error.issues.map(i => i.path.join('.')).join(', ')})`)
    if (deletionLogKey(parsed.data.atMs, parsed.data.runId, parsed.data.step, parsed.data.phase) !== obj.key) throw new Error(`deletion log: ${obj.key} doesn't match its entry`)
    out.push({ key: obj.key, entry: parsed.data })
  }
  return out
}
