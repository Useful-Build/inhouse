// One item of a batch as a row (Stage 1 M3-U design, N33): the record in mono, quiet; the change; its amount or quantity
// right-aligned when it has one; and a display-only detail (a name) before the change when the server sends one. The
// batch card's preview and its full list (BatchSheet) both draw it. Server words only.
import type { ReactNode } from 'react'
import type { ActionItemRow } from '../../../shared/contract/actions'

/** `children` sit under the change (an item's outcome, its answers when it needs a check). */
export function ItemRowView({ row, children, ...rest }: { row: ActionItemRow; children?: ReactNode } & Record<`data-${string}`, string | number>) {
  return (
    <li className="flex items-baseline gap-3 border-b border-divider py-2.25 text-sm last:border-b-0" data-row {...rest}>
      {row.ref && <span className="min-w-12 flex-none font-mono text-xs text-muted-foreground">{row.ref}</span>}
      <div className="min-w-0 flex-1">
        <div className="leading-prose wrap-anywhere">
          {row.detail && <span className="text-foreground">{row.detail}<span className="text-muted-foreground"> · </span></span>}
          {row.change}
        </div>
        {children}
      </div>
      {row.amount && <span className="flex-none text-foreground-2 tabular-nums">{row.amount}</span>}
    </li>
  )
}
