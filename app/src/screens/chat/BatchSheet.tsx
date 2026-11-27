// A batch's full list (Stage 1 M3-U, N22, N33), opened from its card's "See all": a side panel on desktop, a bottom sheet
// on a phone. Its rows are read 100 at a time through route 125 as the list scrolls to its end (all at once while a
// search is typed, so the search covers every item), up to the count the card showed; each row shows its outcome once it
// has one. A search filters the rows read so far, on the server's own words. Loaded with its first opening (AskCard's
// lazy import), outside Today's first load.
//  - Approve what you saw: the sheet keeps the card as it was when it opened (`opened`). Its Approve names that card's
//    count, its footer that card's totals, and the answer carries exactly those (AskCard `send`), however many items join
//    while it's open. Items past that count aren't listed; one quiet line says how many arrived and that they wait.
//  - A batch that needs a check is settled here, one unclear item at a time, at the live card's rev.
// The live card (`card`) decides whether an answer is still possible: once it isn't waiting, the buttons go.
import { useEffect, useRef, useState } from 'react'
import { agent } from '../../agent'
import type { ActionCard, ActionItem, ActionResolution } from '../../agent/types'
import { NEEDS_CHECK } from '../../../shared/contract/action-states'
import { useUi } from '../../state/store'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { Button, IconButton } from '../../ui'
import { SearchBox, TAP } from '../../ui/fields'
import { NO_MOTION } from '../../ui/motion'
import { claimTrigger, keepForToast, restoreFocus } from '../../ui/dialogs'
import { fmtCount } from '../../lib/format'
import { display } from '../../state/display'
import { buttonsOf, coversText, isTable, itemStatus, moreArrivedText, refusalOf, searchLabel, subtitleOf, tableTotal } from './ask-card'
import type { CardButton, Whose } from './ask-card'
import { ItemRowView } from './ItemRow'

export interface BatchSheetProps {
  /** The card as it is now. */
  card: ActionCard
  /** The card as it was when the list opened: what its answer covers. */
  opened: ActionCard
  whose: Whose
  busy: boolean
  /** The last answer's refusal, in words (shown here while the sheet is open). */
  refusal: string | null
  onClose: () => void
  /** The most items the list saw on this batch (pages past the opened count included). */
  onSawTip: (n: number) => void
  onAnswer: (b: CardButton) => void
  onResolve: (outcome: ActionResolution, n: number) => void
}

/** What has been read: the items up to the shown count, where the next page starts (null once all are in), and past it. */
interface Read { items: ActionItem[]; next: number | null; past: number; error: string | null; busy: boolean }
const START: Read = { items: [], next: 0, past: 0, error: null, busy: false }

/** A search over a row's own words: its record, its change, its amount and its full line. */
const matches = (it: ActionItem, q: string) => [it.row.ref, it.row.change, it.row.amount ?? '', it.line].some(t => t.toLowerCase().includes(q))

export function BatchSheet({ card, opened, whose, busy, refusal, onClose, onSawTip, onAnswer, onResolve }: BatchSheetProps) {
  const phone = useUi(s => s.phone)
  const tap = phone ? TAP : undefined
  const before = useRef<HTMLElement | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  // The list's last line, once the sheet has drawn it (the sheet's content mounts after this component does).
  const [end, setEnd] = useState<HTMLDivElement | null>(null)
  const waiting = opened.state === 'waiting'
  // A waiting batch lists what the opened card showed; any other lists every item it has now.
  const shownCard = waiting ? opened : card
  const batch = shownCard.batch!
  const shown = batch.itemCount
  // Read again from the start when the live card moves on (an answer, an item settled, the send), never for items
  // joining a waiting one (its rev doesn't move).
  const readRev = waiting ? opened.rev : card.rev
  const [read, setRead] = useState<Read>(START)
  const [query, setQuery] = useState('')
  const [atEnd, setAtEnd] = useState(false)
  const onSaw = useRef(onSawTip)
  useEffect(() => { onSaw.current = onSawTip })
  const gen = useRef(0)

  useEffect(() => { gen.current++; setRead(START) }, [card.id, readRev, shown])

  // The next page, when the list's end shows, a search wants every item, or the scroll can't reach (no observer).
  const want = read.next !== null && !read.busy && read.error === null && (atEnd || query.trim() !== '' || typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (!want || read.next === null) return
    const mine = gen.current
    const after = read.next
    setAtEnd(false)
    setRead(r => ({ ...r, busy: true }))
    agent.actionItems(card.id, after).then(page => {
      if (gen.current !== mine) return
      setRead(r => {
        const items = [...r.items]
        let past = r.past
        for (const it of page.items) {
          if (it.n <= shown) items.push(it)
          else past = Math.max(past, it.n - shown)
        }
        const next = page.next === undefined || page.next >= shown ? null : page.next
        if (next === null) onSaw.current(shown + past)
        return { items, next, past, error: null, busy: false }
      })
    }, (e: unknown) => { if (gen.current === mine) setRead(r => ({ ...r, busy: false, error: refusalOf(e).text })) })
  }, [want, read.next, card.id, shown])

  // The list's end in view asks for the next page.
  // Watched afresh after each page, so its first report says whether the end still shows (a short list asks again).
  const pages = read.items.length
  useEffect(() => {
    if (!end || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(entries => setAtEnd(entries.some(e => e.isIntersecting)))
    io.observe(end)
    return () => io.disconnect()
  }, [end, pages])

  const q = query.trim().toLowerCase()
  const rows = q ? read.items.filter(it => matches(it, q)) : read.items
  // Items that joined after it opened: from the pages, or from a newer read of the card.
  const past = Math.max(read.past, waiting && card.state === 'waiting' ? (card.batch?.itemCount ?? 0) - shown : 0)
  const answers = waiting && card.state === 'waiting' ? buttonsOf(opened).filter(b => b.kind === 'answer') : []
  const resolving = card.state === NEEDS_CHECK && card.can.resolve
  const count = fmtCount(shown, display())
  const sub = subtitleOf(card, whose)
  // A page is on its way (between pages nothing shows: the next one loads as the list's end comes into view).
  const loading = read.busy
  const complete = read.next === null

  return (
    <Sheet open onOpenChange={o => { if (!o) onClose() }}>
      <SheetContent ref={panel} side={phone ? 'bottom' : 'right'} showCloseButton={false} aria-describedby={undefined}
        onPointerDownOutside={keepForToast} onInteractOutside={keepForToast}
        overlayProps={{ className: NO_MOTION }}
        onOpenAutoFocus={e => { before.current = claimTrigger(); e.preventDefault(); panel.current?.focus() }}
        onCloseAutoFocus={e => { e.preventDefault(); if (document.activeElement === document.body) restoreFocus(before.current) }}
        data-surface="window" data-batch-sheet
        className={cn('gap-0 overflow-hidden rounded-2xl border bg-window-surface shadow-menu', NO_MOTION, phone ? 'inset-x-2.5 bottom-2.5 h-auto max-h-window-max w-auto' : 'inset-y-2.5 right-2.5 h-auto w-activity-panel sm:max-w-none')}>
        <div className="border-b border-divider px-5 pt-4.5 pb-3.5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-md leading-card font-strong tracking-card text-pretty wrap-anywhere">{card.title}</SheetTitle>
              <p className={cn('m-0 mt-0.5 text-sm', sub.warn ? 'font-medium text-warning-text' : 'text-muted-foreground')}>{`${card.tool.label} · ${coversText(batch)}`}</p>
            </div>
            <IconButton icon="close" label="Close" onClick={onClose} className={cn('-mt-1 -mr-1.5', tap)} />
          </div>
          <SearchBox value={query} onChange={setQuery} placeholder={searchLabel(batch)} label={searchLabel(batch)} className="mt-3" />
        </div>
        {/* The list scrolls on its own: it takes keyboard focus so it scrolls from the keyboard too. */}
        <div className="min-h-0 flex-1 overflow-auto px-5" data-sheet-list tabIndex={0} role="region" aria-label={`All ${count} changes`}>
          <ul className="m-0 list-none p-0">
            {rows.map(it => {
              const status = itemStatus(it)
              return (
                <ItemRowView key={it.n} row={it.row} data-item={it.n} data-item-state={it.state}>
                  {status && (
                    <div className={cn('mt-0.5 text-xs wrap-anywhere', it.state === 'failed' || it.state === NEEDS_CHECK ? 'font-medium text-warning-text' : 'text-muted-foreground')}>
                      {it.result ? `${status}. ${it.result}` : status}
                    </div>
                  )}
                  {resolving && it.state === NEEDS_CHECK && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" className={tap} disabled={busy} aria-label={`It went out: ${it.row.ref || it.line}`} onClick={() => onResolve('sent', it.n)}>It went out</Button>
                      <Button variant="outline" size="sm" className={tap} disabled={busy} aria-label={`It didn't go out: ${it.row.ref || it.line}`} onClick={() => onResolve('failed', it.n)}>{"It didn't go out"}</Button>
                    </div>
                  )}
                </ItemRowView>
              )
            })}
          </ul>
          {q && complete && rows.length === 0 && <p role="status" className="m-0 py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>}
          <div ref={setEnd} className="h-px" />
          {loading && <p role="status" className="m-0 py-3 text-sm text-muted-foreground">{`Loading ${fmtCount(read.items.length, display())} of ${count}.`}</p>}
          {read.error !== null && (
            <div className="flex flex-wrap items-center gap-2 py-3 text-sm text-muted-foreground" role="status">
              <span className="min-w-0 flex-1">{read.error}</span>
              <Button variant="outline" size="sm" onClick={() => setRead(r => ({ ...r, error: null }))}>Try again</Button>
            </div>
          )}
        </div>
        <div className="border-t border-divider px-5 pt-3 pb-4" data-sheet-footer>
          <p className="m-0 text-sm text-foreground-2" data-sheet-totals>
            {isTable(batch) ? tableTotal(batch) : coversText(batch)}
          </p>
          {past > 0 && waiting && <p className="m-0 mt-1 text-sm text-muted-foreground" data-more-arrived>{moreArrivedText(past)}</p>}
          {refusal && <p role="alert" className="m-0 mt-2 text-sm text-destructive-text">{refusal}</p>}
          {answers.length > 0 && (
            <div data-sheet-actions className="mt-3 flex gap-2">
              {answers.map(b => (
                <Button key={b.key} size="lg" variant={b.primary ? 'primary' : 'outline'} className={cn(b.primary && 'flex-1', tap)} disabled={busy} onClick={() => onAnswer(b)}>{b.label}</Button>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
