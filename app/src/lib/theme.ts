// Light, dark or follow the system. The choice is saved per browser; index.html applies it before first paint.
// Importing this module (main.tsx does) keeps the page in step with the OS and with other tabs, whether or not
// anything is subscribed.
import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark' | 'system'
export const THEME_KEY = 'inhouse.theme'

const media = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

// Storage can be blocked (privacy settings, sandboxed frames). Then the theme is System and nothing is saved.
function stored(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function save(t: Theme) {
  try {
    if (t === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, t)
  } catch {
    // Blocked storage: the choice applies to this page only.
  }
}

// The choice in this tab. Starts from storage, so a blocked write still changes what this tab shows.
let current: Theme = stored()

function apply() {
  const dark = current === 'dark' || (current === 'system' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
  listeners.forEach(l => l())
}

apply()
media.addEventListener('change', apply)
window.addEventListener('storage', e => {
  if (e.key !== THEME_KEY && e.key !== null) return
  current = stored()
  apply()
})

export function setTheme(t: Theme) {
  current = t
  save(t)
  apply()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** The saved choice and what is showing now. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current)
  const resolved = useSyncExternalStore(subscribe, () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'))
  return { theme, resolved, setTheme } as const
}
