// Managing chats: the "···" menu on a chat (sidebar rows, See all rows, the top bar), the inline rename field and
// the chat row itself, with its running marker and a tooltip for a title that is cut off.
import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { cva } from 'class-variance-authority'
import { CHAT_TITLE_MAX } from '../agent/types'
import type { ChatEntry } from '../state/store'
import { useUi } from '../state/store'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Icon, IconButton, MenuItem } from './index'
import { NO_CLOSE_MOTION } from './motion'

/** Set by Pin and Delete for the menu's close, which may come after the row (and its menu) was replaced. One menu is open at a time. */
let restoreFocusAfterMenu: (() => void) | null = null
/** Set once the action itself has moved focus, so the menu's close doesn't send it back to the trigger. */
let focusMoved = false

/**
 * The menu for one chat: Rename, Pin or Unpin, Copy link, Export (only with `onExport`) and Delete.
 * `onRename` starts the caller's inline rename; focus then stays with the field instead of going back to the trigger.
 * `children` replaces the "···" button as the trigger (the top bar's title on a phone).
 * `focusAfter` (a row's) is asked before Pin or Delete for where focus goes once the rows have redrawn: the row that
 * had the menu may be gone or have moved, and focus would drop to the page.
 */
export function ChatMenu({ chat, onRename, onExport, focusAfter, box = 'icon', className, children }: {
  chat: ChatEntry; onRename: () => void; onExport?: () => void; focusAfter?: (kind: 'pin' | 'delete') => () => void
  box?: 'icon' | 'icon-sm'; className?: string; children?: ReactElement
}) {
  const [open, setOpen] = useState(false)
  // Set by Rename, so closing the menu leaves focus in the rename field. Cleared when the menu opens again, so a close
  // that never reached onCloseAutoFocus can't leave it set.
  const [renaming, setRenaming] = useState(false)
  const { pinChat, copyChatLink, deleteChats } = useUi.getState()
  // Asks where focus goes first (the rows are about to redraw), then makes the change.
  // Focus moves from here, a frame after the rows redraw, so it doesn't depend on the menu's close ever reaching onCloseAutoFocus.
  const change = (kind: 'pin' | 'delete', apply: () => void) => {
    const go = focusAfter?.(kind) ?? null
    restoreFocusAfterMenu = go
    focusMoved = false
    apply()
    if (go) requestAnimationFrame(() => { if (restoreFocusAfterMenu === go) { restoreFocusAfterMenu = null; focusMoved = true; go() } })
  }
  const items: { icon: string; t: string; go: () => void; destructive?: boolean; sep?: boolean }[] = [
    { icon: 'edit', t: 'Rename', go: () => { setRenaming(true); onRename() } },
    { icon: chat.pinned ? 'keep_off' : 'keep', t: chat.pinned ? 'Unpin' : 'Pin', go: () => change('pin', () => pinChat(chat.id, !chat.pinned)) },
    { icon: 'link', t: 'Copy link', go: () => copyChatLink(chat.id) },
    ...(onExport ? [{ icon: 'download', t: 'Export', go: onExport }] : []),
    { icon: 'delete', t: 'Delete', destructive: true, sep: true, go: () => change('delete', () => deleteChats([chat.id])) },
  ]
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={o => { if (o) { setRenaming(false); restoreFocusAfterMenu = null; focusMoved = false } setOpen(o) }}>
      <DropdownMenuTrigger asChild>
        {children ?? <IconButton icon="more_horiz" label="Chat actions" size={18} box={box} className={className} />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={children ? 'start' : 'end'} collisionPadding={16} aria-label="Chat actions" aria-labelledby={undefined}
        // Rename closes the menu with no fade: a menu still fading out takes the next press on its trigger as a click
        // outside and closes the menu that press just opened, so a quick Rename, Escape, "···" opened nothing.
        className={cn('w-menu-message max-w-screen-gutter border-input', renaming && NO_CLOSE_MOTION)}
        onCloseAutoFocus={e => {
          if (renaming) { setRenaming(false); e.preventDefault() }
          else if (restoreFocusAfterMenu || focusMoved) { e.preventDefault(); const go = restoreFocusAfterMenu; restoreFocusAfterMenu = null; go?.() }
        }}
        // Escape closes only this menu, not the phone drawer behind it (App's window listener). Only while it's open.
        onEscapeKeyDown={e => { if (open) e.stopPropagation() }}>
        {items.map(it => (
          <Fragment key={it.t}>
            {it.sep && <DropdownMenuSeparator className="mx-0 my-1" />}
            <MenuItem variant={it.destructive ? 'destructive' : 'default'} onSelect={it.go}>
              <Icon name={it.icon} size={18} />
              <span className="flex-1">{it.t}</span>
            </MenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Renames a chat in place. Enter or leaving the field saves, Escape cancels; an empty title keeps the old one.
 * `onDone` gets the new title (null when cancelled) and whether a key ended it, so focus can go back to the row.
 */
export function ChatTitleInput({ title, size, className, onDone }: {
  title: string; size?: 'default' | 'sm'; className?: string; onDone: (title: string | null, byKey: boolean) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const finish = (save: boolean, byKey: boolean) => {
    if (done.current) return
    done.current = true
    onDone(save ? ref.current?.value ?? null : null, byKey)
  }
  return (
    // Room for the 3px focus halo inside the field's own box, so a parent that clips (the top bar's title) shows all of it (M13).
    <span className="-m-1 flex min-w-0 flex-1 p-1">
    <Input ref={ref} data-chat-rename size={size} aria-label="Chat title" defaultValue={title} maxLength={CHAT_TITLE_MAX} autoComplete="off" spellCheck={false} className={className}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true, true) }
        // Escape cancels the rename only, not the drawer or a window around it.
        else if (e.key === 'Escape') { e.stopPropagation(); finish(false, true) }
      }}
      onBlur={() => finish(true, false)} />
    </span>
  )
}

const chatRowVariants = cva('group/chat relative flex flex-none items-center rounded-lg', {
  variants: {
    /** `sidebar` is a Recent chats or Pinned row; `list` a row in See all. */
    place: { sidebar: 'h-8', list: 'min-h-13' },
    // The open chat has the nav's one selected look (NavItem), a step stronger than hover.
    open: { true: 'bg-fill-hover', false: 'hover:bg-accent has-focus-visible:bg-accent has-aria-expanded:bg-accent' },
  },
  defaultVariants: { place: 'sidebar', open: false },
})

const chatButtonVariants = cva('flex h-full min-w-0 flex-1 items-center text-left', {
  variants: {
    place: {
      // The title (and in See all the time) gets the full width at rest. The row's "···" trigger is laid over its end
      // on hover and focus.
      sidebar: 'gap-2 rounded-lg pl-2.5 text-sm text-foreground-2',
      list: 'min-h-13 gap-3.5 rounded-lg py-2 pl-3',
    },
    // A phone or touch screen always shows the trigger, so the title leaves room for it.
    reserve: { true: '', false: '' },
  },
  compoundVariants: [
    { place: 'sidebar', reserve: true, class: 'pr-9' },
    { place: 'sidebar', reserve: false, class: 'pr-2.5 pointer-coarse:pr-9' },
    // See all: the time ends on the card's edge, 12px in; a phone or touch screen keeps the trigger's room after it.
    // A phone in Select mode shows no trigger, so the row gives that room back to the title (the time moves right);
    // a desktop keeps the time on one column in both views.
    { place: 'list', reserve: true, class: 'pr-12' },
    { place: 'list', reserve: false, class: 'pr-3 pointer-coarse:pr-12' },
  ],
  defaultVariants: { place: 'sidebar', reserve: false },
})

/**
 * One chat in the sidebar or in See all: a button that opens it, and its "···" menu as a separate button next to it
 * (shown on hover and focus, always on a phone or touch screen). `running` marks a chat whose answer is streaming.
 * In See all's Select mode (`picked` set) a click picks the row instead, and the menu is hidden.
 */
export function ChatRow({ chat, place = 'sidebar', open = false, running = false, picked, onClick }: {
  chat: ChatEntry; place?: 'sidebar' | 'list'; open?: boolean; running?: boolean
  /** Select mode: whether this row is picked. Undefined outside Select mode. */
  picked?: boolean
  onClick: () => void
}) {
  const phone = useUi(s => s.phone)
  const renameChat = useUi(s => s.renameChat)
  const [editing, setEditing] = useState(false)
  const [tip, setTip] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLButtonElement>(null)
  const titleEl = useRef<HTMLSpanElement>(null)
  const refocus = useRef(false)
  const runningId = useId()
  const selecting = picked !== undefined

  useEffect(() => { if (!editing && refocus.current) { refocus.current = false; row.current?.focus() } }, [editing])

  // The full title shows on hover or focus only when the row cuts it off, counting the end the "···" trigger covers
  // then (laid over the title in the sidebar).
  const cut = () => {
    const t = titleEl.current
    if (!t) return false
    const r = t.getBoundingClientRect()
    const menu = box.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.getBoundingClientRect()
    const shown = menu && menu.left < r.right && menu.right > r.left ? menu.left - r.left : r.width
    // The text's own laid-out width (scrollWidth is never less than the box, so it can't tell a short title).
    const range = document.createRange()
    range.selectNodeContents(t)
    return range.getBoundingClientRect().width > shown + 0.5
  }
  // Faded out, not `invisible`: it stays focusable and in the accessibility tree, so Tab and Shift+Tab reach it.
  const reveal = phone ? '' : 'opacity-0 group-hover/chat:opacity-100 group-focus-within/chat:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100'

  // The sidebar trigger sits over the title's end, so it carries the row's own fill (solid, to cover the text).
  const trigger = (on: boolean) => on ? 'bg-fill-hover hover:bg-fill-strong' : 'bg-accent hover:bg-fill-hover'

  // Where focus goes after Pin (the same chat, redrawn in its new group) or Delete (the next row, else the previous,
  // else the list's fallback). Read from the page before the change, applied after it, by the menu.
  const focusAfter = (kind: 'pin' | 'delete') => {
    const scope = box.current?.closest('aside, main')
    const rows = scope ? [...scope.querySelectorAll<HTMLElement>('[data-chat-row]')] : []
    const at = rows.indexOf(box.current as HTMLElement)
    const ids = kind === 'pin' ? [chat.id] : [...rows.slice(at + 1), ...rows.slice(0, Math.max(at, 0)).reverse()].map(r => r.dataset.chatRow ?? '')
    return () => {
      if (!scope?.isConnected) return
      const now = [...scope.querySelectorAll<HTMLElement>('[data-chat-row]')]
      for (const id of ids) {
        const btn = now.find(r => r.dataset.chatRow === id)?.querySelector<HTMLElement>('[data-chat-open]')
        if (btn) { btn.focus(); return }
      }
      // With no chats left the sidebar has no See all: New chat takes focus.
      ;(scope.querySelector<HTMLElement>('[data-chat-fallback]') ?? scope.querySelector<HTMLElement>('button[aria-label="New chat"]'))?.focus()
    }
  }

  return (
    <div ref={box} data-chat-row={chat.id} className={chatRowVariants({ place, open: open || !!picked })}>
      {editing ? (
        <ChatTitleInput title={chat.title} size={place === 'sidebar' ? 'sm' : 'default'} className={place === 'list' ? 'mx-1.5' : undefined}
          onDone={(t, byKey) => { if (t !== null) renameChat(chat.id, t); refocus.current = byKey; setEditing(false) }} />
      ) : (
        <Tooltip open={tip} onOpenChange={o => setTip(o && cut())}>
          <TooltipTrigger asChild>
            <button ref={row} data-chat-open type="button" onClick={onClick} aria-current={open ? 'page' : undefined} aria-pressed={selecting ? picked : undefined}
              aria-describedby={running ? runningId : undefined} className={cn(chatButtonVariants({ place, reserve: phone }), place === 'list' && phone && selecting && 'pr-3')}>
              {selecting && (
                <span aria-hidden="true" className={cn('box-border flex size-5 flex-none items-center justify-center rounded-full text-primary-foreground', picked ? 'bg-primary' : 'border-hairline border-border-strong bg-card')}>
                  {picked && <Icon name="check" size={14} weight={500} />}
                </span>
              )}
              {place === 'list' && <Icon name={chat.pinned ? 'keep' : 'chat_bubble'} size={19} className="flex-none text-muted-foreground" />}
              <span ref={titleEl} className={cn('ellipsis min-w-0 flex-1', place === 'list' && 'text-md font-medium')}>{chat.title}</span>
              {running && <span aria-hidden="true" className="size-2 flex-none animate-pulse rounded-full bg-brand" />}
              {/* On the selected fill muted text falls under 4.5:1, so a picked or open row's time steps up a level. */}
              {/* Where the "···" trigger shows over it (hover, focus, an open menu; not on a phone or touch screen), the time fades. */}
              {place === 'list' && <span className={cn('flex-none text-sm tabular-nums transition-opacity duration-120', open || picked ? 'text-foreground-3' : 'text-muted-foreground',
                !phone && !selecting && 'pointer-fine:group-hover/chat:opacity-0 pointer-fine:group-focus-within/chat:opacity-0 pointer-fine:group-has-[[aria-expanded=true]]/chat:opacity-0')}>{chat.at}</span>}
            </button>
          </TooltipTrigger>
          <TooltipContent side={place === 'sidebar' ? 'right' : 'top'} className="max-w-72">{chat.title}</TooltipContent>
        </Tooltip>
      )}
      {running && <span id={runningId} hidden>Answering now</span>}
      {!selecting && (
        <ChatMenu chat={chat} onRename={() => setEditing(true)} focusAfter={focusAfter} box={place === 'sidebar' ? 'icon-sm' : 'icon'}
          className={cn(editing ? 'invisible' : reveal, 'absolute top-1/2 -translate-y-1/2', place === 'sidebar' ? 'right-0.5' : 'right-1.5', place === 'sidebar' && !phone && trigger(open || !!picked))} />
      )}
    </div>
  )
}

/** A suggested question as a chip: the empty chat's suggestions and the off-script answer's (decision D8). Clicking asks it. */
export function SuggestionChip({ question, onAsk }: { question: string; onAsk: (q: string) => void }) {
  return (
    <button type="button" onClick={() => onAsk(question)}
      className="inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3.5 py-1.5 text-center text-sm hover:border-border-strong">{question}</button>
  )
}
