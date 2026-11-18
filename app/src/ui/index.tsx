// Shared UI primitives, built on the shadcn components in src/components/ui. Screens use these plus token classes.
// Inline styles here are only for values that come in as props (sizes, a caller's color).
import { useEffect, useId, useRef, useState } from 'react'
import type { ComponentProps, CSSProperties, ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Avatar as UiAvatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button as UiButton } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Switch as UiSwitch, switchRootClass, switchThumbClass } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { initials, memberFor, photoOf, userName } from '../state/derive'
import { openRun, useAgentData, useAgentState, useUi } from '../state/store'
import { Icon } from '@/components/ui/icon'
import { logoSrc } from './logo'
import { NO_MOTION } from './motion'
import { TAP, TAP_Y } from './fields'
import { claimTrigger, keepForToast, restoreFocus } from './dialogs'

export { Icon }

type BtnVariant = 'primary' | 'secondary' | 'outline' | 'surface' | 'inverse' | 'soft' | 'ghost' | 'link' | 'quiet' | 'requested' | 'destructive'
// `null` is an app-only look: the ui-base Button adds no variant classes, and APP_BTN supplies them.
const BTN_VARIANT = {
  primary: 'default', secondary: 'secondary', outline: 'outline', surface: null, inverse: null, soft: 'soft', ghost: 'ghost', link: 'link', quiet: null, requested: 'secondary', destructive: null,
} as const
const APP_BTN: Partial<Record<BtnVariant, string>> = {
  // A card-coloured button with no border, for a tinted or dark strip (a banner, the status pill).
  surface: 'bg-card text-foreground hover:bg-accent',
  // On the dark toast and a selection bar: a faint light fill. Disabled, the text fades (the button never dims as a whole).
  inverse: 'bg-primary-foreground/15 text-primary-foreground hover:bg-primary-foreground/25 disabled:text-primary-foreground/55',
  // The app's own red, so the text on it reads in dark too (--app-destructive-solid and --app-on-destructive).
  destructive: 'bg-destructive-solid text-on-destructive hover:bg-destructive-solid/90',
  // A back link or other quiet text link. A link is text: no box.
  quiet: 'font-normal text-foreground-3 hover:underline h-auto px-0',
}
// Sizes that set their own radius in ui-base's Button: a quiet link keeps the size's corners there, as it always did.
const SIZE_HAS_RADIUS = new Set<string | undefined>(['xs', 'lg', 'icon-sm'])
// Only a disabled primary button dims: this cancels ui-base's disabled:opacity-50 on every other look.
const NO_DISABLED_FADE = 'disabled:opacity-100'

/**
 * A button. `requested` is the quiet, already-asked state of a request button.
 * Sizes: `sm` 28px (a small action in a row), `default` 32px (actions on a card or in a list row), `lg` 38px (a page or
 * window's main actions, next to fields), `xs` 22px pill (Pause and Resume in the status pill), `icon-sm` 28px square.
 * Pick a size; don't set a height, radius or padding on the call. `surface` is a borderless card-coloured button for a
 * tinted strip; `inverse` is for the dark toast, `quiet` for a back link.
 */
export function Button({ variant = 'primary', size, className, type = 'button', ...rest }: ComponentProps<'button'> & {
  variant?: BtnVariant; size?: 'default' | 'sm' | 'lg' | 'xs' | 'icon-sm'
}) {
  return <UiButton type={type} variant={BTN_VARIANT[variant]} size={size}
    className={cn(APP_BTN[variant], variant === 'quiet' && !SIZE_HAS_RADIUS.has(size) && 'rounded-xs', variant !== 'primary' && NO_DISABLED_FADE, variant === 'requested' && 'text-foreground-3', className)} {...rest} />
}

// The app's frame (top bar, sidebar header): a faint fill on hover and while its pop-up is open.
const CHROME = 'flex-none text-foreground-3 hover:bg-foreground/5 hover:text-foreground-2 data-[state=open]:bg-foreground/5'
// The small actions under a message (Copy, Reply, Rate...): a tighter corner and a stronger fill on hover and while open.
const ACTION = 'rounded-md hover:bg-fill-hover aria-expanded:bg-fill-hover'
// On the dark toast: light glyph, a faint light fill on hover (the inverse Button's fill).
const INVERSE = 'text-primary-foreground/70 hover:bg-primary-foreground/15 hover:text-primary-foreground'

/**
 * An icon-only button. `label` is its accessible name and its tooltip. `size` is the glyph's size in px; `box` is the button's own size step (`icon` 32px, `icon-sm` 28px, `icon-lg`).
 * `shortcut` (from `SHORTCUTS` in `src/shell/nav.ts`) shows after the label in the tooltip and sets `aria-keyshortcuts`.
 */
export function IconButton({ icon, label, tip = label, size = 20, box = 'icon', variant = 'ghost', filled, shortcut, className, onFocus, ...rest }: ComponentProps<'button'> & {
  icon: string; label: string; /** The tooltip's text when it says more than the name (the action a toggle will do). */ tip?: string; size?: number; box?: 'icon' | 'icon-sm' | 'icon-lg'; shortcut?: { label: string; aria: string }
  /** `chrome` for the app's frame: the top bar and the sidebar header. `action` for the small actions under a message (with `box="icon-sm"`). `inverse` on the dark toast. */
  variant?: 'ghost' | 'chrome' | 'action' | 'inverse'
  /** The filled glyph (a picked rating). */
  filled?: boolean
}) {
  // A message's 28px actions keep their look on a phone, each with a 44px-tall tap area as wide as the button, so
  // neighbours' areas don't overlap.
  const phone = useUi(s => s.phone)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UiButton type="button" variant={variant === 'chrome' || variant === 'inverse' ? null : 'ghost'} size={box} aria-label={label} aria-keyshortcuts={shortcut?.aria}
          className={cn(variant === 'chrome' && CHROME, variant === 'action' && ACTION, variant === 'inverse' && INVERSE, variant === 'action' && phone && TAP_Y, NO_DISABLED_FADE, className)} {...rest}
          // The tooltip shows for keyboard focus only, not when a window opens and puts focus here after a click.
          onFocus={e => { onFocus?.(e); if (!e.currentTarget.matches(':focus-visible')) e.preventDefault() }}>
          <Icon name={icon} size={size} fill={filled} />
        </UiButton>
      </TooltipTrigger>
      <TooltipContent>{tip}{shortcut && <kbd className="ml-1.5 font-sans text-primary-foreground/70">{shortcut.label}</kbd>}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A person's round avatar: their photo, else initials. `who` is a member id, a name or a label that starts with
 * one ("Dana approved"). The signed-in user's name follows the Name setting.
 */
export function Avatar({ who, size = 24, fontSize = Math.round(size * 0.42) }: { who: string; size?: number; fontSize?: number }) {
  const data = useAgentData()
  const st = useAgentState()
  const me = userName({ agent: st, data })
  const m = memberFor(data, who, me)
  const photo = m ? photoOf(data, st, m.id) : null
  const name = m ? (m.id === data.meta.currentUser.id ? me : m.name) : who
  return (
    <UiAvatar aria-hidden="true" className={cn(photo && 'after:absolute after:inset-0 after:rounded-full after:inset-ring after:inset-ring-input')}
      style={{ width: size, height: size, fontSize }}>
      {photo && <AvatarImage src={photo} alt="" width={size} height={size} draggable={false} className="block" />}
      {/* While a photo loads this is the plain grey circle; without one, the initials. */}
      <AvatarFallback className="text-parent">{photo ? null : initials(name)}</AvatarFallback>
    </UiAvatar>
  )
}

// An off switch's track is its own token (dark needs a lighter one), and a switch that can't change never dims:
// it keeps its look, and a locked one says why in a tooltip (on a tap too) and to screen readers.
const SWITCH = 'data-[state=unchecked]:bg-switch-off disabled:opacity-100'

/**
 * On/off switch. `small` is the 32x20 version used in menus. Without `onChange` it shows disabled.
 * `reason` is a switch that can't be changed and says why: it stays focusable, the reason is its description for
 * screen readers, and it shows in a tooltip on hover, keyboard focus and a click or tap (touch has no hover).
 */
export function Switch({ on, onChange, label, small, disabled, reason }: { on: boolean; onChange?: () => void; label: string; small?: boolean; disabled?: boolean; reason?: string }) {
  // A 44px tap area on a phone, around the small switch.
  const phone = useUi(s => s.phone)
  const reasonId = useId()
  const [tip, setTip] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  // A tap anywhere outside the switch closes a tap-opened reason, another switch included (each one stops its click).
  useEffect(() => {
    if (!tip) return
    const close = (e: PointerEvent) => { if (!trigger.current?.contains(e.target as Node)) setTip(false) }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [tip])
  const sw = (
    <UiSwitch checked={on} onCheckedChange={() => { if (!reason) onChange?.() }} aria-label={label} size={small ? 'sm' : 'default'} disabled={!reason && (disabled || !onChange)}
      // Described by the hidden reason while the tooltip is closed; while it's open the tooltip describes it, so the
      // reason is heard once.
      aria-disabled={reason ? true : undefined} aria-describedby={reason && !tip ? reasonId : undefined}
      // The tooltip trigger passes its own data-state (closed, delayed-open), which would win over the switch's: state it
      // here. Only then: Radix spreads props after its own data-state, so even `data-state={undefined}` erases it and
      // the track loses its checked and unchecked fills.
      {...(reason ? { 'data-state': on ? 'checked' : 'unchecked' } : {})}
      className={cn(SWITCH, reason && 'cursor-default', phone && TAP)} onClick={e => e.stopPropagation()} />
  )
  if (!reason) return sw
  return (
    <>
      <Tooltip open={tip} onOpenChange={setTip}>
        {/* A click or tap opens the reason: preventing the default keeps the trigger's own click from closing it. A tap
            elsewhere closes it. */}
        <TooltipTrigger asChild ref={trigger} onClick={e => { e.preventDefault(); setTip(true) }}>{sw}</TooltipTrigger>
        <TooltipContent className="max-w-64" collisionPadding={16}>{reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} hidden>{reason}</span>
    </>
  )
}

/** Visual-only switch for rows where the whole row is the button. */
export function SwitchLook({ on, small }: { on: boolean; small?: boolean }) {
  const state = on ? 'checked' : 'unchecked'
  return (
    <span aria-hidden="true" data-size={small ? 'sm' : 'default'} data-state={state} className={cn(switchRootClass, SWITCH)}>
      <span data-state={state} className={switchThumbClass} />
    </span>
  )
}

/**
 * Radix's arrow keys only move focus; picking on that focus makes the selection follow it, as in any radio group.
 * Tab and Shift+Tab never pick (only an arrow, Home or End does), and a click picks through onValueChange.
 */
function useFocusPick(pick: (v: string) => void) {
  // The last key pressed in the group.
  const lastKey = useRef('')
  return {
    onKeyDown: (e: { key: string }) => { lastKey.current = e.key },
    onFocusOf: (k: string) => () => { const moved = /^(Arrow|Home$|End$)/.test(lastKey.current); lastKey.current = ''; if (moved) pick(k) },
  }
}

// Muted text in a picked segment (a count) steps up so it keeps 4.5:1 on the picked fill (--app-picked-muted).
const PICKED = 'data-[state=on]:picked-muted'

/**
 * Segmented control: one pick out of a few, as a radio group. One Tab stop (the picked option); the arrow keys move
 * to the next option and pick it, as in any radio group.
 */
export function Segmented<T extends string>({ value, options, onChange, label, style, className }: {
  value: T
  /** `[value, label]`, where the label can hold a count or other markup; or `[value, label, icon]` for an icon-only option (the label is its accessible name). */
  options: ([T, ReactNode] | [T, string, string])[]
  onChange: (v: T) => void; label: string; style?: CSSProperties; className?: string
}) {
  // A click focuses first, then clicks: the focus picks, and React re-renders before the click, so it sees no change.
  const pick = (v: T) => { if (v !== value) onChange(v) }
  const focusPick = useFocusPick(v => pick(v as T))
  return (
    // Radix empties a single group when the picked item is clicked again; a segmented control always keeps a pick.
    <ToggleGroup type="single" value={value} onValueChange={v => { if (v) pick(v as T) }} aria-label={label} style={style} className={className} onKeyDown={focusPick.onKeyDown}>
      {options.map(([k, t, icon]) => (
        icon ? (
          <Tooltip key={k}>
            <TooltipTrigger asChild>
              {/* TooltipTrigger passes its own data-state (closed, delayed-open) down and it would win over the item's on/off,
                  so the picked look would never show: state it here, which the trigger's merge keeps. */}
              <ToggleGroupItem value={k} data-state={value === k ? 'on' : 'off'} aria-label={String(t)} className={cn('px-2.25 py-1.25', PICKED)} onFocus={focusPick.onFocusOf(k)}>
                <Icon name={icon} size={19} />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>{t}</TooltipContent>
          </Tooltip>
        ) : (
          <ToggleGroupItem key={k} value={k} className={PICKED} onFocus={focusPick.onFocusOf(k)}>{t}</ToggleGroupItem>
        )
      ))}
    </ToggleGroup>
  )
}

/** Wrapping pill choices (one pick), for a short set of options that may wrap onto two lines. A radio group underneath. */
export function ChoiceChips<T extends string>({ value, options, onChange, label }: {
  value: T
  /** `[value, label, icon]` */
  options: [T, string, string][]
  onChange: (v: T) => void; label: string
}) {
  // Same as Segmented: a click focuses first, then clicks, and the focus picks only after an arrow key.
  const pick = (v: T) => { if (v !== value) onChange(v) }
  const focusPick = useFocusPick(v => pick(v as T))
  // On a phone each 32px chip has a 44px-tall tap area that reaches into the 6px gaps; every gap is 6px, and each chip stays fully tappable.
  const phone = useUi(s => s.phone)
  return (
    <ToggleGroup type="single" value={value} onValueChange={v => { if (v) pick(v as T) }} aria-label={label} onKeyDown={focusPick.onKeyDown} className="flex flex-wrap gap-1.5 rounded-none bg-transparent p-0">
      {options.map(([k, t, icon]) => (
        <ToggleGroupItem key={k} value={k} onFocus={focusPick.onFocusOf(k)}
          className={cn('h-8 gap-1.25 rounded-full border border-input bg-card px-3 py-0 text-foreground data-[state=on]:border-foreground data-[state=on]:bg-foreground data-[state=on]:text-primary-foreground data-[state=on]:hover:text-primary-foreground data-[state=on]:shadow-none', phone && TAP_Y)}>
          <Icon name={icon} size={15} />{t}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** Tool mark: official where public/logos/SOURCES.md says so, else a stand-in. Decorative: the name is always next to it. Only on a LogoTile. */
function Logo({ k, size }: { k: string; size: number }) {
  return <img src={logoSrc(k)} alt="" className="flex-none object-contain" style={{ width: size, height: size }} />
}

const logoTileVariants = cva('flex flex-none items-center justify-center border', {
  variants: {
    /** xs 18px (a logo in a line of text), sm 22px (a menu row, a card's label line), md 32px (a setup row), lg 46px (a tool row), xl 64px (a tool page). */
    size: { xs: 'size-4.5 rounded-xs', sm: 'size-5.5 rounded-sm', md: 'size-8 rounded-md', lg: 'size-11.5 rounded-xl', xl: 'size-16 rounded-2xl' },
    /** A round tile (the composer's stack of tools). */
    round: { true: 'rounded-full', false: '' },
    /** `logo` holds a mark; `count` is the "+N" after a stack of them (the composer's tools), at the same size. */
    tone: { logo: 'border-border bg-logo-tile text-logo-tile-foreground', count: 'border-input bg-card text-2xs font-semibold text-foreground-3' },
  },
  defaultVariants: { size: 'lg', round: false, tone: 'logo' },
})
const LOGO_SIZE = { xs: 12, sm: 14, md: 16, lg: 22, xl: 30 } as const

/**
 * Light tile holding a logo. Every logo sits on one, at any size (an 18px chip in a line of text up to the 64px tile),
 * because tool marks are drawn for a light ground and some vanish on a dark card.
 */
export function LogoTile({ k, size, round, className }: { k: string; className?: string } & Omit<VariantProps<typeof logoTileVariants>, 'tone'>) {
  return (
    <span className={cn(logoTileVariants({ size, round }), className)}>
      {/* A round tile's glyph is 2px smaller, so its corners keep about 3px from the circle. */}
      <Logo k={k} size={LOGO_SIZE[size ?? 'lg'] - (round ? 2 : 0)} />
    </span>
  )
}

/** "+N" more logos after a stack of round `LogoTile`s, on a round tile of the same `size`. Decorative: the stack's label says it. */
export function LogoCount({ n, size, className, ...rest }: Omit<ComponentProps<'span'>, 'children'> & { n: number; size: VariantProps<typeof logoTileVariants>['size'] }) {
  return <span aria-hidden="true" {...rest} className={cn(logoTileVariants({ size, round: true, tone: 'count' }), className)}>+{n}</span>
}

/** A small round dot. Color it with a token class (`className="bg-warning"`). */
export function Dot({ size = 7, className }: { size?: number; className?: string }) {
  return <i aria-hidden="true" className={cn('inline-block flex-none rounded-full', className)} style={{ width: size, height: size }} />
}

/**
 * "Act" / "Run" tag on things included in a later stage. Its tooltip says what the lock means; screen readers get it in
 * the text. `strong` on a selected row, where muted text and the faint outline fall under contrast.
 */
export function StageTag({ tag, icon = true, size = 'default', strong }: { tag: string; icon?: boolean; size?: 'default' | 'lg'; strong?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex items-center gap-0.75 rounded-full border font-strong', strong ? 'border-tag-edge-strong text-foreground-3' : 'border-input text-muted-foreground',
          size === 'lg' ? 'h-6 pr-2.25 pl-1.75 text-xs' : 'h-5 pr-1.75 pl-1.25 text-2xs')}>
          {icon && <Icon name="lock" size={size === 'lg' ? 13 : 12} />}<span className="sr-only">Locked, included in a later stage: </span><span>{tag}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>Included in a later stage</TooltipContent>
    </Tooltip>
  )
}

/** The agent's three-dot mark. Animated (goo filter) while the agent works. Blue: running. */
export function AgentMark({ color = 'var(--brand)', scale = 1 }: { color?: string; scale?: number }) {
  const live = useUi(s => s.animateMark)
  const dot = (cls: string, a: string) => (
    <i className={cn('absolute rounded-full bg-current', cls, live && a)} />
  )
  return (
    <span aria-hidden="true" className={cn('relative inline-block size-6 flex-none', live && 'goo')} style={{ color, zoom: scale }}>
      {dot('agent-dot-1', 'animate-mark-1')}
      {dot('agent-dot-2', 'animate-mark-2')}
      {dot('agent-dot-3', 'animate-mark-3')}
    </span>
  )
}

/** SVG goo filter used by AgentMark. Render once. */
export function GooDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <defs>
        <filter id="goo">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="b" />
          <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" />
        </filter>
      </defs>
    </svg>
  )
}

/** The Inhouse mark. */
export function InhouseMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className="text-foreground">
      <path d="M4 4H11V21H28V28H4Z" fill="currentColor" />
      <path d="M14 4H28V18H21V11H14Z" fill="currentColor" />
    </svg>
  )
}

/** Dotted page background with the slow blue light sweep. */
export function DotsBackground() {
  const ambient = useUi(s => s.ambient)
  const live = useUi(s => s.animateMark)
  const thinking = useUi(s => !!openRun(s))
  const loading = useUi(s => s.scenario === 'Loading')
  const sweep = live && (ambient === 'Always' || (ambient === 'When Inhouse agent works' && (thinking || loading)))
  // Masks only read alpha: black shows, transparent hides. The band's color hints (35%, 65%) give it the same soft
  // edges as the old 35% stops at 30% and 70%.
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-1 mask-(--app-dots-mask)">
      <div className="absolute inset-0 bg-dot-grid bg-size-(--app-dot-grid-size)" />
      {sweep && (
        <div className="absolute inset-0 animate-ih-wind bg-dot-grid-live bg-size-(--app-dot-grid-size) opacity-42 mask-(--app-sweep-mask) mask-size-(--app-sweep-mask-size) mask-no-repeat" />
      )}
    </div>
  )
}

const windowVariants = cva('left-1/2 flex max-w-none bg-window-surface -translate-x-1/2 translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-none', {
  variants: {
    /** sm 420px (a question, a short notice, set lower on the screen), md 600px (Help, the team window), lg 960px (the file viewer), xl 1120px (the trace). */
    size: {
      sm: 'top-window-sm max-h-window-max w-window-sm',
      md: 'top-window max-h-window-max w-window-md',
      lg: 'top-window-lg max-h-window-max-lg w-window-lg',
      xl: 'top-window max-h-window-max w-window-xl',
    },
    /** Where it stacks: `window` for most, `trace` over a window, `confirm` over every window and sheet. */
    layer: { window: 'z-window', trace: 'z-trace', confirm: 'z-confirm' },
  },
  defaultVariants: { size: 'md', layer: 'window' },
})
const SCRIM_LAYER = { window: 'z-window-scrim', trace: 'z-trace-scrim', confirm: 'z-confirm-scrim' } as const

/**
 * Centered window with scrim (trace, team, files), on the shadcn Dialog: focus stays inside, Escape and a click on the
 * scrim close it, and focus goes back to what opened it. Every window is `bg-window-surface` (a question, the trace and
 * the file viewer too); `className` only places or sizes its insides. It opens with focus on the window itself, so Close
 * shows no focus ring or tooltip until someone tabs to it.
 */
export function Window({ onClose, label, size, layer, className, children, initialFocus, closeFocus }: {
  onClose: () => void; label: string; className?: string; children: ReactNode
  /** CSS selector, inside the window, of what gets focus first. Default: the window itself. */
  initialFocus?: string
  /** On close, focus this instead of what opened the window (return null to use the opener). */
  closeFocus?: () => HTMLElement | null
} & VariantProps<typeof windowVariants>) {
  const content = useRef<HTMLDivElement | null>(null)
  const before = useRef<HTMLElement | null>(null)
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent
        ref={content}
        aria-label={label}
        aria-describedby={undefined}
        showCloseButton={false}
        // No open or close motion, like the app's windows before Radix (and screenshots catch them fully drawn).
        overlayProps={{ className: cn(NO_MOTION, SCRIM_LAYER[layer ?? 'window']) }}
        onOpenAutoFocus={e => {
          before.current = claimTrigger()
          e.preventDefault()
          const first = initialFocus ? content.current?.querySelector<HTMLElement>(initialFocus) : null
          ;(first ?? content.current)?.focus()
        }}
        onCloseAutoFocus={e => { e.preventDefault(); restoreFocus(closeFocus?.() ?? before.current) }}
        // Escape stays with the screens (App closes overlays, the Library steps back one layer at a time), as before Radix.
        // Closing here too would close two layers on one press.
        onEscapeKeyDown={e => e.preventDefault()}
        onPointerDownOutside={keepForToast}
        onInteractOutside={keepForToast}
        // The window's ground: its rows' hover and its inset wells step off it (index.css).
        data-surface="window"
        className={cn(windowVariants({ size, layer }), NO_MOTION, className)}>
        {children}
      </DialogContent>
    </Dialog>
  )
}

// oxlint-disable-next-line react/only-export-components -- page.tsx exports components (and their prop types) only.
export * from './page'
// oxlint-disable-next-line react/only-export-components -- chrome.tsx only exports components
export * from './chrome'
