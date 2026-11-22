// The privacy request record (migration 0601): one row per Shopify delivery, its audit line and the admins' bell notice
// in one D1 batch. A retry of the same delivery (the same X-Shopify-Webhook-Id) has the same request id, so its row
// insert, its audit line (guarded on this write's stamp) and its notice (ON CONFLICT (id)) all write nothing.
import { auditInsert } from '../../db/audit.ts'
import { SYSTEM_MEMBER_ID, writeStamp } from '../../db/ids.ts'
import { all, first, stmt, storage } from '../../db/sql.ts'
import type { Stmt } from '../../db/sql.ts'
import { noticeInsert } from '../../notices/store.ts'
import { NOTICE_TEMPLATES } from '../../notices/templates.ts'
import type { PrivacyTopic } from './payload.ts'

export const DUE_MS = 30 * 86_400_000

/** The notice each topic gives the brand's admins (notices/templates.ts). */
export const NOTICE_FOR: Readonly<Record<PrivacyTopic, string>> = {
  'customers/data_request': 'privacy_data_request',
  'customers/redact': 'privacy_customer_redact',
  'shop/redact': 'privacy_shop_redact',
}

export interface PrivacyRequestInput {
  webhookId: string
  topic: PrivacyTopic
  shopId: number
  customerId: string | null
  orderIds: readonly number[] | null
  dataRequestId: string | null
}

export interface PrivacyRequestRow {
  id: string
  topic: PrivacyTopic
  status: 'open' | 'closed'
  received_at_ms: number
  due_at_ms: number
}

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

/** `pr_` + the first 128 bits of SHA-256 over Shopify's webhook id: a retry of one delivery maps to one request. */
export async function requestIdFor(webhookId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`shopify-webhook:${webhookId}`)))
  return `pr_${base64url(digest.slice(0, 16))}`
}

const prepare = (db: D1Database, s: Stmt): D1PreparedStatement => db.prepare(s.sql).bind(...s.params)

export function privacyRequestStore(db: D1Database) {
  return {
    /** Records the request (once per webhook id). `created`: false on a retry of a delivery already recorded. */
    async record(r: PrivacyRequestInput, at: { nowMs: number; requestId: string }): Promise<{ id: string; created: boolean }> {
      const id = await requestIdFor(r.webhookId)
      const stamp = writeStamp(at.requestId)
      const insert = stmt(
        `INSERT INTO privacy_requests (id, webhook_id, topic, shop_id, customer_id, order_ids_json, data_request_id, received_at_ms, due_at_ms, req_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        id, r.webhookId, r.topic, r.shopId, r.customerId, r.orderIds === null ? null : JSON.stringify(r.orderIds), r.dataRequestId,
        at.nowMs, at.nowMs + DUE_MS, stamp,
      )
      const line = auditInsert({
        atMs: at.nowMs, actorId: SYSTEM_MEMBER_ID, args: { action: 'privacy.requested', requestId: id, topic: r.topic }, target: null, requestId: at.requestId,
      }, { table: 'privacy_requests', where: 'id = ?', params: [id], stamp })
      const notice = noticeInsert(db, NOTICE_TEMPLATES, {
        id: `privacy-${id}`, audience: 'admins', template: NOTICE_FOR[r.topic], fields: {}, icon: 'shield_lock', link: { to: 'page', page: 'activity' }, atMs: at.nowMs,
      })
      const results = await storage('D1', () => db.batch([prepare(db, insert), prepare(db, line), notice]))
      return { id, created: (results[0].meta.changes ?? 0) > 0 }
    },

    /**
     * Closes an open request once the Inhouse team has acted on it: clears the Shopify ids it named and writes
     * `privacy.closed`. `not_found` for an unknown id, `already_closed` for a closed one (no line).
     */
    async close(id: string, at: { nowMs: number; requestId: string }): Promise<'closed' | 'already_closed' | 'not_found'> {
      const row = await first<{ topic: PrivacyTopic; status: string }>(db, stmt('SELECT topic, status FROM privacy_requests WHERE id = ?', id))
      if (!row) return 'not_found'
      if (row.status !== 'open') return 'already_closed'
      const stamp = writeStamp(at.requestId)
      const update = stmt(
        `UPDATE privacy_requests SET status = 'closed', closed_at_ms = ?, customer_id = NULL, order_ids_json = NULL, data_request_id = NULL, req_id = ?
         WHERE id = ? AND status = 'open'`,
        at.nowMs, stamp, id,
      )
      const line = auditInsert({
        atMs: at.nowMs, actorId: SYSTEM_MEMBER_ID, args: { action: 'privacy.closed', requestId: id, topic: row.topic, by: 'release' }, target: null, requestId: at.requestId,
      }, { table: 'privacy_requests', where: 'id = ?', params: [id], stamp })
      const results = await storage('D1', () => db.batch([prepare(db, update), prepare(db, line)]))
      return (results[0].meta.changes ?? 0) > 0 ? 'closed' : 'already_closed'
    },

    /** The open requests, oldest first (ids, topics and dates only), for the health signal. */
    async open(): Promise<PrivacyRequestRow[]> {
      return all<PrivacyRequestRow>(db, stmt("SELECT id, topic, status, received_at_ms, due_at_ms FROM privacy_requests WHERE status = 'open' ORDER BY received_at_ms, id"))
    },
  }
}

export type PrivacyRequestStore = ReturnType<typeof privacyRequestStore>
