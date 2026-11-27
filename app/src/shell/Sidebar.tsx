import { useCallback, useLayoutEffect, useRef } from 'react'
import { pendingIds, STAGE_TAGS, stageLocked, userName } from '../state/derive'
import { chatEntries, openChatKey, useCtx, useUi } from '../state/store'
import { cn } from '@/lib/utils'
import { Avatar, Button, Icon, IconButton, InhouseMark, NavItem } from '../ui'
import { keepForToast } from '../ui/dialogs'
import { AccountMenu } from '../overlays/Menus'
import { useAsksCount } from './asks-count'
import { ChatRow } from '../ui/chat'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { AGENT, DAILY, mac, SHORTCUTS } from './nav'
import type { NavDef } from './nav'

// The account row while its menu is open: it holds its hover look (open is hover, never selected).
const OPEN_ROW = 'data-[state=open]:bg-side-hover data-[state=open]:text-foreground'

/**
 * Tells the marker where the selected row is (`side-marker` in index.css draws the line there). With no selected row
 * (See all, a page the sidebar doesn't list) the line is off.
 */
function placeMarker(el: HTMLElement) {
  const box = el.parentElement
  if (!box) return
  const row = box.querySelector<HTMLElement>('[aria-current="page"]:not([data-chat-fallback])')
  if (!row) { el.dataset.off = ''; return }
  const b = box.getBoundingClientRect(), r = row.getBoundingClientRect()
  el.style.setProperty('--side-marker-y', `${r.top - b.top - box.clientTop + box.scrollTop}px`)
  el.style.setProperty('--side-marker-h', `${r.height}px`)
  delete el.dataset.off
}

/**
 * The sidebar has no surface of its own on desktop: it sits on the page's wall behind one hairline (App's `side-rule`).
 * The selected row (a page, the open chat, the account row) turns to ink, and one marker, a short ink line on the
 * sidebar's edge, glides to it. The other rows wait a step quieter until the pointer or the keyboard is in the sidebar
 * (`group/side`, NavItem's and ChatRow's `hush`). The phone drawer is the same rows on a card, never quiet (no hover).
 */
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
  const { go, newChat, openChat, openChatList, openTeam, patch, toggleSidebar } = useUi.getState()
  // The marker's line. It mounts with its tree (the rail, the full sidebar, or the drawer's content a commit after the
  // drawer opens), so the ref places it then and watches the sidebar's size; every render places it again, since the
  // selected row may have changed or moved (a chat pinned, a group added).
  const marker = useRef<HTMLElement | null>(null)
  const markerRef = useCallback((el: HTMLElement | null) => {
    marker.current = el
    const box = el?.parentElement
    if (!el || !box) return
    placeMarker(el)
    const ro = new ResizeObserver(() => placeMarker(el))
    ro.observe(box)
    return () => { ro.disconnect(); marker.current = null }
  }, [])
  useLayoutEffect(() => { if (marker.current) placeMarker(marker.current) })
  const line = <i ref={markerRef} aria-hidden="true" className="side-marker data-off:opacity-0" />
  // The phone drawer opens with focus on itself, so no row shows a focus ring until someone tabs.
  const drawer = useRef<HTMLDivElement>(null)
  // The rail and the full sidebar are different trees, so the collapse button is a new element after a click on it:
  // focus moves to the new one. The shortcut doesn't move focus.
  const refocusToggle = useRef(false)
  useLayoutEffect(() => {
    if (!refocusToggle.current) return
    refocusToggle.current = false
    // preventScroll: mid-expand the button is still past the column's edge, and scrolling to it would slide the rows in.
    document.querySelector<HTMLElement>('#sidebar [data-sidebar-toggle]')?.focus({ preventScroll: true })
  }, [rail])
  // Desktop only: on a phone the drawer closes instead, and the top bar's menu button opens it.
  const toggle = (
    <IconButton data-sidebar-toggle icon={rail ? 'left_panel_open' : 'left_panel_close'} label="Sidebar" tip={rail ? 'Expand sidebar' : 'Collapse sidebar'}
      tipSide={rail ? 'right' : undefined} shortcut={SHORTCUTS.sidebar} variant="chrome" size={18} aria-expanded={!rail} aria-controls="sidebar"
      onClick={() => { refocusToggle.current = true; toggleSidebar() }} />
  )
  // The Inhouse team window, one click from the account row (the account menu keeps its entry too).
  const team = (
    <IconButton data-team-button icon="support_agent" label="Your Inhouse team" tipSide={rail ? 'right' : undefined}
      variant="chrome" size={18} onClick={() => openTeam('tool')} />
  )
  const activeKey = page === 'app' ? 'apps' : page === 'skill' ? 'skills' : page
  // Stage 1 M2-H: the agent's actions and questions waiting on this person count too, whatever the stage (they don't
  // depend on it: N17 retires it), so a card never waits unseen.
  const asks = useAsksCount()
  const drafts = ctx.S >= 1 ? pendingIds(ctx).length : 0
  const count = drafts + asks

  // The account row is selected on Settings and on Usage, which its menu opens.
  const meActive = page === 'settings' || page === 'usage'
  const name = userName(ctx)
  /** One nav row: a stage locks it (with its tag), and Approvals carries its waiting count. */
  const navItem = (n: NavDef, rail: boolean) => {
    const locked = stageLocked(ctx, n.need), active = activeKey === n.key
    const showCount = n.key === 'approvals' && (locked ? asks > 0 : count > 0)
    return <NavItem key={n.key} marked hush={!phone} rail={rail} icon={n.icon} label={n.label} active={active} locked={locked} onClick={() => go(n.key)}
      count={showCount ? (locked ? asks : count) : undefined} countLabel={`${locked ? asks : count} waiting`} tag={locked ? STAGE_TAGS[n.need] : undefined} />
  }
  const openChatId = openChatKey({ fresh, chatId }, ctx.data)
  const chats = chatEntries(ctx.data, started, ctx.agent)
  const pinned = chats.filter(c => c.pinned)
  const recent = chats.filter(c => !c.pinned).slice(0, ctx.data.chat.recentCount)
  const chatRow = (c: (typeof chats)[number]) => (
    <ChatRow key={c.id} chat={c} open={page === 'chats' && !chatList && openChatId === c.id}
      running={!!runs[c.id]} onClick={() => openChat(c.id)} />
  )

  // Collapsed on desktop: an icon rail with the same items, each named in a tooltip. Its icons sit where the full
  // sidebar's do (12px in, on one axis with the mark, Search and New chat), so on a collapse they hold their place
  // while the column narrows.
  if (rail) return (
    <aside id="sidebar" aria-label="Sidebar" className="group/side side-move relative z-sidebar box-border flex w-sidebar-rail flex-none flex-col items-start gap-px overflow-x-hidden overflow-y-auto pt-2 pb-3 pl-3">
      {line}
      <span className="ml-2.25 flex h-14.5 flex-none items-center">
        <InhouseMark size={22} />
      </span>
      <IconButton icon="search" label="Search" shortcut={SHORTCUTS.palette} size={18} onClick={() => patch({ palette: true })} variant="chrome" className="mt-1.75 ml-1" />
      <IconButton icon="edit_square" label="New chat" shortcut={SHORTCUTS.newChat} size={18} onClick={() => newChat()} variant="chrome" className="mt-1 ml-1" />
      <nav aria-label="Main" className="mt-4.5 flex flex-col items-center gap-px">
        {DAILY.map(n => navItem(n, true))}
        <div role="group" aria-label="Your agent" className="mt-1.5 flex flex-col items-center gap-px border-t border-divider pt-1.5">
          {AGENT.map(n => navItem(n, true))}
        </div>
      </nav>
      <div className="grow shrink-0 basis-3" />
      <div className="flex flex-none flex-col items-center gap-1.5">
        {team}
        {toggle}
        <AccountMenu>
          <NavItem marked hush rail tone="quiet" label={name} tip={name} aria-label={`${name}, account and settings`} active={meActive} className={OPEN_ROW}
            leading={<Avatar who={ctx.data.meta.currentUser.id} size={24} fontSize={10} cssInitials />} />
        </AccountMenu>
      </div>
    </aside>
  )

  // Each block is the rows' full width from the first frame of an expand, so nothing reflows while the column grows:
  // it is revealed. The drawer's card has a border, so its rows take the room it leaves.
  const block = phone ? '' : 'min-w-sidebar-inner'
  // A group's label. Its box has a set height, so the rows under it don't move when its font arrives (the marker is
  // placed from where the rows are).
  const label = 'mono-label box-border flex h-10.75 flex-none items-end px-2.5 pb-1.5'
  // A quiet text control (See all): with the rows, it waits a step quieter.
  const hushed = phone ? '' : 'text-foreground-3 transition-colors group-hover/side:text-foreground group-focus-within/side:text-foreground'
  const aside = (
      <aside id="sidebar" aria-label="Sidebar" className={cn('group/side relative isolate box-border flex w-sidebar flex-none flex-col overflow-x-hidden overflow-y-auto px-3 pt-2 pb-3',
        phone ? 'my-2.5 mr-0 ml-2.5 min-h-0 flex-1 rounded-2xl border border-border bg-card shadow-float' : 'side-move z-sidebar')}>
        {line}
        {/* As tall as the top bar and level with it. The mark sits on the nav icons' axis and the name starts on the labels' line. */}
        <div className={cn('flex h-14.5 flex-none items-center gap-2.5 pr-1 pl-2.25', block)}>
          <InhouseMark size={22} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold tracking-card">Inhouse</div>
            <div className="truncate text-xs text-muted-foreground">{ctx.data.meta.brand.name}</div>
          </div>
          <IconButton icon="edit_square" label="New chat" shortcut={SHORTCUTS.newChat} size={18} onClick={() => newChat()} variant="chrome" />
        </div>

        <div className={cn('mt-1.5 flex flex-col gap-px', block)}>
          <NavItem marked hush={!phone} icon="search" label="Search" aria-keyshortcuts={SHORTCUTS.palette.aria}
            onClick={() => patch(phone ? { sideOpen: false, palette: true } : { palette: true })}
            trailing={!phone && (
              mac
                ? <span aria-hidden="true" className="inline-flex items-center gap-0.75 text-xs text-muted-foreground"><span>⌘</span><span>K</span></span>
                : <span aria-hidden="true" className="text-xs text-muted-foreground">{SHORTCUTS.palette.label}</span>
            )} />
          <nav aria-label="Main" className="flex flex-col gap-px">
            {DAILY.map(n => navItem(n, false))}
            <div role="group" aria-labelledby="side-agent" className="flex flex-col gap-px">
              <div id="side-agent" className={label}>Your agent</div>
              {AGENT.map(n => navItem(n, false))}
            </div>
          </nav>
        </div>

        {pinned.length > 0 && (
          <div role="group" aria-labelledby="side-pinned" className={cn('flex flex-none flex-col', block)}>
            <div id="side-pinned" className={label}>Pinned</div>
            {pinned.map(chatRow)}
          </div>
        )}
        {/* No chats yet (day one, or every one deleted): no heading over an empty list. */}
        {chats.length > 0 && <>
        <div className={cn('box-border flex h-11.25 flex-none items-center justify-between px-2.5 pt-5.5 pb-1.5', block)}>
          <span className="mono-label">Recent chats</span>
          <Button variant="link" size="sm" data-chat-fallback className={cn('text-xs font-medium', !(page === 'chats' && chatList) && hushed)} aria-current={page === 'chats' && chatList ? 'page' : undefined} onClick={openChatList}>See all</Button>
        </div>
        <div role="group" aria-label="Recent chats" className={cn('flex flex-none flex-col', block)}>{recent.map(chatRow)}</div>
        </>}

        <div className="grow shrink-0 basis-3" />
        {/* The account row, the Inhouse team button and on desktop the collapse button, in line with New chat above. */}
        <div className={cn('flex flex-none items-center gap-1 pr-1', block)}>
          <AccountMenu>
            <NavItem marked hush={!phone} tone="quiet" avatar label={name} aria-label={`${name}, account and settings`} active={meActive} className={cn(OPEN_ROW, 'min-w-0 flex-1')} leading={<Avatar who={ctx.data.meta.currentUser.id} size={24} fontSize={10} cssInitials />}
              trailing={phone && <Icon name="unfold_more" size={16} className="text-faint" />} />
          </AccountMenu>
          {team}
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
