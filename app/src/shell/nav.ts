// The app's pages as the sidebar, the top bar and the command palette name them.
import type { Page } from '../state/store'

export type NavDef = { icon: string; label: string; key: Page; need: 0 | 1 | 2 }
export const PRIMARY: NavDef[] = [
  { icon: 'wb_twilight', label: 'Today', key: 'today', need: 0 },
  { icon: 'folder_open', label: 'Library', key: 'library', need: 0 },
  { icon: 'task_alt', label: 'Approvals', key: 'approvals', need: 1 },
  { icon: 'event_repeat', label: 'Routines', key: 'routines', need: 1 },
  { icon: 'history', label: 'Activity', key: 'activity', need: 0 },
]
export const SECONDARY: NavDef[] = [
  { icon: 'widgets', label: 'Tools', key: 'apps', need: 0 },
  { icon: 'menu_book', label: 'Skills', key: 'skills', need: 0 },
  { icon: 'monitoring', label: 'Usage', key: 'usage', need: 0 },
]

// ---------- keyboard shortcuts ----------
export const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
/** A shortcut as this device writes it: ⌘⇧O on a Mac, Ctrl+Shift+O elsewhere. */
const show = (shift: boolean, key: string) => (mac ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`)
/** Each shortcut's label (tooltips, the palette) and its `aria-keyshortcuts` value. */
export const SHORTCUTS = {
  palette: { label: show(false, 'K'), aria: mac ? 'Meta+K' : 'Control+K' },
  newChat: { label: show(true, 'O'), aria: mac ? 'Meta+Shift+O' : 'Control+Shift+O' },
  sidebar: { label: show(false, '\\'), aria: mac ? 'Meta+\\' : 'Control+\\' },
} as const
