// The privacy request record (migration 0601): one row per Shopify request, its audit line and the admins' bell notice
// in one D1 batch. The row insert skips on any of the table's keys (the webhook id, the body's SHA-256, or the same open
// request delivered by the brand's other app); the audit line and the notice are both inserted only when the row was,
// each guarded on this write's stamp, so a repeat of any kind writes nothing at all.
import { auditInsert } from '../../db/audit.ts'
import { SYSTEM_MEMBER_ID, writeStamp } from '../../db/ids.ts'
import { all, first, stmt, storage } from '../../db/sql.ts'
import type { Stmt } from '../../db/sql.ts'
import { checkNotice } from '../../notices/store.ts'
import { NOTICE_TEMPLATES } from '../../notices/templates.ts'
import { MAX_ORDER_IDS } from './payload.ts'
import type { ParsedRequest, PrivacyTopic } from './payload.ts'

export const DUE_MS = 30 * 86_400_000

/** The notice each topic gives the brand's admins (notices/templates.ts). */
export const NOTICE_FOR: Readonly<Record<PrivacyTopic, string>> = {
  'customers/data_request': 'privacy_data_request',
  'customers/redact': 'privacy_customer_redact',
  'shop/redact': 'privacy_shop_redact',
}

export interface PrivacyRequestInput {
  /** Shopify's X-Shopify-Webhook-Id, or `body:<sha256>` when the signed delivery carried none we could use. */
  webhookId: string
  /** The signed body's SHA-256, hex. */
  bodySha256: string
  topic: PrivacyTopic
  /** The ids the payload named, or null when Shopify signed a body that isn't the topic's shape (recorded unparsed). */
  parsed: ParsedRequest | null
}

export interface PrivacyRequestRow {
  id: string
  topic: PrivacyTopic
  parse_failed: 0 | 1
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
    /** Records the request once. `created`: false when any of the table's keys already held it. */
    async record(r: PrivacyRequestInput, at: { nowMs: number; requestId: string }): Promise<{ id: string; created: boolean }> {
      const id = await requestIdFor(r.webhookId)
      const stamp = writeStamp(at.requestId)
      const p = r.parsed
      const insert = stmt(
        `INSERT INTO privacy_requests (id, webhook_id, body_sha256, topic, parse_failed, shop_id, customer_id, order_ids_json, data_request_id, received_at_ms, due_at_ms, req_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        id, r.webhookId, r.bodySha256, r.topic, p ? 0 : 1, p?.shopId ?? null, p?.customerId ?? null, p?.orderIds ? JSON.stringify(p.orderIds) : null,
        p?.dataRequestId ?? null, at.nowMs, at.nowMs + DUE_MS, stamp,
      )
      const guard = { table: 'privacy_requests' as const, where: 'id = ?', params: [id], stamp }
      const line = auditInsert({
        atMs: at.nowMs, actorId: SYSTEM_MEMBER_ID, args: { action: 'privacy.requested', requestId: id, topic: r.topic, parsed: p !== null }, target: null, requestId: at.requestId,
      }, guard)
      // notices/store.ts's insert with the same checks, guarded like the line: a skipped row adds no notice either.
      const n = {
        id: `privacy-${id}`, audience: 'admins' as const, template: NOTICE_FOR[r.topic], fields: {}, icon: 'shield_lock', link: { to: 'page' as const, page: 'activity' as const }, atMs: at.nowMs,
      }
      const { t, link } = checkNotice(NOTICE_TEMPLATES, n)
      const notice = stmt(
        `INSERT INTO notices (id, audience, audience_member_id, template, fields_json, body, icon, person_id, at_ms, waiting, link_json, source)
         SELECT ?, ?, NULL, ?, ?, NULL, ?, NULL, ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM privacy_requests WHERE id = ? AND req_id = ?) ON CONFLICT (id) DO NOTHING`,
        n.id, n.audience, n.template, JSON.stringify(n.fields), n.icon, n.atMs, JSON.stringify(link), t.source, id, stamp,
      )
      const batch = [insert, line, notice]
      // A second delivery of an open request (the open-request index skipped its row) may name more orders: they join
      // the open row's list, deduped, sorted and capped at MAX_ORDER_IDS (skipped when this write's own row went in). Only on that index's own key: a request with
      // neither a customer nor a data request id has no key, and is never merged into another.
      if (p?.orderIds && p.orderIds.length > 0 && (p.customerId !== null || p.dataRequestId !== null)) {
        batch.push(stmt(
          `UPDATE privacy_requests SET order_ids_json = (
             SELECT json_group_array(v) FROM (
               SELECT value AS v FROM json_each(COALESCE(privacy_requests.order_ids_json, '[]')) UNION SELECT value FROM json_each(?) ORDER BY v LIMIT ?))
           WHERE status = 'open' AND parse_failed = 0 AND topic = ? AND shop_id = ? AND customer_id IS ? AND data_request_id IS ?
             AND NOT EXISTS (SELECT 1 FROM privacy_requests WHERE id = ? AND req_id = ?)`,
          JSON.stringify(p.orderIds), MAX_ORDER_IDS, r.topic, p.shopId, p.customerId, p.dataRequestId, id, stamp,
        ))
      }
      const results = await storage('D1', () => db.batch(batch.map(s => prepare(db, s))))
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
      return all<PrivacyRequestRow>(db, stmt("SELECT id, topic, parse_failed, status, received_at_ms, due_at_ms FROM privacy_requests WHERE status = 'open' ORDER BY received_at_ms, id"))
    },
  }
}

export type PrivacyRequestStore = ReturnType<typeof privacyRequestStore>
