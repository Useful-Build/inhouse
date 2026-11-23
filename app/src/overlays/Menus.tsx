import { Fragment, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { agent } from '../agent'
import type { AgentNotification } from '../agent'
import { useAgentData, useAgentState, useCtx, useUi } from '../state/store'
import { openRequests, userName } from '../state/derive'
import { fmtWhen } from '../lib/format'
import { display, nowOf } from '../state/display'
import { Avatar, EmptyState, Icon, IconTile, MenuItem } from '../ui'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PHONE_QUERY } from '../components/Composer'
import { signOutAction } from './account'

type Notice = AgentNotification & { go: () => void }
/** A role as the menu names it. */
const ROLE_NAMES = { admin: 'Admin', member: 'Member', inhouse: 'Inhouse team' } as const

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
              <span className="mt-0.5 block text-xs text-muted-foreground">{n.who} · {fmtWhen(n.at, nowOf(), display())}</span>
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
  const meta = data.meta.currentUser
  // Who is signed in comes from `me()`; before it loads (and in tests of the shell) the data's own current user stands in.
  const me = useSyncExternalStore(agent.subscribe, agent.me)
  const id = me?.memberId ?? meta.id
  const name = userName({ agent: useAgentState(), data })
  const role = me ? ROLE_NAMES[me.role] : meta.role
  const email = me ? me.email ?? '' : meta.email
  const go = useUi(s => s.go)
  // The count beside "Your Inhouse team" is the team window's "Open requests" list, counted the same way.
  const open = openRequests(useCtx(), nowOf(), false, useUi(s => s.teamWithdrawn)).length
  type Item = [icon: string, label: string, run: () => void, trailing?: ReactNode]
  // A window an item opens gives focus back to the button that opened this menu, not to the menu item about to close:
  // focus that button first, so the window remembers it as its trigger.
  const focusTrigger = () => document.querySelector<HTMLElement>('button[aria-haspopup="menu"][aria-expanded="true"]')?.focus()
  // Report a bug and Send feedback are request types in the team window, so the menu has one entry for the team.
  const groups: Item[][] = [[
    ['person', 'Your settings', () => openSettings('you-general')],
    ['admin_panel_settings', 'Team settings', () => openSettings('team-plan')],
    ['monitoring', 'Usage', () => go('usage')],
  ], [
    ['support_agent', 'Your Inhouse team', () => { focusTrigger(); openTeam('tool') },
      open > 0 ? <span className="ml-auto text-xs text-muted-foreground tabular-nums">{open} open</span> : undefined],
    ['menu_book', 'Help and guides', () => { focusTrigger(); openPop('help') }],
  ], [
    // The product signs out through Access (`signOutUrl()`); the demo has no sign-in.
    ['logout', 'Sign out', () => {
      const out = signOutAction(agent.signOutUrl())
      // The chat socket closes first, so nothing is followed while the sign-in ends.
      if ('go' in out) { agent.disconnect(); window.location.assign(out.go); return }
      patch({ pop: null, sideOpen: false }); showToast("Sign out isn't connected in this demo.", { icon: 'info', ms: 4000 })
    }],
  ]]
  // The pop only clears if it is still 'me': an item may have opened another one (Help, the team window) already.
  // Where the menu opened: an item that moves to another page leaves focus there (the page focuses its heading).
  const openedOn = useRef('')
  // What RouteFocus (App.tsx `focusKey`) treats as a route: the page, plus a tool's key, plus the phone Settings menu.
  const focusSlug = () => {
    const [s, sub] = location.hash.slice(2).split('/')
    const menu = s === 'settings' && useUi.getState().setMenu && window.matchMedia(PHONE_QUERY).matches
    return s === 'tools' && sub ? `${s}/${sub}` : menu ? `${s}/menu` : s
  }
  // Whether the phone drawer holding the Settings button was open when the menu opened.
  const inDrawer = useRef(false)
  const onOpenChange = (o: boolean) => { if (o) { openedOn.current = focusSlug(); inDrawer.current = useUi.getState().sideOpen; openPop('me') } else if (useUi.getState().pop === 'me') patch({ pop: null }) }
  // Where focus goes when the menu closes. A window an item opened takes it, and so does a page an item moved to (its
  // heading). An item that closed the phone drawer holding the Settings button gives it to the Menu button that opened
  // the drawer. Otherwise it returns to the Settings button.
  const onCloseAutoFocus = (e: Event) => {
    const { pop: p, sideOpen } = useUi.getState()
    if (p === 'help' || p === 'team' || focusSlug() !== openedOn.current) { e.preventDefault(); return }
    // The drawer may still be animating out here, so its state says whether the Settings button is going away.
    if (inDrawer.current && !sideOpen) {
      e.preventDefault()
      document.querySelector<HTMLElement>('[data-drawer-opener]')?.focus()
    }
  }
  return (
    <DropdownMenu modal={false} open={pop === 'me'} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" aria-label="Account" aria-labelledby={undefined} className="w-menu-account p-2"
        onCloseAutoFocus={onCloseAutoFocus}
        // Escape closes only this menu, not the phone drawer behind it (App's window listener).
        // Only while it's open: a closing menu still hears keys during its exit animation, and the window an item opened needs this Escape.
        onEscapeKeyDown={e => { if (useUi.getState().pop === 'me') e.stopPropagation() }}>
        <DropdownMenuLabel className="flex items-center gap-3 px-2.5 pt-2.5 pb-3 text-foreground">
          <Avatar who={id} size={38} fontSize={13} />
          <div><div className="text-base font-semibold">{name}</div><div className="text-xs font-normal text-muted-foreground">{email} · {role}</div></div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="mx-1.5 mt-0" />
        {groups.map((items, g) => (
          <Fragment key={items[0][1]}>
            {g > 0 && <DropdownMenuSeparator className="mx-1.5" />}
            {items.map(([icon, t, fn, trailing]) => (
              <MenuItem key={t} className="gap-2.75 py-0" onSelect={fn}>
                <Icon name={icon} size={18} className="text-foreground-3" />{t}{trailing && ' '}{trailing}
              </MenuItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
