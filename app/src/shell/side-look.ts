// Design exploration (branch design/sidebar-iterations): the sidebar's look and style, switched live from the demo
// switches. The winner folds into the Sidebar and index.css, and this file goes.
import { create } from 'zustand'

/**
 * `line`: no surfaces, the sidebar sits on the page's own wall behind one hairline, and the selected row is marked on it.
 * `edge`: the sidebar sits on a grey desk, the page is a sheet, and the same marker rides the sheet's edge.
 */
export type SideLook = 'line' | 'edge'
export const SIDE_LOOKS: [SideLook, string][] = [['line', 'Line'], ['edge', 'Edge']]
/**
 * A variation on either look. `bare`: the mark without its tile, on the icons' axis. `stamp`: the mark on an ink tile.
 * `fine`: finer icons and tighter rows. `ruled`: a hairline over each group and the account row. `best`: the mix I'd ship.
 */
export type SideStyle = 'base' | 'bare' | 'stamp' | 'fine' | 'ruled' | 'best'
export const SIDE_STYLES: [SideStyle, string][] = [['base', 'Base'], ['bare', 'Bare'], ['stamp', 'Stamp'], ['fine', 'Fine'], ['ruled', 'Ruled'], ['best', 'Best']]
/** What each style turns on (index.css matches these words in data-side-style). */
export const STYLE_PARTS: Record<SideStyle, string> = { base: '', bare: 'bare', stamp: 'stamp', fine: 'fine', ruled: 'ruled', best: 'bare fine' }
/** Today's card buttons: every one in ink (today's), or ink on urgent cards only. */
export type CardButtons = 'ink' | 'urgent'
export const CARD_BUTTONS: [CardButtons, string][] = [['ink', 'All ink'], ['urgent', 'Urgent only']]

const LOOK_KEY = 'inhouse.side-look'
const STYLE_KEY = 'inhouse.side-style'
const CARDS_KEY = 'inhouse.card-buttons'
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

export const useSideLook = create<{
  look: SideLook; style: SideStyle; cards: CardButtons
  setLook: (look: SideLook) => void; setStyle: (style: SideStyle) => void; setCards: (cards: CardButtons) => void
}>(set => ({
  look: saved(LOOK_KEY, SIDE_LOOKS, 'line'),
  style: saved(STYLE_KEY, SIDE_STYLES, 'base'),
  cards: saved(CARDS_KEY, CARD_BUTTONS, 'ink'),
  setLook: look => { save(LOOK_KEY, look); set({ look }) },
  setStyle: style => { save(STYLE_KEY, style); set({ style }) },
  setCards: cards => { save(CARDS_KEY, cards); set({ cards }) },
}))
