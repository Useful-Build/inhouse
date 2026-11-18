// An open file has its own link (#/library/<file id>), so Back closes it and a link opens it. The Library keeps `openId`
// in step with the hash; App only leaves a #/library/... hash alone.
import { useSyncExternalStore } from 'react'

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
  if (pushed()) history.back()
  else dropFileEntry()
}
/** Replaces the file's entry with the list's, for a file that can't open or a viewer that leaves for a chat. */
export function dropFileEntry() { history.replaceState(null, '', LIST_HASH); changed() }

/** Whether the window is at least 1024px wide: below it the Library's places become chips above the files. */
export function useWide(): boolean {
  const mq = '(min-width: 1024px)'
  return useSyncExternalStore(
    cb => { const m = matchMedia(mq); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) },
    () => matchMedia(mq).matches,
  )
}
