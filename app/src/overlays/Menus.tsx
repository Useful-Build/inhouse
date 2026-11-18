import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { agent } from '../agent'
import type { AgentNotification } from '../agent'
import { useAgentData, useAgentState, useUi } from '../state/store'
import { userName } from '../state/derive'
import { Avatar, EmptyState, Icon, IconTile, MenuItem } from '../ui'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type Notice = AgentNotification & { go: () => void }

/** The bell's notifications, newest first, as the agent sends them. Opening one marks it read; Mark all as read marks every one listed now. */
// oxlint-disable-next-line react/only-export-components -- the top bar reads the unread count for the bell's name.
export function useNotices(): Notice[] {
  const list = useSyncExternalStore(agent.subscribe, agent.listNotifications)
  const { go, openTool, openChat } = useUi.getState()
  const goTo = (link: AgentNotification['link']) =>
    link.to === 'tool' ? () => openTool(link.key) : link.to === 'chat' ? () => openChat(link.id) : () => go(link.page)
  return list.map(n => ({ ...n, go: goTo(n.link) }))
}

/** The notifications pop-up. `children` is the bell: the pop-up opens from it and focus returns to it on close. */
export function Notifications({ children }: { children: ReactNode }) {
  const pop = useUi(s => s.pop)
  const patch = useUi(s => s.patch)
  const items = useNotices()
  const unread = items.filter(n => n.unread).length
  // Never "all caught up" above a line that says something is waiting.
  const caughtUp = unread === 0 && !items.some(n => n.waiting)
  const markRead = (ids: string[]) => { agent.markNoticesRead(ids).catch(e => console.warn('Inhouse: could not mark notifications read.', e)) }
  return (
    <Popover open={pop === 'notif'} onOpenChange={o => patch({ pop: o ? 'notif' : null })}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" collisionPadding={16} aria-label="Notifications" className="w-popover-notifications p-2"
        // Escape closes only this popover. Only while it's open: a closing one still hears keys during its exit animation.
        onEscapeKeyDown={e => { if (useUi.getState().pop === 'notif') e.stopPropagation() }}>
        <div className="flex items-center px-3 pt-2.5 pb-2">
          <h2 className="flex-1 text-md font-semibold">Notifications</h2>
          {unread > 0 && <button type="button" className="rounded-xs text-sm text-foreground-3" onClick={() => markRead(items.map(n => n.id))}>Mark all as read</button>}
        </div>
        {caughtUp && <EmptyState variant="inline" className="my-0 px-3 pt-0 pb-2.5 text-left text-sm">You're all caught up</EmptyState>}
        {items.map(n => (
          <button key={n.id} type="button" className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-accent focus-within:bg-accent"
            onClick={() => { markRead([n.id]); n.go() }}>
            {n.person
              ? <Avatar who={n.person} size={34} fontSize={13} />
              : <IconTile icon={n.icon} />}
            <span className="min-w-0 flex-1">
              <span className="block text-base leading-menu">{n.text}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{n.who} · {n.at}</span>
            </span>
            {n.unread && <><span className="sr-only">Unread</span><i aria-hidden="true" className="mt-1.75 size-1.75 flex-none rounded-full bg-foreground" /></>}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** The account menu. `children` is the trigger button (Settings in the sidebar); the menu opens above it. */
export function AccountMenu({ children }: { children: ReactNode }) {
  const pop = useUi(s => s.pop)
  const patch = useUi(s => s.patch)
  const openSettings = useUi(s => s.openSettingsMenu)
  const openTeam = useUi(s => s.openTeam)
  const openPop = useUi(s => s.openPop)
  const showToast = useUi(s => s.showToast)
  const data = useAgentData()
  const me = data.meta.currentUser
  const name = userName({ agent: useAgentState(), data })
  const items: [string, string, () => void][] = [
    ['person', 'Your settings', () => openSettings('you-general')],
    ['admin_panel_settings', 'Team settings', () => openSettings('team-plan')],
    ['menu_book', 'Help and guides', () => {
      // Focus goes back to the Settings button that opened this menu, not to the menu item that is about to close.
      document.querySelector<HTMLElement>('button[aria-haspopup="menu"][aria-expanded="true"]')?.focus()
      openPop('help')
    }],
    ['bug_report', 'Report a bug', () => openTeam('bug')],
    ['campaign', 'Send feedback', () => openTeam('feedback')],
    ['logout', 'Sign out', () => { patch({ pop: null, sideOpen: false }); showToast("Sign out isn't connected in this demo.", { icon: 'info', ms: 4000 }) }],
  ]
  // The pop only clears if it is still 'me': an item may have opened another one (Help, the team window) already.
  const onOpenChange = (o: boolean) => { if (o) openPop('me'); else if (useUi.getState().pop === 'me') patch({ pop: null }) }
  return (
    <DropdownMenu modal={false} open={pop === 'me'} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" aria-label="Account" aria-labelledby={undefined} className="w-menu-account p-2"
        // A window opened by an item takes focus itself; otherwise focus returns to the Settings button.
        onCloseAutoFocus={e => { const p = useUi.getState().pop; if (p === 'help' || p === 'team') e.preventDefault() }}
        // Escape closes only this menu, not the phone drawer behind it (App's window listener).
        // Only while it's open: a closing menu still hears keys during its exit animation, and the window an item opened needs this Escape.
        onEscapeKeyDown={e => { if (useUi.getState().pop === 'me') e.stopPropagation() }}>
        <DropdownMenuLabel className="flex items-center gap-3 px-2.5 pt-2.5 pb-3 text-foreground">
          <Avatar who={me.id} size={38} fontSize={13} />
          <div><div className="text-base font-semibold">{name}</div><div className="text-xs font-normal text-muted-foreground">{me.email} · {me.role}</div></div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="mx-1.5 mt-0" />
        {items.map(([icon, t, fn]) => (
          <MenuItem key={t} className="gap-2.75 py-0" onSelect={fn}>
            <Icon name={icon} size={18} className="text-foreground-3" />{t}
          </MenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
