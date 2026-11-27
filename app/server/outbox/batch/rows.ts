// A batch's rows (Stage 1 M3-B, N22): the item ids and the collecting key, the items' insert, the reads a card and the
// full list need, and the release of items' units back to a grant-backed batch's one use. Every write here is one
// statement that acts only where its caller's winning change left its stamp (sql.ts).
import { ACTION_ITEMS_PAGE, BATCH_FIRST_LINES } from '../../../shared/contract/actions.ts'
import type { ActionItemsPage } from '../../../shared/contract/actions.ts'
import { all, stmt } from '../../db/sql.ts'
import type { Stmt } from '../../db/sql.ts'
import type { ItemReleaseReason } from '../../permissions/policy.ts'
import type { Exists } from '../sql.ts'
import type { OutboxActionRow, OutboxItemRow } from '../types.ts'
import { FAILED_TEXT, needsCheckText, SENT_TEXT } from '../words.ts'

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
/** An item's id: `oi_` + 128 random bits, kept across moves. */
export const newItemId = (): string => `oi_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`

/** The collecting key (N22): operation, account, generation and scope key. One collecting batch per chat and key. */
export const coalesceKeyOf = (r: { operation: string; accountId: string; accountGen: number; scopeKey: string }): string =>
  `${r.operation}|${r.accountId}|${r.accountGen}|${r.scopeKey}`

/** The batch row's own `payload_hash`: never a call's, so no call's payload ever matches a batch's row. */
export const batchPayloadHash = (actionId: string): string => `batch:${actionId}`

/** One item to insert. */
export interface NewItem {
  itemId: string
  n: number
  toolUseId: string | null
  args: unknown
  payloadHash: string
  line: string
  records: number
  units: number
  movedFrom?: string | null
}

/**
 * The items' insert as one statement over a JSON list (D1 binds at most 100 parameters a statement; a call over the bulk
 * threshold has up to 100 items), only where `onlyIf` holds, only into a batch row, and never at a position an approval
 * of that batch covers (0770's move trigger states the same for a move; an insert has no trigger, so a restore can put
 * answered batches back).
 */
export function insertItemsStmt(actionId: string, chatId: string, items: readonly NewItem[], nowMs: number, onlyIf: Exists): Stmt {
  const list = items.map(i => ({
    id: i.itemId, n: i.n, tu: i.toolUseId, a: JSON.stringify(i.args), h: i.payloadHash, l: i.line, r: i.records, u: i.units, m: i.movedFrom ?? null,
  }))
  return stmt(
    `INSERT INTO outbox_items (item_id, action_id, n, chat_id, tool_use_id, args_json, payload_hash, line, records, units, moved_from,
       state, created_at_ms, updated_at_ms)
     SELECT json_extract(j.value, '$.id'), ?, json_extract(j.value, '$.n'), ?, json_extract(j.value, '$.tu'), json_extract(j.value, '$.a'),
       json_extract(j.value, '$.h'), json_extract(j.value, '$.l'), json_extract(j.value, '$.r'), json_extract(j.value, '$.u'),
       json_extract(j.value, '$.m'), 'pending', ?, ?
     FROM json_each(?) j
     WHERE EXISTS (SELECT 1 FROM outbox_actions a WHERE a.id = ? AND a.kind = 'batch'
         AND (a.approved_upto IS NULL OR json_extract(j.value, '$.n') > a.approved_upto))
       AND EXISTS (${onlyIf.sql})`,
    actionId, chatId, nowMs, nowMs, JSON.stringify(list), actionId, ...onlyIf.params,
  )
}

/**
 * Gives back the units of every item of `actionId` that `itemWhere` names (SQL over alias `i`, with its own params) from
 * the batch's one grant use, once per item (`permission_item_releases`), only where `onlyIf` holds and while the use is
 * unreleased. Inserts nothing for a batch with no grant. The item's state is always part of `itemWhere`, so an item that
 * went out is never given back. Run it before a statement that moves or renumbers the items (the key is the position the
 * use counted them at).
 */
export function releaseItemsStmt(p: {
  actionId: string; useRev: number; reason: ItemReleaseReason; atMs: number; itemWhere: { sql: string; params: readonly (string | number | null)[] }; onlyIf: Exists
}): Stmt {
  return stmt(
    `INSERT INTO permission_item_releases (id, action_id, action_rev, n, units, reason, at_ms)
     SELECT i.action_id || '#' || CAST(? AS INTEGER) || '#' || i.n, i.action_id, CAST(? AS INTEGER), i.n, i.units, ?, ?
     FROM outbox_items i
     WHERE i.action_id = ? AND (${p.itemWhere.sql})
       AND EXISTS (SELECT 1 FROM permission_uses u WHERE u.id = ? AND u.released_at_ms IS NULL)
       AND EXISTS (${p.onlyIf.sql})
     ON CONFLICT DO NOTHING`,
    p.useRev, p.useRev, p.reason, p.atMs, p.actionId, ...p.itemWhere.params, `${p.actionId}#${p.useRev}`, ...p.onlyIf.params,
  )
}

/** What a batch card shows beyond its row (N33): the first 10 lines. The totals and the count are the row's own. */
export interface BatchSummary { firstLines: string[] }

/** Each batch's first lines, by its id (one read for a page of cards). Positions in order, whatever their state. */
export async function batchSummaries(db: D1Database, ids: readonly string[]): Promise<Map<string, BatchSummary>> {
  const out = new Map<string, BatchSummary>()
  if (ids.length === 0) return out
  for (const id of ids) out.set(id, { firstLines: [] })
  // At most 50 ids a read: each is a bound parameter.
  for (let at = 0; at < ids.length; at += 50) {
    const part = ids.slice(at, at + 50)
    const rows = await all<{ action_id: string; line: string }>(db, stmt(
      `SELECT action_id, line FROM outbox_items WHERE action_id IN (${part.map(() => '?').join(', ')}) AND n <= ? ORDER BY action_id, n`,
      ...part, BATCH_FIRST_LINES,
    ))
    for (const r of rows) out.get(r.action_id)!.firstLines.push(r.line)
  }
  return out
}

/** One item's outcome in server words, once it has one. */
function itemResult(i: Pick<OutboxItemRow, 'state' | 'result_json'>): string | undefined {
  if (i.state === 'sent') {
    const ref = i.result_json ? (JSON.parse(i.result_json) as { ref?: unknown }).ref : undefined
    return typeof ref === 'string' && ref !== '' ? `${SENT_TEXT} ${ref}` : SENT_TEXT
  }
  if (i.state === 'failed') return FAILED_TEXT
  if (i.state === 'needs_check') return needsCheckText(i.result_json)
  return undefined
}

/** A page of a batch's items after position `after` (route 125). */
export async function itemsPage(db: D1Database, batch: Pick<OutboxActionRow, 'id'>, after: number): Promise<ActionItemsPage> {
  const rows = await all<Pick<OutboxItemRow, 'n' | 'line' | 'state' | 'result_json'>>(db, stmt(
    'SELECT n, line, state, result_json FROM outbox_items WHERE action_id = ? AND n > ? ORDER BY n LIMIT ?', batch.id, after, ACTION_ITEMS_PAGE + 1,
  ))
  const page = rows.slice(0, ACTION_ITEMS_PAGE)
  const more = rows.length > ACTION_ITEMS_PAGE
  return {
    items: page.map(r => {
      const result = itemResult(r)
      return { n: r.n, line: r.line, state: r.state, ...(result !== undefined ? { result } : {}) }
    }),
    ...(more ? { next: page.at(-1)!.n } : {}),
  }
}

/** An item by the call that made it (a collected call's replay), wherever it sits now. */
export const itemByCall = (chatId: string, toolUseId: string): Stmt =>
  stmt('SELECT * FROM outbox_items WHERE chat_id = ? AND tool_use_id = ?', chatId, toolUseId)
