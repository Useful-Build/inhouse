// Design exploration (branch design/sidebar-iterations): the sidebar's look and the desk's tone, switched live from the
// demo switches. The winner folds into the Sidebar and index.css, and this file goes.
import { create } from 'zustand'

/**
 * `desk`: the sidebar sits flush on a desk and the page is a sheet inset on all sides. `lifted`: the same with more room,
 * a rounder corner and a deeper shadow. `frame`: the sidebar and the top bar are one L-shaped chrome and the page fills
 * the rest. `gallery`: no surfaces at all, the sidebar sits on the page's own wall.
 */
export type SideLook = 'desk' | 'lifted' | 'frame' | 'gallery'
export const SIDE_LOOKS: [SideLook, string][] = [['desk', 'Desk'], ['lifted', 'Lifted'], ['frame', 'Frame'], ['gallery', 'Gallery']]
/** The desk's color: plain grey, a cool step toward the brand's sapphire, or a warm stone. Gallery has no desk. */
export type SideTone = 'neutral' | 'slate' | 'stone'
export const SIDE_TONES: [SideTone, string][] = [['neutral', 'Neutral'], ['slate', 'Slate'], ['stone', 'Stone']]

const LOOK_KEY = 'inhouse.side-look'
const TONE_KEY = 'inhouse.side-tone'
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

export const useSideLook = create<{ look: SideLook; tone: SideTone; setLook: (look: SideLook) => void; setTone: (tone: SideTone) => void }>(set => ({
  look: saved(LOOK_KEY, SIDE_LOOKS, 'desk'),
  tone: saved(TONE_KEY, SIDE_TONES, 'neutral'),
  setLook: look => { save(LOOK_KEY, look); set({ look }) },
  setTone: tone => { save(TONE_KEY, tone); set({ tone }) },
}))
