// The app's keyboard shortcuts: ⌘K (or Ctrl+K) opens and closes the command palette, ⌘⇧O starts a new chat and ⌘\ collapses
// the sidebar. They live in the shell, not in the palette, so the palette's chunk (cmdk and its list) can load when it is
// first opened or the browser is idle instead of with Today's first paint (scripts/check-bundle.mjs).
import { useEffect } from 'react'
import { useUi } from '../state/store'
import { mac } from './nav'

/** Typing in a field: shortcuts other than ⌘K leave the keys to it. */
const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.matches('input, textarea, select, [role="textbox"]'))

/** Whether the event is this letter: by the key, else by its place on the keyboard when the key isn't a Latin letter (a non-Latin layout). */
const isKey = (e: KeyboardEvent, letter: string) => {
  const k = e.key.toLowerCase()
  return k === letter || (!/^[a-z]$/.test(k) && e.code === `Key${letter.toUpperCase()}`)
}

export function useShortcuts() {
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
