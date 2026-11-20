// The deletion log (P8 design notes): what every person deletion and retention run removed, ids, keys and counts only
// (never a name, an email, a value or content: Q3's rule for the audit log). One immutable R2 object per entry (R2 has
// no append), `deletion-log/<atMs, 13 digits>-<runId>-<step, 4 digits>-<phase>.json`, so a listing sorts by time, a
// run's entries by their step (write order), and a replay after a restore (F1) starts after a watermark key. Outside
// the backup set, registered as `audit`: never shortened. Each entry's time is the clock when it's written, so a run
// made after a backup always sorts after that backup's watermark, however early it was planned. An entry is written
// once: a put onto an existing key fails.
import { z } from 'zod'
import { deletionLogKey } from '../../server/db/r2-keys.ts'
import { listAll } from './r2.ts'

const store = z.string().min(1)

export const deletionLogEntrySchema = z.strictObject({
  format: z.literal(1),
  runId: z.string().regex(/^[0-9a-f]{16}$/),
  /** The entry's place in its run: 0, 1, 2... in write order. */
  step: z.number().int().min(0).max(9999),
  /** `progress`: one bounded round of a retention run, with the ids or keys it removed. */
  phase: z.enum(['start', 'progress', 'done', 'refused']),
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

/**
 * Writes one entry (checked against the schema first), only if no object has its key (`etagDoesNotMatch: '*'`): an
 * entry is never overwritten. Returns its key; throws when the key was taken.
 */
export async function writeLogEntry(bucket: R2Bucket, entry: DeletionLogEntry): Promise<string> {
  const checked = deletionLogEntrySchema.parse(entry)
  const key = deletionLogKey(checked.atMs, checked.runId, checked.step, checked.phase)
  const put = await bucket.put(key, JSON.stringify(checked), { httpMetadata: { contentType: 'application/json' }, onlyIf: { etagDoesNotMatch: '*' } })
  if (put === null) throw new Error(`deletion log: ${key} exists already (an entry is written once)`)
  return key
}

type EntryBody = Omit<DeletionLogEntry, 'format' | 'runId' | 'step' | 'phase' | 'atMs'>

/**
 * One run's log: each write takes the run's next step (0, 1, 2... in write order) and the clock at that moment, never
 * earlier than the run's previous entry, so key order is write order within the run and time order across runs.
 */
export function runLog(bucket: R2Bucket, clock: () => number, base: EntryBody) {
  const runId = newRunId()
  let step = 0
  let last = 0
  return {
    runId,
    write(phase: DeletionLogEntry['phase'], extra: Partial<EntryBody> = {}): Promise<string> {
      last = Math.max(last, clock())
      return writeLogEntry(bucket, { format: 1, runId, step: step++, phase, atMs: last, ...base, ...extra })
    },
  }
}

/**
 * Every entry in key order (by time, then run id, then step), each parsed by the schema; `after` lists only the keys
 * after it (a replay's watermark), `limit` at most that many (a replay reads a page at a time). A key that isn't an entry, or an entry that doesn't parse, throws by key.
 */
export async function listDeletionLog(bucket: R2Bucket, opts: { after?: string; limit?: number } = {}): Promise<{ key: string; entry: DeletionLogEntry }[]> {
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) throw new Error('deletion log: limit must be a whole number, at least 1')
  const out: { key: string; entry: DeletionLogEntry }[] = []
  for (const obj of await listAll(bucket, 'deletion-log/', opts.after, opts.limit)) {
    const body = await bucket.get(obj.key)
    if (body === null) throw new Error(`deletion log: ${obj.key} vanished while listing`)
    const parsed = deletionLogEntrySchema.safeParse(JSON.parse(await body.text()))
    if (!parsed.success) throw new Error(`deletion log: ${obj.key} is not an entry (${parsed.error.issues.map(i => i.path.join('.')).join(', ')})`)
    if (deletionLogKey(parsed.data.atMs, parsed.data.runId, parsed.data.step, parsed.data.phase) !== obj.key) throw new Error(`deletion log: ${obj.key} doesn't match its entry`)
    out.push({ key: obj.key, entry: parsed.data })
  }
  return out
}
