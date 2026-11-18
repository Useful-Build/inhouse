// An open file has its own link (#/library/<file id>), so Back closes it and a link opens it. The Library keeps `openId`
// in step with the hash; App only leaves a #/library/... hash alone.
import { useSyncExternalStore } from 'react'
import type { LibraryLink } from '../../agent'
import { useUi } from '../../state/store'

/** The file the hash names, or null. */
export function fileIdFromHash(): string | null {
  const m = /^#\/library\/(.+)$/.exec(location.hash)
  if (!m) return null
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

// pushState and replaceState don't fire hashchange, so the Library's own moves tell its listeners themselves.
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(l => l())
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  window.addEventListener('hashchange', cb)
  return () => { listeners.delete(cb); window.removeEventListener('hashchange', cb) }
}
/** The open file's id, read from the hash (so Back, Forward and a link change it). */
export const useOpenFileId = (): string | null => useSyncExternalStore(subscribe, fileIdFromHash)

const LIST_HASH = '#/library'
/** Marks the history entry the Library pushed for a file, so Close can step back over it. */
const PUSHED = { libraryFile: true }
const pushed = () => !!history.state && typeof history.state === 'object' && 'libraryFile' in history.state

/** A file opens: a new entry, so Back closes it. */
export function pushFile(id: string) { history.pushState(PUSHED, '', `${LIST_HASH}/${encodeURIComponent(id)}`); changed() }
/** Stepping to the next or previous file replaces the entry: Back still closes the viewer in one step. */
export function replaceFile(id: string) { history.replaceState(history.state, '', `${LIST_HASH}/${encodeURIComponent(id)}`); changed() }
/**
 * Closes the viewer. When the Library pushed the entry, Back does it (and the hashchange closes the viewer). Otherwise
 * (a link opened straight on the file) the entry becomes the list's.
 */
export function closeFile() {
  if (pushed()) {
    // A double click or a held Escape closes twice before the hashchange arrives, and a second Back would leave the Library.
    if (closing) return
    closing = true
    history.back()
  } else dropFileEntry()
}
/** Set from Back until the browser reports the move, so Close steps back once. */
let closing = false
window.addEventListener('popstate', () => { closing = false })
window.addEventListener('hashchange', () => { closing = false })
/** Replaces the file's entry with the list's, for a file that can't open. */
export function dropFileEntry() { history.replaceState(null, '', LIST_HASH); changed() }
/**
 * The viewer's link to where a file came from. A chat or Routines takes the file's entry (replaced with the page's own
 * hash, so App's route effect finds it already there and adds nothing), leaving [list, chat]: Back lands on the list.
 * An approval opens over the list, so the file closes like any Close. Going Back makes App's hashchange handler close
 * every open panel, so the approval opens again once that has run (this listener is added after App's).
 */
export function leaveFile(link: LibraryLink) {
  if (link.to === 'chat') history.replaceState(null, '', `#/chats/${encodeURIComponent(link.id)}`)
  else if (link.to === 'routines') history.replaceState(null, '', '#/routines')
  else {
    if (pushed()) window.addEventListener('hashchange', () => useUi.getState().openProblem(link.id), { once: true })
    closeFile()
    return
  }
  changed()
}

/**
 * The Library's own breakpoint: from this width the places sit in a panel beside the files, below it they become chips
 * above them (before the files column gets squeezed). A window width, separate from App's 760px phone flag.
 */
const WIDE_QUERY = '(min-width: 1024px)'
/** Whether the window is at least 1024px wide. */
export function useWide(): boolean {
  return useSyncExternalStore(
    cb => { const m = matchMedia(WIDE_QUERY); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) },
    () => matchMedia(WIDE_QUERY).matches,
  )
}
