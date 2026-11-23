// What every dialog (window, sheet, panel, the palette) shares. Where focus goes when one closes: Radix keeps focus
// inside while one is open; these remember what opened it, since by the time it opens focus may already have moved (a
// menu item that closed, a sheet that opened it). And how a click on a toast over it is read.

/**
 * For a modal's `onPointerDownOutside` and `onInteractOutside`: the toast stack floats over every window, panel and sheet
 * (it portals to body, `z-toast`) and takes clicks (Undo, Dismiss), so a click on a toast isn't a click outside.
 */
/**
 * A menu's `onEscapeKeyDown`: Escape closes only the menu, not the window or page behind it (App's window listener
 * hears it after Radix). Only while focus is inside the open menu: a menu that's closing after a pick still hears keys
 * during its exit animation, and then Escape belongs to the window again.
 */
export const escapeClosesMenuOnly = (e: KeyboardEvent) => {
  if (e.target instanceof Element && e.target.closest('[role="menu"][data-state="open"]')) e.stopPropagation()
}
export const keepForToast = (e: Event) => { if (e.target instanceof Element && e.target.closest('[data-toast]')) e.preventDefault() }

/** What had focus when the person clicked to open a dialog. Taken by the next dialog that opens. */
let trigger: HTMLElement | null = null

/**
 * Call at the start of an action that opens a dialog, while the click's target still has focus.
 * The dialog gives focus back to it on close, even though something else may have moved focus by then.
 * Pass `to` when the click's target is about to go away (a button in a sheet that closes): focus goes there instead.
 */
export function rememberTrigger(to?: HTMLElement | null) {
  if (to) { trigger = to; return }
  trigger = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
}

const visible = (el: HTMLElement) => el.getClientRects().length > 0

/** What a dialog opening now gives focus back to on close: the remembered trigger, else what has focus. */
export function claimTrigger(): HTMLElement | null {
  const active = document.activeElement
  const before = trigger?.isConnected ? trigger : active instanceof HTMLElement && active !== document.body ? active : null
  trigger = null
  return before
}

/** Give focus back to `before`, else the Menu button on a phone, else the page. */
export function restoreFocus(before: HTMLElement | null) {
  if (before?.isConnected) before.focus()
  else fallbackTarget()?.focus()
}

/** Where focus goes when the dialog's trigger is gone: the Menu button on a phone, else the page. */
function fallbackTarget(): HTMLElement | null {
  const menu = document.querySelector<HTMLElement>('button[aria-label="Menu"]')
  if (menu && visible(menu)) return menu
  return document.querySelector<HTMLElement>('main')
}
