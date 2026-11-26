import { chatSessionsPrefix } from '../../db/r2-keys.ts'

interface Probe {
  [key: string]: SqlStorageValue
  chatId: string
  session: string
  sessionId: string | null
  checkpointEntries: number | null
  lastUuid: string | null
  lastUuidIndex: number | null
  state: string
  outcome: string | null
  failure: string | null
  runner: string | null
  fenced: number
  graceOver: number
  queryRan: number
  sawCheckpoint: number
  mirrorError: number
  openTokens: number
}

/** Draft-spike only. Return counts and checkpoint metadata, never transcript content or tokens. */
export async function crashResumeProbe(sql: SqlStorage, bucket: R2Bucket, turnId: string, recover: boolean, nowMs: number) {
  const rows = () => sql.exec<Probe>(`SELECT t.chat_id AS chatId, c.session, c.session_id AS sessionId,
    c.checkpoint_main_entries AS checkpointEntries, c.checkpoint_last_uuid AS lastUuid,
    c.checkpoint_last_uuid_index AS lastUuidIndex, t.state, t.outcome, t.failure, t.runner, t.fenced,
    COALESCE(t.grace_until_ms <= ?, 0) AS graceOver, t.query_ran AS queryRan, t.saw_checkpoint AS sawCheckpoint,
    t.mirror_error AS mirrorError,
    (SELECT COUNT(*) FROM run_tokens WHERE turn_id = t.turn_id AND revoked_at_ms IS NULL AND routes_open <> ',,') AS openTokens
    FROM turns t JOIN chat_state c ON c.chat_id = t.chat_id
    WHERE t.turn_id = ? AND t.text LIKE 'scenario:long-job% [w0-b-spike]%'`, nowMs, turnId).toArray()[0]
  let p = rows()
  if (!p) return null
  if (recover) {
    const changed = sql.exec(`UPDATE chat_state SET session = 'resumable', damaged_at_ms = NULL
      WHERE chat_id = ? AND session = 'damaged' AND checkpoint_main_entries >= 1
        AND NOT EXISTS (SELECT 1 FROM turns WHERE chat_id = ? AND state IN ('queued', 'starting', 'live', 'ending'))
        AND EXISTS (SELECT 1 FROM turns WHERE turn_id = ? AND text LIKE 'scenario:long-job-work [w0-b-spike]%'
          AND session_id = chat_state.session_id AND state = 'ended' AND failure = 'session_crashed'
          AND ((fenced = 1 AND grace_until_ms <= ?) OR fenced = 0) AND query_ran = 1 AND saw_checkpoint = 0 AND mirror_error = 0)
        AND NOT EXISTS (SELECT 1 FROM run_tokens WHERE turn_id = ? AND revoked_at_ms IS NULL AND routes_open <> ',,')
      RETURNING chat_id`, p.chatId, p.chatId, turnId, nowMs, turnId).toArray()
    if (changed.length !== 1) return null
    p = rows()!
  }
  let entries = 0
  let uuidAtCheckpoint: unknown = null
  if (p.sessionId !== null) {
    const prefix = `${chatSessionsPrefix(p.chatId)}${p.sessionId}/`
    const page = await bucket.list({ prefix, limit: 100 })
    if (page.truncated || page.objects.reduce((bytes, object) => bytes + object.size, 0) > 8 * 1024 * 1024) {
      throw new Error('spike transcript probe limit exceeded')
    }
    const keys = page.objects.map(o => o.key).filter(key => /^[a-f0-9]{64}\/m\/[^/]+\.json$/.test(key.slice(prefix.length))).sort()
    if (new Set(keys.map(key => key.slice(prefix.length, prefix.length + 64))).size > 1) throw new Error('spike found multiple main transcripts')
    for (const key of keys) {
      const object = await bucket.get(key)
      if (!object) throw new Error('spike transcript part disappeared')
      const batch = await object.json<{ uuid?: unknown }[]>()
      if (p.lastUuidIndex !== null && entries <= p.lastUuidIndex && p.lastUuidIndex < entries + batch.length) {
        uuidAtCheckpoint = batch[p.lastUuidIndex - entries]?.uuid ?? null
      }
      entries += batch.length
    }
  }
  return { ...p, entries, checkpointUuidMatches: uuidAtCheckpoint === p.lastUuid }
}
