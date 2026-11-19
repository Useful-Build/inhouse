import { useEffect, useRef, useState } from 'react'
import { capStatus, flags, toolDetail } from '../state/derive'
import { chatEntries, openChatKey, useAgentState, useCtx, useUi } from '../state/store'
import { cn } from '@/lib/utils'
import { AgentMark, Button, Icon, IconButton } from '../ui'
import { Notifications, useNotices } from '../overlays/Menus'
import { DemoButton } from './DevSwitcher'
import { ChatMenu, ChatTitleInput } from '../ui/chat'
import { TAP } from '../ui/fields'
import { SHORTCUTS } from './nav'

export function TopBar() {
  const ctx = useCtx()
  const agentState = useAgentState()
  const page = useUi(s => s.page)
  const fresh = useUi(s => s.fresh)
  const chatId = useUi(s => s.chatId)
  const chatList = useUi(s => s.chatList)
  const started = useUi(s => s.started)
  const pop = useUi(s => s.pop)
  const phone = useUi(s => s.phone)
  const sideOpen = useUi(s => s.sideOpen)
  const sideCollapsed = useUi(s => s.sideCollapsed)
  const { patch, togglePause, renameChat, showToast, toggleSidebar } = useUi.getState()
  // The chat whose title is being edited in the bar, so moving to another chat ends it.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const titleArea = useRef<HTMLDivElement>(null)
  // Set when a key ends the rename: focus then goes back to the chat's menu trigger (the title on a phone).
  const refocus = useRef(false)
  const f = flags(ctx)
  const paused = !!agentState.paused
  const openKey = openChatKey({ fresh, chatId }, ctx.data)
  const openChat = openKey === null ? undefined : chatEntries(ctx.data, started, agentState).find(c => c.id === openKey)
  // Every other page shows its own h1 (All chats too), so the bar names only Today and the open chat, on a phone too.
  const title = page === 'today' ? 'Today' : page === 'chats' && !chatList ? (fresh ? 'New chat' : openChat?.title ?? '') : ''
  const unread = useNotices().filter(n => n.unread).length
  // The sidebar's icon rail has its own search button, and on a phone the drawer's header does.
  const railSearch = useUi(s => s.sideCollapsed) && !phone
  // The open conversation's own menu. Not for a new chat with nothing asked yet.
  const headerChat = page === 'chats' && !chatList && !fresh ? openChat : undefined
  const renaming = !!headerChat && renamingId === headerChat.id
  // On a phone the pill shows on Today only, so an open chat's title keeps the bar.
  const showPill = !f.cap && !f.noData && (ctx.S === 2 || (ctx.S === 1 && paused)) && !(phone && page !== 'today')
  useEffect(() => {
    if (renaming || !refocus.current) return
    refocus.current = false
    titleArea.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus()
  }, [renaming])
  const titleEl = <span data-topbar-title className="overflow-hidden font-semibold text-ellipsis text-foreground">{title}</span>

  return (
    <header className="relative flex h-14.5 items-center gap-1.5 bg-topbar-fade pr-4.5 pl-6">
      {phone && (
        <IconButton data-drawer-opener icon="menu" label="Menu" variant="chrome" size={21} aria-expanded={sideOpen} aria-controls={sideOpen ? 'sidebar' : undefined} onClick={() => patch({ sideOpen: true })} className={cn('-ml-2', TAP)} />
      )}
      {!phone && (
        <IconButton icon={sideCollapsed ? 'left_panel_open' : 'left_panel_close'} label="Sidebar" tip={sideCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} shortcut={SHORTCUTS.sidebar} variant="chrome" size={19}
          aria-expanded={!sideCollapsed} aria-controls="sidebar" onClick={toggleSidebar} className="-ml-2" />
      )}
      <div ref={titleArea} className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-sm whitespace-nowrap text-muted-foreground">
        {headerChat && renaming ? (
          <ChatTitleInput key={headerChat.id} title={headerChat.title} size="sm" className="max-w-page-narrow font-semibold"
            onDone={(t, byKey) => { if (t !== null) renameChat(headerChat.id, t); refocus.current = byKey; setRenamingId(null) }} />
        ) : !(headerChat && phone) && titleEl}
        {headerChat && (
          <ChatMenu chat={headerChat} box="icon-sm" focusAfter={() => () => {
            // The open chat may be gone: land on the menu of the chat the bar shows now, else the new chat's composer.
            (titleArea.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? document.querySelector<HTMLElement>('main [data-composer] textarea'))?.focus()
          }} className={cn('flex-none', renaming && 'invisible')} onRename={() => setRenamingId(headerChat.id)}
            onExport={() => showToast("Export isn't connected in this demo.", { icon: 'info', ms: 4000 })}>
            {/* On a phone the title opens the menu, so a "···" button doesn't take the title's room. */}
            {phone ? <button type="button" aria-label={`Chat actions, ${headerChat.title}`} className={cn('-ml-1 flex min-h-11 min-w-0 items-center rounded-md px-1 focus-visible:-outline-offset-2', renaming && 'hidden')}>{titleEl}</button> : undefined}
          </ChatMenu>
        )}
      </div>
      {showPill && (
        <div role="status" aria-label={paused ? 'Inhouse agent is paused' : 'Inhouse agent is running'} className={cn('mr-1.5 flex h-7.5 items-center gap-2 rounded-full py-0 pr-1 pl-2 text-xs font-strong whitespace-nowrap', paused ? 'bg-warning-tint text-warning-text' : 'bg-brand-tint text-brand')}>
          {paused ? <Icon name="pause_circle" size={16} weight={400} /> : <AgentMark scale={0.75} />}
          <span>{phone ? (paused ? 'Paused' : 'Running') : paused ? 'Inhouse agent is paused' : 'Inhouse agent is running'}</span>
          <Button variant="surface" size="xs" onClick={togglePause}>
            <Icon name={paused ? 'play_arrow' : 'pause'} size={14} />{paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
      )}
      {!railSearch && !phone && <IconButton icon="search" label="Search" shortcut={SHORTCUTS.palette} variant="chrome" size={19} onClick={() => patch({ palette: true })} />}
      <div className="relative flex-none">
        <Notifications>
          <IconButton icon="notifications" label={unread ? `Notifications, ${unread} unread` : 'Notifications'} variant="chrome" size={19} aria-expanded={pop === 'notif'} className={cn('aria-expanded:bg-accent', phone && TAP)} />
        </Notifications>
        {unread > 0 && <i aria-hidden="true" className="pointer-events-none absolute top-1.5 right-1.75 size-2 rounded-full border-hairline border-background bg-foreground" />}
      </div>
      <DemoButton />
    </header>
  )
}

/** Tool disconnected and cap reached banners (not on Settings). */
export function Banner() {
  const ctx = useCtx()
  const page = useUi(s => s.page)
  const { openTool, openSettings } = useUi.getState()
  const f = flags(ctx)
  if (page === 'settings') return null
  // The disconnected tool, its time and the cap's amounts come from the agent's data and Settings.
  const lost = ctx.data.scenarios.toolDisconnected
  const lostName = f.disc ? toolDetail(ctx.data, lost.tool).name : ''
  const b = f.disc
    ? { cls: 'bg-warning-tint text-warning-on-tint', icon: 'link_off', title: `${lostName} is disconnected.`, text: `The login expired at ${lost.at}, so your Inhouse agent couldn't read ${lostName} this morning. Customer issues may be missing from today's list.`, cta: 'Reconnect', go: () => openTool(lost.tool) }
    : f.cap
      ? { cls: 'bg-destructive-tint text-destructive-text', icon: 'savings', title: 'Spending cap reached.', text: capStatus(ctx).bannerText, cta: 'Raise the cap', go: () => openSettings('team-spend') }
      : null
  if (!b) return null
  return (
    <div className="relative z-raised mx-auto mt-0 mb-1.5 max-w-page-wide px-(--app-pad-x)">
      <div role="alert" className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl py-2.5 pr-3 pl-3.5 text-sm', b.cls)}>
        <Icon name={b.icon} size={18} weight={400} />
        <span className="min-w-0 grow basis-65"><b className="font-semibold">{b.title}</b> {b.text}</span>
        <Button variant="surface" onClick={b.go}>{b.cta}</Button>
      </div>
    </div>
  )
}
