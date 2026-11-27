// A batch's full list (Stage 1 M3-U, N22, N33), opened from its card's "See all": every item's line, read 100 at a time
// through route 125 until the list the card showed is all in, each with its outcome once it has one. Loaded with its
// first opening (AskCard's lazy import), outside Today's first load.
//  - Approve what you saw: the sheet keeps the card as it was when it opened (`opened`). Its Approve names that card's
//    count and totals, and the answer carries exactly those (AskCard `send`), however many items join while it's open.
//    Items past that count aren't listed; the sheet says how many arrived and that they wait for their own OK.
//  - A batch that needs a check is settled here, one unclear item at a time, at the live card's rev.
// The live card (`card`) decides whether an answer is still possible: once it isn't waiting, the buttons go.
import { useEffect, useRef, useState } from 'react'
import { agent } from '../../agent'
import type { ActionCard, ActionItem, ActionResolution } from '../../agent/types'
import { NEEDS_CHECK } from '../../../shared/contract/action-states'
import { useUi } from '../../state/store'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Button, IconButton } from '../../ui'
import { TAP } from '../../ui/fields'
import { NO_MOTION } from '../../ui/motion'
import { claimTrigger, keepForToast, restoreFocus } from '../../ui/dialogs'
import { fmtCount } from '../../lib/format'
import { display } from '../../state/display'
import { buttonsOf, coversText, itemStatus, kickerOf, moreArrivedText, refusalOf } from './ask-card'
import type { CardButton, Whose } from './ask-card'

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

type Load = { status: 'loading'; items: ActionItem[] } | { status: 'ready'; items: ActionItem[]; past: number } | { status: 'error'; items: ActionItem[]; text: string }

/** An item's outcome badge: a failure or an unclear one stands out; the rest are quiet. */
const ITEM_BADGE = (state: ActionItem['state']): 'warning' | 'secondary' => (state === 'failed' || state === NEEDS_CHECK ? 'warning' : 'secondary')

export function BatchSheet({ card, opened, whose, busy, refusal, onClose, onSawTip, onAnswer, onResolve }: BatchSheetProps) {
  const phone = useUi(s => s.phone)
  const tap = phone ? TAP : undefined
  const before = useRef<HTMLElement | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const waiting = opened.state === 'waiting'
  // A waiting batch lists what the opened card showed; any other lists every item it has now.
  const shown = (waiting ? opened : card).batch?.itemCount ?? 0
  const [load, setLoad] = useState<Load>({ status: 'loading', items: [] })
  const [tries, setTries] = useState(0)
  // Read again when the live card moves on (an answer, an item settled, the send), never for items joining a waiting one.
  const readRev = waiting ? opened.rev : card.rev
  const onSaw = useRef(onSawTip)
  useEffect(() => { onSaw.current = onSawTip })

  useEffect(() => {
    let live = true
    setLoad(l => ({ status: 'loading', items: l.items }))
    void (async () => {
      const items: ActionItem[] = []
      let past = 0
      let after = 0
      try {
        for (;;) {
          const page = await agent.actionItems(card.id, after)
          if (!live) return
          for (const it of page.items) {
            if (it.n <= shown) items.push(it)
            else past = Math.max(past, it.n - shown)
          }
          setLoad({ status: 'loading', items: [...items] })
          if (page.next === undefined || page.next >= shown) break
          after = page.next
        }
        onSaw.current(shown + past)
        setLoad({ status: 'ready', items, past })
      } catch (e) {
        if (live) setLoad({ status: 'error', items, text: refusalOf(e).text })
      }
    })()
    return () => { live = false }
  }, [card.id, shown, readRev, tries])

  // Items that joined after the list opened: from the pages, or from a newer read of the card.
  const past = Math.max(load.status === 'ready' ? load.past : 0, waiting && card.state === 'waiting' ? (card.batch?.itemCount ?? 0) - shown : 0)
  const answers = waiting && card.state === 'waiting' ? buttonsOf(opened).filter(b => b.kind === 'answer') : []
  const resolving = card.state === NEEDS_CHECK && card.can.resolve
  const count = fmtCount(shown, display())

  return (
    <Sheet open onOpenChange={o => { if (!o) onClose() }}>
      <SheetContent ref={panel} side={phone ? 'bottom' : 'right'} showCloseButton={false} aria-describedby={undefined}
        onPointerDownOutside={keepForToast} onInteractOutside={keepForToast}
        overlayProps={{ className: NO_MOTION }}
        onOpenAutoFocus={e => { before.current = claimTrigger(); e.preventDefault(); panel.current?.focus() }}
        onCloseAutoFocus={e => { e.preventDefault(); if (document.activeElement === document.body) restoreFocus(before.current) }}
        data-surface="window" data-batch-sheet
        className={cn('gap-0 overflow-hidden rounded-2xl border bg-window-surface shadow-menu', NO_MOTION, phone ? 'inset-x-2.5 bottom-2.5 h-auto max-h-window-max w-auto' : 'inset-y-2.5 right-2.5 h-auto w-activity-panel sm:max-w-none')}>
        <div className="flex items-center gap-1.5 pt-3.5 pr-3.5 pl-6 text-sm">
          <span className="min-w-0 flex-1 text-muted-foreground">{kickerOf(card, whose)}</span>
          <IconButton icon="close" label="Close" onClick={onClose} className={tap} />
        </div>
        <div className="px-6 pt-1 pb-3">
          <SheetTitle className="text-xl leading-heading font-medium tracking-heading text-pretty wrap-anywhere">{card.title}</SheetTitle>
          {opened.batch && (
            <p className="m-0 mt-1.5 text-sm text-foreground-2" data-sheet-totals>
              {`${count} ${shown === 1 ? 'change' : 'changes'}`}<span className="text-muted-foreground"> · In all: </span><span className="font-strong">{coversText((waiting ? opened : card).batch!)}</span>
            </p>
          )}
        </div>
        {/* The list scrolls on its own: it takes keyboard focus so it scrolls from the keyboard too. */}
        <div className="min-h-0 flex-1 overflow-auto border-t border-divider px-6 py-2" data-sheet-list
          tabIndex={0} role="region" aria-label={`All ${count} changes`}>
          <ol className="m-0 list-none p-0">
            {load.items.map(it => {
              const status = itemStatus(it)
              return (
                <li key={it.n} data-item={it.n} data-item-state={it.state} className="flex gap-3 border-b border-divider py-2.5 text-sm last:border-b-0">
                  <span className="w-8 flex-none text-right text-muted-foreground tabular-nums">{it.n}</span>
                  <div className="min-w-0 flex-1">
                    <div className="leading-prose text-foreground-2 wrap-anywhere">{it.line}</div>
                    {status && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Badge variant={ITEM_BADGE(it.state)}>{status}</Badge>
                        {it.result && <span className="text-muted-foreground wrap-anywhere">{it.result}</span>}
                      </div>
                    )}
                    {resolving && it.state === NEEDS_CHECK && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button variant="soft" size="sm" className={tap} disabled={busy} aria-label={`It went out: change ${it.n}`} onClick={() => onResolve('sent', it.n)}>It went out</Button>
                        <Button variant="soft" size="sm" className={tap} disabled={busy} aria-label={`It didn't go out: change ${it.n}`} onClick={() => onResolve('failed', it.n)}>{"It didn't go out"}</Button>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
          {load.status === 'loading' && <p role="status" className="m-0 py-3 text-sm text-muted-foreground">{`Loading ${fmtCount(load.items.length, display())} of ${count}.`}</p>}
          {load.status === 'error' && (
            <div className="flex flex-wrap items-center gap-2 py-3 text-sm text-muted-foreground" role="status">
              <span className="min-w-0 flex-1">{load.text}</span>
              <Button variant="outline" size="sm" onClick={() => setTries(n => n + 1)}>Try again</Button>
            </div>
          )}
        </div>
        {(answers.length > 0 || past > 0 || refusal) && (
          <div className="border-t border-divider px-6 pt-3 pb-4">
            {past > 0 && waiting && <p className="m-0 mb-3 text-sm text-foreground-2" data-more-arrived>{moreArrivedText(past)}</p>}
            {refusal && <p role="alert" className="m-0 mb-3 text-sm text-destructive-text">{refusal}</p>}
            {answers.length > 0 && (
              <div data-sheet-actions className="flex flex-wrap gap-2">
                {answers.map(b => (
                  <Button key={b.key} size="lg" variant={b.primary ? 'primary' : 'soft'} className={tap} disabled={busy} onClick={() => onAnswer(b)}>{b.label}</Button>
                ))}
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
