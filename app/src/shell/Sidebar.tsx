import { useRef } from 'react'
import { goingLive, pendingIds, STAGE_TAGS, userName } from '../state/derive'
import { chatEntries, openChatKey, useCtx, useUi } from '../state/store'
import { cn } from '@/lib/utils'
import { Avatar, Button, Icon, IconButton, InhouseMark, NavItem } from '../ui'
import { keepForToast } from '../ui/dialogs'
import { AccountMenu } from '../overlays/Menus'
import { ChatRow } from '../ui/chat'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { PRIMARY, SECONDARY, SHORTCUTS } from './nav'

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
  const { go, newChat, openChat, openChatList, openTeam, patch } = useUi.getState()
  // The phone drawer opens with focus on itself, so no row shows a focus ring until someone tabs.
  const drawer = useRef<HTMLDivElement>(null)
  const activeKey = page === 'app' ? 'apps' : page
  const count = ctx.S >= 1 ? pendingIds(ctx).length : 0

  // The account row is selected only on Settings.
  const meActive = page === 'settings'
  const name = userName(ctx)
  const live = goingLive(ctx)
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
        {PRIMARY.map(n => {
          const locked = ctx.S < n.need, active = activeKey === n.key
          const showCount = n.key === 'approvals' && !locked && count > 0
          return <NavItem key={n.key} rail icon={n.icon} label={n.label} active={active} locked={locked} onClick={() => go(n.key)}
            count={showCount ? count : undefined} countLabel={`${count} waiting`} tag={locked ? STAGE_TAGS[n.need] : undefined} />
        })}
      </nav>
      <div className="grow shrink-0 basis-3" />
      <div className="flex flex-none flex-col items-center gap-px border-t border-divider pt-1.5">
        {SECONDARY.map(n => <NavItem key={n.key} rail size="sm" tone="quiet" icon={n.icon} label={n.label} active={activeKey === n.key} onClick={() => go(n.key)} />)}
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
            <div className="truncate text-xs text-muted-foreground">Northline Outdoor</div>
          </div>
          <IconButton icon="edit_square" label="New chat" shortcut={SHORTCUTS.newChat} size={18} onClick={() => newChat()} variant="chrome" />
        </div>

        <nav aria-label="Main" className="mt-4.5 flex flex-col gap-px">
          {phone && <NavItem icon="search" label="Search" onClick={() => patch({ sideOpen: false, palette: true })} />}
          {PRIMARY.map(n => {
            const locked = ctx.S < n.need, active = activeKey === n.key
            const showCount = n.key === 'approvals' && !locked && count > 0
            return <NavItem key={n.key} icon={n.icon} label={n.label} active={active} locked={locked} onClick={() => go(n.key)}
              count={showCount ? count : undefined} countLabel={`${count} waiting`} tag={locked ? STAGE_TAGS[n.need] : undefined} />
          })}
        </nav>

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
        <div className="mb-2 flex-none rounded-xl bg-muted px-3 pt-3 pb-3.25">
          <div className="flex items-center gap-2 text-sm font-semibold"><Icon name="support_agent" size={17} />Inhouse team</div>
          {live && <div className="mt-1 text-xs leading-normal text-foreground-3">{live.name} goes live by {live.by}.</div>}
          <Button variant="link" className="mt-2 text-xs" onClick={() => openTeam('tool')}>Message the team →</Button>
        </div>
        <div className="flex flex-none flex-col gap-px border-t border-divider pt-1.5">
          {SECONDARY.map(n => {
            const active = activeKey === n.key
            return <NavItem key={n.key} size="sm" tone="quiet" icon={n.icon} label={n.label} active={active} onClick={() => go(n.key)} />
          })}
          <AccountMenu>
            <NavItem tone="quiet" avatar label={name} aria-label={`${name}, account and settings`} active={meActive} className={OPEN_ROW} leading={<Avatar who={ctx.data.meta.currentUser.id} size={24} fontSize={10} />}
              trailing={<Icon name="unfold_more" size={16} className="text-faint" />} />
          </AccountMenu>
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
