// What a row shows when the store's facts are on it (Stage 1 M3 card details, #555, #578): "#3901 · Alex Moore ·
// $642.10". Pure, so the card, its full list and the tests read the same words. The facts are the store's text, already
// cleaned by the server (server/outbox/detail.ts): shown as plain text in their own slots, never as Inhouse's words.
import type { ActionDetail, ActionDetailRow, ActionItemRow } from '../../../shared/contract/actions'

/**
 * A row as drawn. `ref`: the record (the order's name when the store gave it, else the server's own ref); `main`: who
 * (the customer) or what (the products), else the change; `sub`: the change under it when `main` took its place;
 * `amount`: the order's total or the row's own amount; `note`: a quiet line when the store couldn't be read.
 */
export interface RowView { ref: string; main: string; sub?: string; amount?: string; note?: string }

/** Said in a row for a record the store no longer has. */
export const NOT_IN_STORE = 'Not in the store now'

const isOrder = (r: ActionDetailRow) => r.ref.startsWith('Order ')
const productText = (r: ActionDetailRow) => `${r.quantity ?? 1} × ${r.notFound ? `${r.ref} (${NOT_IN_STORE.toLowerCase()})` : r.product ?? r.ref}`

/** An item's row with its detail (when it has one). */
export function rowView(row: ActionItemRow, detail?: ActionDetail | null): RowView {
  const plain: RowView = { ref: row.ref, main: row.change, ...(row.amount ? { amount: row.amount } : {}) }
  if (!detail) return plain
  if (detail.rows.length === 0) return detail.note ? { ...plain, note: detail.note } : plain
  const rows = detail.rows
  if (rows.every(isOrder)) {
    const who = rows.map(r => (r.notFound ? NOT_IN_STORE : r.customer)).filter((x): x is string => !!x)
    const amount = rows.length === 1 ? rows[0]!.amount ?? row.amount : row.amount
    return {
      ref: rows.map(r => r.order ?? r.ref).join(', '),
      main: who.length > 0 ? who.join(', ') : row.change,
      ...(who.length > 0 ? { sub: row.change } : {}),
      ...(amount ? { amount } : {}),
    }
  }
  // A draft order's lines: the products by name, the server's own words (ids, note, tags) under them.
  return { ref: row.ref, main: rows.map(productText).join(', '), sub: row.change, ...(row.amount ? { amount: row.amount } : {}) }
}

/**
 * A single card's detail as rows: one per order ("#1042 · Alex Moore · $642.10") or per draft line ("2 × Linen shirt, M"
 * with its SKU), or none when only the note is there (`detailNote`).
 */
export function detailRows(detail: ActionDetail): RowView[] {
  return detail.rows.map(r => (isOrder(r)
    ? { ref: r.order ?? r.ref, main: r.notFound ? NOT_IN_STORE : r.customer ?? '', ...(r.amount ? { amount: r.amount } : {}) }
    : { ref: '', main: productText(r), ...(r.sku ? { sub: r.sku } : {}) }))
}

/** The words a search over a row reads beyond the item's own: the order names, customers and products. */
export const detailWords = (detail?: ActionDetail | null): string[] =>
  detail ? detail.rows.flatMap(r => [r.order, r.customer, r.product, r.sku].filter((x): x is string => !!x)) : []
