// Phone: sort and file type live in one sheet, so the page keeps the search, the places and one list.
import { useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Button, ChoiceChips, IconButton } from '../../ui'
import { TAP } from '../../ui/fields'
import { NO_MOTION } from '../../ui/motion'
import { claimTrigger, keepForToast, restoreFocus } from '../../ui/dialogs'

const SORT_ICON: Record<string, string> = { Newest: 'schedule', Oldest: 'history', Name: 'sort_by_alpha', Size: 'straighten' }

export function FilterSheet<T extends string, S extends string>({ sort, sorts, onSort, tab, tabs, onTab, onClose }: {
  sort: S; sorts: S[]; onSort: (v: S) => void
  /** `[value, label, count, icon]` */
  tab: T; tabs: [T, string, number, string][]; onTab: (v: T) => void
  onClose: () => void
}) {
  const content = useRef<HTMLDivElement>(null)
  const before = useRef<HTMLElement | null>(null)
  const ids = useId()
  const group = (title: string, body: ReactNode) => (
    <section aria-labelledby={`${ids}-${title}`} className="flex flex-col gap-2.5">
      <h3 id={`${ids}-${title}`} className="mono-label">{title}</h3>
      {body}
    </section>
  )
  return (
    <Sheet open onOpenChange={o => { if (!o) onClose() }}>
      <SheetContent ref={content} side="bottom" showCloseButton={false} aria-describedby={undefined}
        overlayProps={{ className: NO_MOTION }}
        onOpenAutoFocus={e => { before.current = claimTrigger(); e.preventDefault(); content.current?.focus() }}
        onCloseAutoFocus={e => { e.preventDefault(); restoreFocus(before.current) }}
        onPointerDownOutside={keepForToast} onInteractOutside={keepForToast}
        data-surface="window"
        className={`gap-0 rounded-t-2xl border bg-window-surface px-5 pt-3.5 pb-6 shadow-menu ${NO_MOTION}`}>
        <div className="flex items-center gap-2 pb-3">
          <SheetTitle className="flex-1 text-xl font-semibold tracking-section">Filter files</SheetTitle>
          <IconButton icon="close" label="Close" onClick={onClose} className={TAP} />
        </div>
        <div className="flex flex-col gap-5">
          {group('Sort', <ChoiceChips label="Sort" value={sort} options={sorts.map(s => [s, s, SORT_ICON[s] ?? 'sort'] as [S, string, string])} onChange={onSort} />)}
          {group('Type', <ChoiceChips label="File type" value={tab} options={tabs.map(([k, t, n, icon]) => [k, `${t} ${n}`, icon] as [T, string, string])} onChange={onTab} />)}
        </div>
        <Button size="lg" className="mt-6 w-full" onClick={onClose}>Done</Button>
      </SheetContent>
    </Sheet>
  )
}
