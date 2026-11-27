// Design exploration (branch design/sidebar-iterations): the sidebar's look and its search control, switched live from
// the demo switches. The winner folds into the Sidebar and index.css, and this file goes.
import { create } from 'zustand'

/**
 * `desk`: the sidebar sits flush on a grey desk and the page is a sheet inset on all sides; the selected row is a white chip.
 * `gallery`: no surfaces, the sidebar sits on the page's own wall behind one hairline; the selected row is a white chip.
 * `line`: gallery, but the selected row is marked on the hairline itself, and the sidebar stays quiet until approached.
 * `edge`: desk, with the same marker riding the sheet's edge.
 */
export type SideLook = 'desk' | 'gallery' | 'line' | 'edge'
export const SIDE_LOOKS: [SideLook, string][] = [['desk', 'Desk'], ['gallery', 'Gallery'], ['line', 'Line'], ['edge', 'Edge']]
/** Search as a nav row (today's), or as a field with its shortcut on a key cap. Either opens the same palette. */
export type SideSearch = 'row' | 'field'
export const SIDE_SEARCHES: [SideSearch, string][] = [['row', 'Row'], ['field', 'Field']]

const LOOK_KEY = 'inhouse.side-look'
const SEARCH_KEY = 'inhouse.side-search'
function saved<T extends string>(key: string, options: [T, string][], fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return options.find(([k]) => k === v)?.[0] ?? fallback
  } catch (e) {
    console.warn('Inhouse: could not read the sidebar look.', e)
    return fallback
  }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch (e) { console.warn('Inhouse: could not save the sidebar look.', e) }
}

export const useSideLook = create<{ look: SideLook; search: SideSearch; setLook: (look: SideLook) => void; setSearch: (search: SideSearch) => void }>(set => ({
  look: saved(LOOK_KEY, SIDE_LOOKS, 'desk'),
  search: saved(SEARCH_KEY, SIDE_SEARCHES, 'row'),
  setLook: look => { save(LOOK_KEY, look); set({ look }) },
  setSearch: search => { save(SEARCH_KEY, search); set({ search }) },
}))
