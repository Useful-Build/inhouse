// The restore record as the reconcile reads and writes it (`restore/<restoreId>/record.json`, ops/backup/manifest.ts).
import { restoreKey } from '../../../server/db/r2-keys.ts'
import { RestoreRefusal } from '../errors.ts'
import { RestoreRecordSchema } from '../manifest.ts'
import type { Reconcile, RestoreRecord } from '../manifest.ts'

/** The record and its etag: a write goes through only while the record is still the one read (`writeRecord`). */
export interface ReadRecord { record: RestoreRecord; etag: string }

export async function readRecord(bucket: R2Bucket, restoreId: string): Promise<ReadRecord> {
  let key: string
  try { key = restoreKey(restoreId, 'record.json') } catch { throw new RestoreRefusal('record_missing', restoreId) }
  const obj = await bucket.get(key)
  if (!obj) throw new RestoreRefusal('record_missing', restoreId)
  const raw = JSON.parse(await obj.text()) as Record<string, unknown>
  // A record written before the reconcile existed (G1's shape) is refused by name, never as a schema error.
  if (raw === null || typeof raw !== 'object' || !('reconcile' in raw)) throw new RestoreRefusal('record_pre_reconcile', restoreId)
  const parsed = RestoreRecordSchema.safeParse(raw)
  if (!parsed.success) throw new RestoreRefusal('record_invalid', parsed.error.issues.map(i => i.path.join('.')).join(', '))
  return { record: parsed.data, etag: obj.etag }
}

/**
 * Parses the record before it's written (a record the schema refuses, say `restored` without a step, is never stored),
 * then writes it only if the stored record still has `etag` (R2's conditional put, `onlyIf: { etagMatches }`, which
 * answers null when the condition fails: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/, read
 * 2026-11-22). So a concurrent reconcile can't write over a confirm, or flip `restored` back: it refuses
 * `record_changed` and is run again.
 */
export async function writeRecord(bucket: R2Bucket, record: RestoreRecord, etag: string): Promise<RestoreRecord> {
  const checked = RestoreRecordSchema.parse(record)
  const put = await bucket.put(restoreKey(checked.restoreId, 'record.json'), JSON.stringify(checked), { httpMetadata: { contentType: 'application/json' }, onlyIf: { etagMatches: etag } })
  if (put === null) throw new RestoreRefusal('record_changed', checked.restoreId)
  return checked
}

export const emptyReconcile = (): Reconcile => ({ fts: null, audit: null, members: null, outbox: null, replay: null, confirm: null, refusal: null })
