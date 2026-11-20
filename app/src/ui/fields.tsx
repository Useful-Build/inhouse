// Search box and dropdown, on the shadcn Input and Select. Keyboard, focus and roles come from there.
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Select as UiSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useUi } from '../state/store'
import { Button, Icon, IconButton, Window } from './index'

/**
 * A 44px tap area on a phone for a control drawn smaller (a 28 or 32px icon button): an invisible box around it takes
 * the tap. Add it on a phone only; `row` grows it up and down only, for controls that sit side by side.
 */
export const TAP = 'relative after:absolute after:top-1/2 after:left-1/2 after:size-full after:min-h-11 after:min-w-11 after:-translate-x-1/2 after:-translate-y-1/2'
export const TAP_ROW = 'relative after:absolute after:inset-x-0 after:-inset-y-1.5'
/** A 44px-tall tap area as wide as the control: for small controls packed in a row (a message's 28px actions), so the areas never overlap. */
export const TAP_Y = 'relative after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2'

/**
 * The one search box: a card-coloured field with an input's border, 38px like the large buttons beside it. A field,
 * never a fill, so it can't read as the selected row under it (the Settings and Library menus). `className` places it
 * in its row (`basis-55`, `flex-none`), never restyles it.
 */
export function SearchBox({ value, onChange, placeholder, label, className }: {
  value: string; onChange: (v: string) => void; placeholder: string; label: string; className?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const phone = useUi(s => s.phone)
  return (
    <div className={cn('flex h-9.5 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-input bg-card pr-1.5 pl-3.5 text-base text-muted-foreground focus-within:border-border-strong focus-within:shadow-halo', className)}>
      <Icon name="search" size={17} />
      <Input ref={input} type="search" value={value} placeholder={placeholder} aria-label={label} autoComplete="off" spellCheck={false}
        onChange={e => onChange(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange('') } }}
        className="h-full flex-1 rounded-none border-0 bg-transparent p-0 text-parent focus:shadow-none [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none" />
      {value && <IconButton icon="close" label="Clear search" size={16} box="icon-sm" className={cn(phone && TAP)} onClick={() => { onChange(''); input.current?.focus() }} />}
    </div>
  )
}

/** The box a dropdown has to fit in: its nearest scrolling ancestor (the window is always a limit too). */
function scrollAreaOf(el: HTMLElement | null) {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

/**
 * A dropdown: a combobox that opens a listbox below it, or above it when there is more room there, kept inside its
 * scroll area and the window. Up and Down move, Home and End jump, typing jumps to a match, Enter or Space picks,
 * Escape closes, and focus goes back to the button. Typing on the closed button does nothing (Radix would pick a
 * match straight away), and Escape in the open list stays with the list.
 */
export function Select({ value, options, onChange, label, disabled, align = 'right', minWidth = 150, style, className, display }: {
  value: string; options: string[]; onChange: (v: string) => void; label: string; disabled?: boolean; align?: 'left' | 'right'; minWidth?: number; style?: CSSProperties; className?: string
  /** What the button says when that isn't the value's own name (a member's role: "Approver" while the value is Member). The list still offers the options. */
  display?: string
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [area, setArea] = useState<HTMLElement | null>(null)
  const [up, setUp] = useState(false)
  // The saved value can be one the list no longer has: show it, and let it be picked again by keeping it listed first.
  const items = !value || options.includes(value) ? options : [value, ...options]
  // Open upward when the list would run off the bottom of its scroll area or the window and there is more room above.
  // (Radix caps the list to the room on its side, so it would never flip by itself.)
  const place = () => {
    const el = scrollAreaOf(trigger.current)
    const r = trigger.current?.getBoundingClientRect()
    setArea(el)
    if (!r) return
    const a = el?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
    const need = Math.min(288, items.length * 36 + 12)
    const below = Math.min(window.innerHeight, a.bottom) - r.bottom - 12
    const above = r.top - Math.max(0, a.top) - 12
    setUp(below < need && above > below)
  }
  return (
    <UiSelect value={value} disabled={disabled}
      onValueChange={v => { if (v !== value) onChange(v) }}
      onOpenChange={open => { if (open) place() }}>
      {/* disabled:opacity-100 cancels ui-base's fade: a locked Select keeps its look, like every non-primary button. */}
      <SelectTrigger ref={trigger} aria-label={`${label}: ${display ?? value}`} className={cn('max-w-full flex-none disabled:opacity-100', className)} style={{ minWidth, ...style }}
        // A printable key other than Space would pick a match while the list is closed. Radix skips its own handler when this one prevents it.
        onKeyDown={e => { if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault() }}>
        <SelectValue>{display ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent aria-label={label}
        // Radix hears Escape on the document in the capture phase; stopping it there keeps it from the App's own Escape
        // (close every overlay), as the old listbox did.
        onEscapeKeyDown={e => e.stopPropagation()}
        side={up ? 'top' : 'bottom'} align={align === 'right' ? 'end' : 'start'} collisionBoundary={area} collisionPadding={{ top: 12, bottom: 12, left: 8, right: 8 }}
        className="max-h-select-height max-w-select-menu">
        {items.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
      </SelectContent>
    </UiSelect>
  )
}

/**
 * The one question before a change that takes something away (Delete, Replace, removing a role): a title, a line on
 * what happens and Cancel or the action. Cancel has focus first, and Escape cancels.
 */
export function Confirm({ label, title, children, action, onCancel, onConfirm, closeFocus }: {
  label: string; title: string; children: ReactNode; action: string; onCancel: () => void; onConfirm: () => void
  /** On close, focus this instead of what opened the question. */
  closeFocus?: () => HTMLElement | null
}) {
  // The window leaves Escape to the screens, so the question listens for it here.
  // One listener for the question's life: the screen re-renders while Escape is on its way to the window, and a
  // listener swapped in mid-dispatch would miss it.
  const cancel = useRef(onCancel)
  useEffect(() => { cancel.current = onCancel })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <Window onClose={onCancel} label={label} size="sm" layer="confirm" initialFocus="[data-cancel]" closeFocus={closeFocus}>
      <div className="px-5.5 pt-5.5 pb-5">
        <h2 className="text-xl font-semibold tracking-stat">{title}</h2>
        <p className="mt-2 mb-0 text-base leading-prose text-foreground-3">{children}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="lg" data-cancel onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" size="lg" onClick={onConfirm}>{action}</Button>
        </div>
      </div>
    </Window>
  )
}
