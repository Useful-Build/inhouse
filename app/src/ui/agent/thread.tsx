// The thread's parts on ui-base's chat components (UI_BASE_V2 PR B): the scroll container on Message Scroller, the person's
// turn on Message + Bubble with our look, a long message folding on Bubble's collapsible, the markers, and Jump to latest.
// Message Scroller owns the scrolling: where a chat opens (its last question), pinning a new question near the top while the
// answer grows under it (D1), following the live edge only while the reader is there, the reader's own scrolls (wheel, touch,
// keys) and keeping place when earlier messages load above.
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Marker, MarkerContent } from '@/components/ui/marker'
import { Message } from '@/components/ui/message'
import {
  MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport,
  useMessageScroller, useMessageScrollerScrollable,
} from '@/components/ui/message-scroller'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Icon } from '../index'

/**
 * The thread's scroll frame: a chat opens at its last question (or the end when the rest fits), a new question settles near
 * the top with the answer growing under it, and the view follows the live edge only while the reader is there (D1). Key it
 * by chat: each chat opens on its own.
 */
export function ThreadScroller({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      <MessageScroller className={className}>{children}</MessageScroller>
    </MessageScrollerProvider>
  )
}

/** The scrolling box. Its `overflow-auto` class is what the E2E helpers find from the log (`closest('.overflow-auto')`). */
export function ThreadViewport({ className, ...props }: ComponentProps<typeof MessageScrollerViewport>) {
  return <MessageScrollerViewport className={cn('overflow-auto', className)} {...props} />
}

/** The conversation as a log, so screen readers hear each new row once; `aria-busy` while an answer's words still come. */
export function ThreadLog({ className, ...props }: ComponentProps<typeof MessageScrollerContent>) {
  return <MessageScrollerContent role="log" aria-label="Conversation" className={cn('gap-0', className)} {...props} />
}

/**
 * One block of the thread (a question, a note, an answer turn). `anchor` marks the person's newest question: it is the turn
 * a new ask pins near the top. Only the newest one is an anchor, so a row redrawn under a new key (a sent question taking
 * its stored id) can't send the view back to an older question. `data-thread-row` paints the row in full (index.css).
 */
export function ThreadRow({ id, anchor = false, ...props }: Omit<ComponentProps<typeof MessageScrollerItem>, 'messageId' | 'scrollAnchor'> & { id: string; anchor?: boolean }) {
  return <MessageScrollerItem data-thread-row messageId={id} scrollAnchor={anchor} {...props} />
}

/** Centred above the composer while there is more below: back to the newest message, and the view follows it again. */
export function JumpToLatest() {
  const { end } = useMessageScrollerScrollable()
  const { scrollToEnd } = useMessageScroller()
  if (!end) return null
  return (
    // Clear of an answer's sources at the left and your messages at the right (M12).
    <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="outline" size="icon-round" aria-label="Jump to latest" onClick={() => scrollToEnd()}>
            <Icon name="arrow_downward" size={18} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Jump to latest</TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * The person's own message: Message at the end, a Bubble in our look (the soft `bubble` fill, round, the reading size).
 * `max` caps its width (a share of the column); `actions` sit beside the bubble; `selected` while it is being edited.
 */
export function UserTurn({ max, selected, actions, children }: { max: string; selected?: boolean; actions?: ReactNode; children: ReactNode }) {
  return (
    <Message align="end">
      <Bubble align="end" className={cn('relative items-end gap-0 *:data-[slot=bubble-content]:bg-bubble', max)}>
        <BubbleContent className={cn('max-w-prose-measure rounded-3xl border-0 px-4.5 py-3 text-md leading-prose text-pretty whitespace-pre-wrap wrap-anywhere', selected && 'shadow-selected')}>
          {children}
        </BubbleContent>
        {actions}
      </Bubble>
    </Message>
  )
}

/** A long message shows about eight lines, with Show more (M8) on Bubble's collapsible. `onToggle` keeps the reader's place. */
export function LongText({ text, onToggle }: { text: string; onToggle: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, text])
  return (
    <Collapsible open={open} onOpenChange={o => { onToggle(); setOpen(o) }}>
      <div ref={ref} id={id} data-long-text className={cn(!open && 'line-clamp-8')}>{text}</div>
      {(long || open) && (
        <CollapsibleTrigger asChild>
          {/* Its visible words are its name (label in name); aria-expanded carries the state. The text is always there
              (clamped while closed), so the trigger controls it, not a CollapsibleContent. */}
          <button type="button" aria-controls={id}
            className="-ml-1 mt-1.5 flex h-7 items-center gap-0.5 rounded-md pr-1.5 pl-1 text-sm font-medium text-foreground-3 hover:bg-fill-strong hover:text-foreground">
            {open ? 'Show less' : 'Show more'}<Icon name={open ? 'expand_less' : 'expand_more'} size={17} />
          </button>
        </CollapsibleTrigger>
      )}
    </Collapsible>
  )
}

/** A line across the thread with a centred label: a time ("Today 8:03 AM") or a model switch ("Switched to Fast"). */
export function ThreadMarker({ kind, children }: { kind: 'time' | 'model'; children: ReactNode }) {
  return (
    <Marker variant="separator" data-thread-marker={kind} className="mb-3.5">
      <MarkerContent>{children}</MarkerContent>
    </Marker>
  )
}

/** A note in the thread (a stopped answer, a file left out), centred, with an optional action (Retry). */
export function NoteMarker({ children }: { children: ReactNode }) {
  return (
    <Marker className="flex-wrap justify-center gap-x-2 gap-y-1 px-2 py-0.5 text-center">{children}</Marker>
  )
}
