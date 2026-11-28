// One item of a batch as a row (Stage 1 M3-U design, N33): the record in mono, quiet; the change; its amount or quantity
// right-aligned when it has one. The batch card's preview and its full list (BatchSheet) both draw it. With the store's
// facts on the item (Stage 1 M3 card details, #555, #578), the record is the order's own name and the row reads
// "#3901 · Alex Moore · $642.10": the customer takes the change's place and the change sits quietly under it; a draft
// order's row names its products. The facts are plain text in their own slots (item-detail.ts).
import type { ReactNode } from 'react'
import type { ActionDetail, ActionItemRow } from '../../../shared/contract/actions'
import { rowView } from './item-detail'
import type { RowView } from './item-detail'

/** `children` sit under the change (an item's outcome, its answers when it needs a check). */
export function ItemRowView({ row, detail, children, ...rest }: { row: ActionItemRow; detail?: ActionDetail | null; children?: ReactNode } & Record<`data-${string}`, string | number>) {
  return <RowLine view={rowView(row, detail)} {...rest}>{children}</RowLine>
}

/** A row as drawn (a batch item, or one of a single card's detail rows). */
export function RowLine({ view, children, ...rest }: { view: RowView; children?: ReactNode } & Record<`data-${string}`, string | number>) {
  return (
    <li className="flex items-baseline gap-3 border-b border-divider py-2.25 text-sm last:border-b-0" data-row {...rest}>
      {view.ref && <span className="min-w-12 flex-none font-mono text-xs text-muted-foreground" data-row-ref>{view.ref}</span>}
      <div className="min-w-0 flex-1">
        <div className="leading-prose wrap-anywhere" data-row-main>{view.main}</div>
        {view.sub && <div className="mt-0.5 text-xs text-muted-foreground wrap-anywhere" data-row-sub>{view.sub}</div>}
        {view.note && <div className="mt-0.5 text-xs text-muted-foreground" data-row-note>{view.note}</div>}
        {children}
      </div>
      {view.amount && <span className="flex-none text-foreground-2 tabular-nums" data-row-amount>{view.amount}</span>}
    </li>
  )
}
