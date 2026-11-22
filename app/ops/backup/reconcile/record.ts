// The restore record as the reconcile reads and writes it (`restore/<restoreId>/record.json`, ops/backup/manifest.ts).
import { restoreKey } from '../../../server/db/r2-keys.ts'
import { RestoreRefusal } from '../errors.ts'
import { RestoreRecordSchema } from '../manifest.ts'
import type { Reconcile, RestoreRecord } from '../manifest.ts'

export async function readRecord(bucket: R2Bucket, restoreId: string): Promise<RestoreRecord> {
  let key: string
  try { key = restoreKey(restoreId, 'record.json') } catch { throw new RestoreRefusal('record_missing', restoreId) }
  const obj = await bucket.get(key)
  if (!obj) throw new RestoreRefusal('record_missing', restoreId)
  return RestoreRecordSchema.parse(JSON.parse(await obj.text()))
}

/** Parses the record before it's written: a record the schema refuses (say `restored` without a step) is never stored. */
export async function writeRecord(bucket: R2Bucket, record: RestoreRecord): Promise<RestoreRecord> {
  const checked = RestoreRecordSchema.parse(record)
  await bucket.put(restoreKey(checked.restoreId, 'record.json'), JSON.stringify(checked), { httpMetadata: { contentType: 'application/json' } })
  return checked
}

export const emptyReconcile = (): Reconcile => ({ audit: null, outbox: 'p8b_pending', replay: null, confirm: null, refusal: null })
