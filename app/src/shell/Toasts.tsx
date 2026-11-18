// The toast stack, newest at the bottom. Each toast keeps its own Undo and its own countdown; pointer over a toast or
// focus inside the stack pauses every countdown, and leaving resumes each with the time it had left. A toast that holds
// approvals going out has no countdown: the store removes it when they went out (see `holds` in state/store.ts).
// The stack portals to body at `z-toast`, above every window, panel and sheet (they portal to body too), so an Undo
// takes clicks while one is open; each modal lets a click on a toast through (`keepForToast` in src/ui).
// Keyboard: F6 moves focus to the newest toast and remembers where it was; Escape or F6 again puts it back (to `main` if
// that's gone). No trap: Tab moves on and a click elsewhere just leaves. While a modal window, sheet or confirm is open
// F6 does nothing (the modal traps focus; an approval has its own Undo in the panel). After Undo or Dismiss from the
// keyboard, focus goes to the next toast, else back. The toasts always render in the same parent, so moving focus never
// remounts one (that would restart its countdown and announce it again).
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Toast } from '../state/store'
import { useUi } from '../state/store'
import { cn } from '@/lib/utils'
import { Button, Icon, IconButton } from '../ui'
import { TAP } from '../ui/fields'

/** Where the stack's bottom edge goes: above the tallest `[data-bottom-dock]` element, or null for `bottom-toast`. */
function useDockOffset(): number | null {
  const [bottom, setBottom] = useState<number | null>(null)
  useEffect(() => {
    let docks: Element[] = []
    const measure = () => {
      const tops = docks.map(d => d.getBoundingClientRect()).filter(r => r.height > 0).map(r => r.top)
      if (!tops.length) { setBottom(null); return }
      const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-toast-dock-gap'))
      if (!Number.isFinite(gap)) throw new Error('Toasts: the --app-toast-dock-gap token is missing from src/index.css.')
      setBottom(window.innerHeight - Math.min(...tops) + gap)
    }
    const resize = new ResizeObserver(measure)
    // Docks mount and unmount with the page (a chat's composer, the Library's selection bar): follow the set.
    const follow = () => {
      const now = [...document.querySelectorAll('[data-bottom-dock]')]
      if (now.length === docks.length && now.every((d, i) => d === docks[i])) return
      resize.disconnect()
      docks = now
      docks.forEach(d => resize.observe(d))
      measure()
    }
    const mutations = new MutationObserver(follow)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-bottom-dock'] })
    window.addEventListener('resize', measure)
    follow()
    return () => { mutations.disconnect(); resize.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  return bottom
}

function ToastItem({ toast, paused, onHover, onFocusIn, onLeave }: {
  toast: Toast; paused: boolean; onHover: (id: number | null) => void; onFocusIn: (id: number | null) => void
  /** Runs Undo or Dismiss; from the keyboard, focus moves on in the stack (see `Toasts`). */
  onLeave: (id: number, act: () => void, keyboard: boolean) => void
}) {
  const phone = useUi(s => s.phone)
  const { runToastUndo, dismissToast } = useUi.getState()
  // The time this toast has left, kept across pauses.
  const left = useRef(toast.ms)
  const held = !!toast.holds?.length
  useEffect(() => {
    if (held || paused) return
    const from = Date.now()
    const timer = setTimeout(() => dismissToast(toast.id), Math.max(0, left.current))
    return () => { clearTimeout(timer); left.current -= Date.now() - from }
  }, [held, paused, toast.id, dismissToast])
  const textId = `toast-${toast.id}-text`
  // A click has a detail of 1 or more; Enter or Space on a button gives 0.
  const fromKeys = (e: MouseEvent<HTMLButtonElement>) => e.detail === 0
  return (
    <div data-toast={toast.id} onPointerEnter={() => onHover(toast.id)} onPointerLeave={() => onHover(null)}
      onFocus={() => onFocusIn(toast.id)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusIn(null) }}
      className="pointer-events-auto box-border flex min-h-11 w-max max-w-screen-gutter items-center gap-3 rounded-xl bg-primary py-2 pr-2 pl-3.5 text-sm text-primary-foreground shadow-menu">
      <Icon name={toast.icon} size={18} weight={400} />
      <span id={textId} className="min-w-0">{toast.text}</span>
      <span className="flex flex-none items-center gap-1">
        {toast.undo && <Button variant="inverse" size="sm" className={cn(phone && TAP)} onClick={e => onLeave(toast.id, () => runToastUndo(toast.id), fromKeys(e))}>Undo</Button>}
        {/* Named "Dismiss", described by the text: the live region already read the text once. */}
        <IconButton icon="close" label="Dismiss" aria-describedby={textId} size={16} box="icon-sm" variant="inverse" onClick={e => onLeave(toast.id, () => dismissToast(toast.id), fromKeys(e))} className={cn(phone && TAP)} />
      </span>
    </div>
  )
}

/** A modal window, sheet or confirm is open: it traps focus, so F6 leaves it alone. */
const modalOpen = () => !!document.querySelector('[data-slot="dialog-content"][data-state="open"], [data-slot="sheet-content"][data-state="open"]')

export function Toasts() {
  const toasts = useUi(s => s.toasts)
  // The toast under the pointer and the one holding focus. A toast that leaves fires no leave or blur, so only one
  // still in the stack pauses it.
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [focusId, setFocusId] = useState<number | null>(null)
  const paused = toasts.some(t => t.id === hoverId || t.id === focusId)
  const bottom = useDockOffset()
  const stackRef = useRef<HTMLDivElement>(null)
  // Where focus was when F6 moved it into the stack; null when F6 didn't, or once focus left the stack.
  const from = useRef<HTMLElement | null>(null)
  const items = () => [...(stackRef.current?.querySelectorAll('[data-toast]') ?? [])]
  const firstButton = (el: Element | undefined) => el?.querySelector<HTMLElement>('button') ?? null
  /** Focus goes back to where F6 came from, else to `main`. */
  const returnFocus = useCallback(() => {
    const to = from.current
    from.current = null
    ;(to && to !== document.body && to.isConnected ? to : document.getElementById('main'))?.focus()
  }, [])
  /** Focus leaves the stack from a key: the pause ends here, whatever blur does. */
  const back = useCallback(() => { setFocusId(null); returnFocus() }, [returnFocus])
  const onLeave = (id: number, act: () => void, keyboard: boolean) => {
    const all = items()
    const i = all.findIndex(x => x.getAttribute('data-toast') === String(id))
    const hadFocus = i >= 0 && all[i].contains(document.activeElement)
    act()
    if (!hadFocus) return
    if (!keyboard) { from.current = null; setFocusId(null); return }
    const next = firstButton(all[i + 1] ?? all[i - 1])
    if (next) next.focus(); else back()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F6' && e.key !== 'Escape') return
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      const inside = !!stackRef.current?.contains(document.activeElement)
      if (inside && (e.key === 'F6' || from.current)) {
        // Before App's own Escape (a document listener): leaving the stack closes nothing.
        e.preventDefault()
        e.stopPropagation()
        back()
      } else if (e.key === 'F6' && !inside && !modalOpen()) {
        const newest = firstButton(items().at(-1))
        if (!newest) return
        e.preventDefault()
        const active = document.activeElement
        // Focus lost to body (the focused toast left) keeps the place F6 first came from.
        if (!(from.current && (!active || active === document.body))) from.current = active instanceof HTMLElement ? active : null
        newest.focus()
      }
    }
    // Focus went somewhere outside the stack (a click, Tab): F6 mode ends.
    const onFocusIn = (e: FocusEvent) => { if (!stackRef.current?.contains(e.target as Node | null)) from.current = null }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocusIn)
    return () => { window.removeEventListener('keydown', onKey, true); document.removeEventListener('focusin', onFocusIn) }
  }, [back])
  // The focused toast left another way (a held draft went out, a new approval replaced the held toast): focus moves to the newest toast,
  // or back once none is left, rather than being lost to body. A mouse Undo or Dismiss clears `focusId` first.
  // A toast that is gone pauses nothing (see `paused`), so its id can stay; `lost` makes sure it's handled once.
  const lost = useRef<number | null>(null)
  useEffect(() => {
    if (focusId === null || toasts.some(t => t.id === focusId) || lost.current === focusId) return
    lost.current = focusId
    if (document.activeElement && document.activeElement !== document.body) return
    const newest = firstButton(items().at(-1))
    if (newest) newest.focus(); else returnFocus()
  }, [toasts, focusId, returnFocus])
  // The live region is always mounted, straight under body: a modal (Radix) hides everything outside it from screen
  // readers except live regions that already exist when it opens. Each toast takes clicks over a modal too, for Undo.
  return createPortal(
    <div ref={stackRef} role="status" aria-live="polite" data-toast-stack
      // Computed from the docks on screen; with none it sits at bottom-toast, above the safe area.
      style={bottom === null ? undefined : { bottom }}
      className="pointer-events-none fixed bottom-toast left-1/2 z-toast flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map(t => <ToastItem key={t.id} toast={t} paused={paused} onHover={setHoverId} onFocusIn={setFocusId} onLeave={onLeave} />)}
    </div>,
    document.body,
  )
}
