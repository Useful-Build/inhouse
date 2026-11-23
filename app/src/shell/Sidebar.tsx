import { useLayoutEffect, useRef } from 'react'
import { pendingIds, STAGE_TAGS, userName } from '../state/derive'
import { chatEntries, openChatKey, useCtx, useUi } from '../state/store'
import { cn } from '@/lib/utils'
import { Avatar, Button, Icon, IconButton, InhouseMark, NavItem } from '../ui'
import { keepForToast } from '../ui/dialogs'
import { AccountMenu } from '../overlays/Menus'
import { ChatRow } from '../ui/chat'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { AGENT, DAILY, mac, SHORTCUTS } from './nav'
import type { NavDef } from './nav'

// The account row while its menu is open: it holds its hover look (open is hover, never selected).
const OPEN_ROW = 'data-[state=open]:bg-accent data-[state=open]:text-foreground'

export function Sidebar() {
  const ctx = useCtx()
  const page = useUi(s => s.page)
  const fresh = useUi(s => s.fresh)
  const chatId = useUi(s => s.chatId)
  const chatList = useUi(s => s.chatList)
  const started = useUi(s => s.started)
  const phone = useUi(s => s.phone)
  const sideOpen = useUi(s => s.sideOpen)
  const runs = useUi(s => s.runs)
  // The icon rail is desktop only: the phone drawer always shows the full sidebar.
  const rail = useUi(s => s.sideCollapsed) && !phone
  // Windows portal to body and center in the room right of the sidebar: tell them how wide it is (index.css, --app-side-offset).
  const side = phone ? 'none' : rail ? 'rail' : 'full'
  useLayoutEffect(() => {
    document.documentElement.dataset.side = side
    return () => { delete document.documentElement.dataset.side }
  }, [side])
  const { go, newChat, openChat, openChatList, patch, toggleSidebar } = useUi.getState()
  // The phone drawer opens with focus on itself, so no row shows a focus ring until someone tabs.
  const drawer = useRef<HTMLDivElement>(null)
  // The rail and the full sidebar are different trees, so the collapse button is a new element after a click on it:
  // focus moves to the new one. The shortcut doesn't move focus.
  const refocusToggle = useRef(false)
  useLayoutEffect(() => {
    if (!refocusToggle.current) return
    refocusToggle.current = false
    document.querySelector<HTMLElement>('#sidebar [data-sidebar-toggle]')?.focus()
  }, [rail])
  // Desktop only: on a phone the drawer closes instead, and the top bar's menu button opens it.
  const toggle = (
    <IconButton data-sidebar-toggle icon={rail ? 'left_panel_open' : 'left_panel_close'} label="Sidebar" tip={rail ? 'Expand sidebar' : 'Collapse sidebar'}
      tipSide={rail ? 'right' : undefined} shortcut={SHORTCUTS.sidebar} variant="chrome" size={18} aria-expanded={!rail} aria-controls="sidebar"
      onClick={() => { refocusToggle.current = true; toggleSidebar() }} />
  )
  const activeKey = page === 'app' ? 'apps' : page === 'skill' ? 'skills' : page
  const count = ctx.S >= 1 ? pendingIds(ctx).length : 0

  // The account row is selected on Settings and on Usage, which its menu opens.
  const meActive = page === 'settings' || page === 'usage'
  const name = userName(ctx)
  /** One nav row: a stage locks it (with its tag), and Approvals carries its waiting count. */
  const navItem = (n: NavDef, rail: boolean) => {
    const locked = ctx.S < n.need, active = activeKey === n.key
    const showCount = n.key === 'approvals' && !locked && count > 0
    return <NavItem key={n.key} rail={rail} icon={n.icon} label={n.label} active={active} locked={locked} onClick={() => go(n.key)}
      count={showCount ? count : undefined} countLabel={`${count} waiting`} tag={locked ? STAGE_TAGS[n.need] : undefined} />
  }
  const openChatId = openChatKey({ fresh, chatId }, ctx.data)
  const chats = chatEntries(ctx.data, started, ctx.agent)
  const pinned = chats.filter(c => c.pinned)
  const recent = chats.filter(c => !c.pinned).slice(0, ctx.data.chat.recentCount)
  const chatRow = (c: (typeof chats)[number]) => (
    <ChatRow key={c.id} chat={c} open={page === 'chats' && !chatList && openChatId === c.id}
      running={!!runs[c.id]} onClick={() => openChat(c.id)} />
  )

    // Collapsed on desktop: an icon rail with the same items, each named in a tooltip.
  if (rail) return (
    <aside id="sidebar" aria-label="Sidebar" className="relative z-sidebar my-2.5 mr-0 ml-2.5 box-border flex w-sidebar-rail flex-none flex-col items-center gap-px overflow-x-hidden overflow-y-auto rounded-2xl border border-border bg-card px-2.5 pt-3 pb-2.5 shadow-float">
      <span className="mb-1 flex size-9 flex-none items-center justify-center rounded-lg border border-input bg-card">
        <InhouseMark />
      </span>
      <IconButton icon="search" label="Search" shortcut={SHORTCUTS.palette} size={18} onClick={() => patch({ palette: true })} variant="chrome" />
      <IconButton icon="edit_square" label="New chat" shortcut={SHORTCUTS.newChat} size={18} onClick={() => newChat()} variant="chrome" className="mt-1" />
      <nav aria-label="Main" className="mt-4.5 flex flex-col items-center gap-px">
        {DAILY.map(n => navItem(n, true))}
        <div role="group" aria-label="Your agent" className="mt-1.5 flex flex-col items-center gap-px border-t border-divider pt-1.5">
          {AGENT.map(n => navItem(n, true))}
        </div>
      </nav>
      <div className="grow shrink-0 basis-3" />
      <div className="flex flex-none flex-col items-center gap-1.5">
        {toggle}
        <AccountMenu>
          <NavItem rail tone="quiet" label={name} tip={name} aria-label={`${name}, account and settings`} active={meActive} className={OPEN_ROW}
            leading={<Avatar who={ctx.data.meta.currentUser.id} size={24} fontSize={10} />} />
        </AccountMenu>
      </div>
    </aside>
  )

  const aside = (
      <aside id="sidebar" aria-label="Sidebar" className={cn('my-2.5 mr-0 ml-2.5 box-border flex w-sidebar flex-none flex-col overflow-x-hidden overflow-y-auto rounded-2xl border border-border bg-card px-2.5 pt-3 pb-2.5 shadow-float',
        phone ? 'min-h-0 flex-1' : 'relative z-sidebar')}>
        <div className="flex items-center gap-1.5 py-1 pr-1 pl-1.5">
          <span className="mr-1 flex size-9 flex-none items-center justify-center rounded-lg border border-input bg-card">
            <InhouseMark />
          </span>
          <div className="mr-1 min-w-0 flex-1">
            <div className="truncate text-base font-semibold tracking-card">Inhouse</div>
            <div className="truncate text-xs text-muted-foreground">{ctx.data.meta.brand.name}</div>
          </div>
          <IconButton icon="edit_square" label="New chat" shortcut={SHORTCUTS.newChat} size={18} onClick={() => newChat()} variant="chrome" />
        </div>

        <div className="mt-4.5 flex flex-col gap-px">
          <NavItem icon="search" label="Search" aria-keyshortcuts={SHORTCUTS.palette.aria}
            onClick={() => patch(phone ? { sideOpen: false, palette: true } : { palette: true })}
            trailing={!phone && (
              mac
                ? <span aria-hidden="true" className="inline-flex items-center gap-0.75 text-xs text-muted-foreground"><span>⌘</span><span>K</span></span>
                : <span aria-hidden="true" className="text-xs text-muted-foreground">{SHORTCUTS.palette.label}</span>
            )} />
          <nav aria-label="Main" className="flex flex-col gap-px">
            {DAILY.map(n => navItem(n, false))}
            <div role="group" aria-labelledby="side-agent" className="flex flex-col gap-px">
              <div id="side-agent" className="px-2.5 pt-5.5 pb-1.5 text-xs font-medium text-muted-foreground">Your agent</div>
              {AGENT.map(n => navItem(n, false))}
            </div>
          </nav>
        </div>

        {pinned.length > 0 && (
          <div role="group" aria-labelledby="side-pinned" className="flex flex-none flex-col">
            <div id="side-pinned" className="px-2.5 pt-5.5 pb-1.5 text-xs font-medium text-muted-foreground">Pinned</div>
            {pinned.map(chatRow)}
          </div>
        )}
        {/* No chats yet (day one, or every one deleted): no heading over an empty list. */}
        {chats.length > 0 && <>
        <div className="flex items-center justify-between px-2.5 pt-5.5 pb-1.5 text-xs font-medium text-muted-foreground">
          <span>Recent chats</span>
          <Button variant="link" size="sm" data-chat-fallback className="text-xs font-medium" aria-current={page === 'chats' && chatList ? 'page' : undefined} onClick={openChatList}>See all</Button>
        </div>
        <div role="group" aria-label="Recent chats" className="flex flex-none flex-col">{recent.map(chatRow)}</div>
        </>}

        <div className="grow shrink-0 basis-3" />
        {/* The account row, and on desktop the collapse button beside it, in line with New chat above. */}
        <div className={cn('flex flex-none items-center', !phone && 'gap-1 pr-1')}>
          <AccountMenu>
            <NavItem tone="quiet" avatar label={name} aria-label={`${name}, account and settings`} active={meActive} className={cn(OPEN_ROW, 'min-w-0 flex-1')} leading={<Avatar who={ctx.data.meta.currentUser.id} size={24} fontSize={10} />}
              trailing={phone && <Icon name="unfold_more" size={16} className="text-faint" />} />
          </AccountMenu>
          {!phone && toggle}
        </div>
      </aside>
  )

  if (!phone) return aside
  return (
    <Sheet open={sideOpen} onOpenChange={open => patch({ sideOpen: open })}>
      <SheetContent ref={drawer} side="left" showCloseButton={false} aria-describedby={undefined}
        onPointerDownOutside={keepForToast} onInteractOutside={keepForToast}
        onOpenAutoFocus={e => { e.preventDefault(); drawer.current?.focus() }}
        // Escape while renaming a chat cancels the rename only.
        onEscapeKeyDown={e => { if (e.target instanceof Element && e.target.closest('[data-chat-rename]')) e.preventDefault() }}
        className="w-auto max-w-none gap-0 border-0 bg-transparent shadow-none sm:max-w-none">
        <SheetTitle className="sr-only">Sidebar</SheetTitle>
        {aside}
      </SheetContent>
    </Sheet>
  )
}
