// The command palette (⌘K or Ctrl+K): jump to a page, a settings page or a chat, or run an action. Also the app's
// keyboard shortcuts, since they live and die with it: ⌘K, ⌘⇧O (new chat) and ⌘\ (collapse the sidebar).
import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { STAGE_TAGS } from '../state/derive'
import { chatEntries, useCtx, useUi } from '../state/store'
import { defaultFilter } from 'cmdk'
import { useTheme } from '@/lib/theme'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Icon, StageTag } from '../ui'
import { keepForToast } from '../ui/dialogs'
import { NO_MOTION } from '../ui/motion'
import { menuFor } from '../screens/settings/menu'
import { mac, PAGES, SHORTCUTS } from '../shell/nav'
import { demo } from '../agent'
import { demoEnabled } from '../shell/demo'

/** Words a settings page is also found by, by its tab: Models was called Thinking modes. */
const EXTRA: Record<string, string[]> = { 'team-modes': ['thinking', 'models'] }

/** Typing in a field: shortcuts other than ⌘K leave the keys to it. */
const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.matches('input, textarea, select, [role="textbox"]'))

/** Whether the event is this letter: by the key, else by its place on the keyboard when the key isn't a Latin letter (a non-Latin layout). */
const isKey = (e: KeyboardEvent, letter: string) => {
  const k = e.key.toLowerCase()
  return k === letter || (!/^[a-z]$/.test(k) && e.code === `Key${letter.toUpperCase()}`)
}

/** Search matches what an item shows and its keywords, not its internal value (an id). */
const filter = (_value: string, search: string, keywords?: string[]) => defaultFilter(keywords?.join(' ') ?? '', search)

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘ on a Mac, Ctrl elsewhere, as SHORTCUTS writes them: Ctrl+K stays the Mac's delete-to-end-of-line in a field.
      if (!(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.altKey) return
      const ui = useUi.getState()
      if (isKey(e, 'k') && !e.shiftKey) { e.preventDefault(); if (!e.repeat) ui.patch({ palette: !ui.palette }); return }
      if (typing(e.target)) return
      if (isKey(e, 'o') && e.shiftKey) { e.preventDefault(); if (!e.repeat) ui.newChat(); return }
      if ((e.code === 'Backslash' || e.key === '\\') && !e.shiftKey && !ui.phone) { e.preventDefault(); if (!e.repeat) ui.toggleSidebar() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function CommandPalette() {
  useShortcuts()
  const open = useUi(s => s.palette)
  const started = useUi(s => s.started)
  const ctx = useCtx()
  const { resolved, setTheme } = useTheme()
  const { patch, go, openSettings, openChat, newChat, openTeam, showToast, resetDemo } = useUi.getState()
  // What had focus when the palette opened: Escape gives focus back to it, and a window an item opens returns to it.
  const before = useRef<HTMLElement | null>(null)
  // Set when an item ran: its action decides where focus goes.
  const ran = useRef(false)

  /** Close first (no motion, so the dialog and its focus trap are gone at once), put focus back, then act. */
  const run = (fn: () => void) => {
    ran.current = true
    flushSync(() => patch({ palette: false }))
    if (before.current?.isConnected) before.current.focus()
    fn()
  }

  const chats = chatEntries(ctx.data, started, ctx.agent)
  const pages = PAGES

  return (
    <Dialog open={open} onOpenChange={o => patch({ palette: o })}>
      <DialogContent showCloseButton={false} aria-describedby={undefined} overlayProps={{ className: NO_MOTION }}
        onPointerDownOutside={keepForToast} onInteractOutside={keepForToast}
        // Escape closes only the palette, not the window, panel or Select mode under it (their window listeners).
        onEscapeKeyDown={e => e.stopPropagation()}
        className={`top-24 translate-y-0 gap-0 overflow-hidden rounded-2xl bg-popover p-0 shadow-menu ${NO_MOTION}`}
        onOpenAutoFocus={() => { ran.current = false; before.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null }}
        onCloseAutoFocus={e => {
          e.preventDefault()
          if (ran.current) { ran.current = false; return }
          const back = before.current?.isConnected ? before.current : document.querySelector<HTMLElement>('main')
          back?.focus()
        }}>
        <DialogTitle className="sr-only">Search</DialogTitle>
        {/* Escape closes the palette itself: a tooltip still opening on the button that opened it can otherwise take that Escape. */}
        <Command label="Search pages, chats and actions" loop filter={filter} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); patch({ palette: false }) } }}>
          <CommandInput placeholder="Search pages, chats and actions" className="h-12" />
          <CommandList>
            <CommandEmpty>No pages, chats or actions match.</CommandEmpty>
            <CommandGroup heading="Pages">
              {pages.map(n => {
                const locked = ctx.S < n.need
                const tag = STAGE_TAGS[n.need]
                return (
                  <CommandItem key={n.key} value={`page:${n.key}`} keywords={[n.label]}
                    className={locked ? 'text-foreground-3' : undefined}
                    onSelect={() => run(locked ? () => showToast(`${n.label} is included from the ${tag} stage.`, { icon: 'lock' }) : () => go(n.key))}>
                    <Icon name={n.icon} size={18} className="text-foreground-3" />
                    <span className="flex-1">{n.label}</span>
                    {locked && <StageTag tag={tag} />}
                  </CommandItem>
                )
              })}
            </CommandGroup>
            <CommandGroup heading="Settings">
              {menuFor(ctx.data.tools, demo === null).flatMap(sec => sec.pages).map(({ id: tab, icon, label }) => (
                <CommandItem key={tab} value={`settings:${tab}`} keywords={[label, 'Settings', ...(EXTRA[tab] ?? [])]} onSelect={() => run(() => openSettings(tab))}>
                  <Icon name={icon} size={18} className="text-foreground-3" />
                  <span className="flex-1">{label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {chats.length > 0 && (
              <CommandGroup heading="Chats">
                {chats.map(c => (
                  <CommandItem key={c.id} value={`chat:${c.id}`} keywords={[c.title]} onSelect={() => run(() => openChat(c.id))}>
                    <Icon name={c.pinned ? 'keep' : 'chat_bubble'} size={18} className="text-foreground-3" />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="Actions">
              <CommandItem value="action:new-chat" keywords={['New chat']} onSelect={() => run(() => newChat())}>
                <Icon name="edit_square" size={18} className="text-foreground-3" /><span className="flex-1">New chat</span>
                <CommandShortcut className="font-sans">{SHORTCUTS.newChat.label}</CommandShortcut>
              </CommandItem>
              <CommandItem value="action:team" keywords={['Message the team']} onSelect={() => run(() => openTeam('tool'))}>
                <Icon name="support_agent" size={18} className="text-foreground-3" /><span className="flex-1">Message the team</span>
              </CommandItem>
              <CommandItem value="action:bug" keywords={['Report a bug']} onSelect={() => run(() => openTeam('bug'))}>
                <Icon name="bug_report" size={18} className="text-foreground-3" /><span className="flex-1">Report a bug</span>
              </CommandItem>
              <CommandItem value="action:theme" keywords={[resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', 'Theme', 'Dark', 'Light']} onSelect={() => run(() => setTheme(resolved === 'dark' ? 'light' : 'dark'))}>
                <Icon name={resolved === 'dark' ? 'light_mode' : 'dark_mode'} size={18} className="text-foreground-3" />
                <span className="flex-1">{resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}</span>
              </CommandItem>
              {demoEnabled() && (
                <CommandItem value="action:reset" keywords={['Reset demo']} onSelect={() => run(() => { resetDemo(); showToast('Demo reset. Every change is cleared.', { ms: 4000 }) })}>
                  <Icon name="restart_alt" size={18} className="text-foreground-3" /><span className="flex-1">Reset demo</span>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
