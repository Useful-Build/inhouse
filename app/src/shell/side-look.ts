// Design exploration (branch design/sidebar-iterations): the sidebar's look, switched live from the demo switches.
// The winner folds into the Sidebar and index.css, and this file goes.
import { create } from 'zustand'

/** `card` is today's floating card; `desk` a tinted desk with the page as a raised sheet; `ink` the same in brand ink; `paper` a flush white column. */
export type SideLook = 'card' | 'desk' | 'ink' | 'paper'
export const SIDE_LOOKS: [SideLook, string][] = [['card', 'Card'], ['desk', 'Desk'], ['ink', 'Ink'], ['paper', 'Paper']]

const KEY = 'inhouse.side-look'
const isLook = (v: unknown): v is SideLook => SIDE_LOOKS.some(([k]) => k === v)
function saved(): SideLook {
  try {
    const v = localStorage.getItem(KEY)
    return isLook(v) ? v : 'desk'
  } catch (e) {
    console.warn('Inhouse: could not read the sidebar look.', e)
    return 'desk'
  }
}

export const useSideLook = create<{ look: SideLook; setLook: (look: SideLook) => void }>(set => ({
  look: saved(),
  setLook: look => {
    try { localStorage.setItem(KEY, look) } catch (e) { console.warn('Inhouse: could not save the sidebar look.', e) }
    set({ look })
  },
}))
