// App components for the shell, overlays and composer: the nav row (sidebar, Settings and Library menus), the icon tile,
// the window header, a menu row, the selection bar, a Help guide and the attachment chip. Each part that has looks takes them as cva variants.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentProps, ReactNode, RefObject } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Attachment, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from '@/components/ui/attachment'
import { Badge } from '@/components/ui/badge'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Icon, IconButton, StageTag } from './index'
import { TAP } from './fields'

const navItemVariants = cva('flex w-full flex-none items-center gap-2.75 rounded-lg text-left', {
  variants: {
    /** `fit` grows with a `detail` line (the Settings menu); `tap` is `fit` at a phone's 44px; `chip` is a pill in a row (the Library's places on a narrow screen). */
    size: { default: 'h-9', sm: 'h-8', fit: 'min-h-9 py-1.75', tap: 'min-h-11 py-1.75', chip: 'h-8.5 w-auto gap-1.75 rounded-full border border-border bg-card py-0 whitespace-nowrap' },
    /** `default` is the main nav (bigger, strong when open); `quiet` is the secondary nav and the account row. */
    tone: { default: 'text-base', quiet: 'text-sm' },
    /** The row leads with an avatar, which sits closer to the edge than an icon. */
    avatar: { true: 'pr-2.5 pl-2', false: 'px-2.5' },
    /** The collapsed sidebar's icon rail: a square, the label in a tooltip. */
    rail: { true: 'size-10 justify-center px-0', false: '' },
    active: { true: '', false: '' },
    locked: { true: '', false: '' },
    /** The sidebar: the selected row is marked on the sidebar's edge (its marker line), so the row takes no fill. It turns to ink and its icon fills. */
    marked: { true: '', false: '' },
    /** With `marked`: the other rows wait a step quieter until the pointer or the keyboard is in the sidebar (`group/side`). Off on a phone, which has no hover. */
    hush: { true: '', false: '' },
  },
  // One selected look in the Settings menu and the Library's places (a fill a step stronger than hover); the sidebar's is `marked`.
  compoundVariants: [
    // After the avatar variant's px-2.5, so the chip's padding wins (twMerge keeps the last).
    { size: 'chip', avatar: false, class: 'px-3' },
    { tone: 'default', active: true, class: 'bg-fill-hover font-strong' },
    { tone: 'default', active: false, class: 'font-book hover:bg-accent' },
    { tone: 'default', locked: false, class: 'text-foreground' },
    { tone: 'default', locked: true, class: 'text-foreground-3' },
    { tone: 'quiet', active: true, class: 'bg-fill-hover text-foreground' },
    { tone: 'quiet', active: false, class: 'text-foreground-3 hover:bg-accent' },
    // After the looks above, so these win (twMerge keeps the last).
    { marked: true, active: true, class: 'bg-transparent text-foreground' },
    { marked: true, active: false, class: 'hover:bg-side-hover' },
    { marked: true, hush: true, active: false, locked: false, class: 'text-foreground-3 transition-colors group-hover/side:text-foreground group-focus-within/side:text-foreground' },
  ],
  defaultVariants: { size: 'default', tone: 'default', avatar: false, rail: false, active: false, locked: false, marked: false, hush: false },
})

/**
 * A nav row: the sidebar, the Settings menu and the Library's places. `active` is the look and, unless `aria-current`
 * is passed, sets `aria-current="page"` (a Library place filters rather than navigates, so it passes `aria-pressed` and
 * `aria-current={undefined}`). Leads with `icon`, or with `leading` (an avatar, with `avatar`).
 * `count` is a waiting number in a badge (the sidebar's Approvals row: the agent's signal, so it takes the agent's
 * sapphire as a tint), `meta` a quiet number (a place's file count); `detail` is a line under the
 * label (a settings search's matches); `tag` is the stage a locked row is included in. Also works as an `asChild`
 * trigger's child (it forwards its props and ref).
 * `rail` is the collapsed sidebar's square: the label (and `tip`, when the name differs from what the tooltip should say)
 * shows in a tooltip, the count becomes a dot, and the name, count and tag stay for screen readers.
 */
export function NavItem({ icon, iconWeight, leading, label, active, locked, marked, hush, count, countLabel, meta, detail, tag, trailing, size, tone, avatar, rail, tip, className, type = 'button', ...rest }:
  Omit<ComponentProps<'button'>, 'children'> & VariantProps<typeof navItemVariants> & {
    icon?: string; /** The glyph's weight, when it must match a heavier label than the default 300 (the Settings menu). */ iconWeight?: number; leading?: ReactNode; label: string; count?: number; countLabel?: string; meta?: ReactNode; detail?: ReactNode; tag?: string; trailing?: ReactNode; tip?: string
  }) {
  // A passed aria-current wins even when it's undefined (a selected Library place isn't the current page).
  const current = 'aria-current' in rest ? rest['aria-current'] : active ? 'page' : undefined
  // Muted text on the selected fill falls under 4.5:1, so on a selected row it steps up a level.
  const quiet = active ? 'text-foreground-3' : 'text-muted-foreground'
  const row = (
    <button type={type} {...rest} aria-current={current} className={cn(navItemVariants({ size, tone, avatar, rail, active, locked, marked, hush }), rail && 'relative', className)}>
      {leading}
      {/* A fixed 20px box, so labels line up whatever the glyph's own width. */}
      {icon && <span className="flex w-5 flex-none justify-center"><Icon name={icon} size={size && size !== 'default' ? 18 : 20} weight={marked && active ? 400 : iconWeight} fill={!!(marked && active)} className={marked ? 'icon-fill-ease' : undefined} /></span>}
      {rail ? <span className="sr-only">{label}</span> : (
        <span className="min-w-0 flex-1">
          <span className="ellipsis block">{label}</span>
          {detail && <span className={cn('mt-px block text-xs font-normal', quiet)}>{detail}</span>}
        </span>
      )}
      {!rail && meta != null && <span className={cn('text-xs font-book tabular-nums', quiet)}>{meta}</span>}
      {count != null && (rail
        ? <><span className="sr-only">{countLabel}</span><i aria-hidden="true" className="absolute top-1.5 right-1.5 size-2 rounded-full border-hairline border-background bg-brand" /></>
        : <Badge aria-label={countLabel} className="min-w-5 bg-count px-1.5 text-xs font-semibold text-brand-text tabular-nums">{count}</Badge>)}
      {tag && (rail ? <span className="sr-only">Locked, included in a later stage: {tag}</span> : <StageTag tag={tag} strong={!!active} />)}
      {!rail && trailing}
    </button>
  )
  if (!rail) return row
  return <RailTip tip={`${tip ?? label}${tag ? ` · ${tag}` : ''}`}>{row}</RailTip>
}

/**
 * The rail's tooltip. A click closes it until the pointer leaves or focus moves on, so it doesn't sit over the page
 * the click just opened. A row whose menu the click opened (the account) stays quiet while the menu is open, so when
 * the menu closes and gives focus back, the tooltip doesn't open over the page (the next hover shows it again). A menu
 * that closes and sends focus elsewhere clears it, so the next keyboard focus on the row shows the tooltip.
 */
function RailTip({ tip, children }: { tip: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const quiet = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const wake = (e: { currentTarget: Element }) => { if (e.currentTarget.getAttribute('aria-expanded') !== 'true') quiet.current = false }
  useEffect(() => {
    const el = trigger.current
    if (!el) return
    let timer: number | undefined
    // The menu gives focus back a tick after it closes (Radix's focus scope). Wait for that: if the row has focus, it
    // stays quiet until blur; if focus went elsewhere, wake it now.
    const watch = new MutationObserver(() => {
      if (el.getAttribute('aria-expanded') !== 'false') return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { if (document.activeElement !== el) quiet.current = false })
    })
    watch.observe(el, { attributes: true, attributeFilter: ['aria-expanded'] })
    return () => { watch.disconnect(); window.clearTimeout(timer) }
  }, [])
  return (
    <Tooltip open={open} onOpenChange={o => setOpen(o && !quiet.current)}>
      <TooltipTrigger asChild ref={trigger} onClick={() => { quiet.current = true; setOpen(false) }} onPointerEnter={wake} onPointerLeave={wake} onBlur={wake}>{children}</TooltipTrigger>
      <TooltipContent side="right">{tip}</TooltipContent>
    </Tooltip>
  )
}

const iconTileVariants = cva('flex flex-none items-center justify-center', {
  variants: {
    /** md 34px (a menu or list row), lg 40px (a window's or a note's lead), xl 46px (a skill). */
    size: { md: 'size-8.5 rounded-lg', lg: 'size-10 rounded-xl', xl: 'size-11.5 rounded-xl' },
    /** `ink` and `brand` are solid tiles (a skill that's on; brand in Run); `locked` a skill a later stage includes. */
    tone: {
      fill: 'bg-fill', hover: 'bg-fill-hover', outline: 'border border-border bg-card',
      ink: 'bg-foreground text-primary-foreground', brand: 'bg-brand text-primary-foreground', locked: 'bg-fill-strong text-foreground-3',
    },
  },
  defaultVariants: { size: 'md', tone: 'fill' },
})

/** A square holding one icon, beside a title or a row. Decorative: the text next to it carries the meaning. */
export function IconTile({ icon, iconSize = 18, size, tone, className }: VariantProps<typeof iconTileVariants> & { icon: string; iconSize?: number; className?: string }) {
  return (
    <span aria-hidden="true" className={cn(iconTileVariants({ size, tone }), className)}>
      <Icon name={icon} size={iconSize} />
    </span>
  )
}

const windowHeaderVariants = cva('flex gap-3 pt-4.5 pr-3.5 pl-5.5', {
  variants: {
    described: { true: 'items-start pb-1.5', false: 'items-center pb-2.5' },
  },
  defaultVariants: { described: false },
})

/** The top of a window: an optional leading tile, the title with an optional description, and Close. */
export function WindowHeader({ title, description, leading, onClose }: { title: string; description?: string; leading?: ReactNode; onClose: () => void }) {
  return (
    <div className={windowHeaderVariants({ described: !!description })}>
      {leading}
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold tracking-section">{title}</h2>
        {description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
      </div>
      <IconButton icon="close" label="Close" onClick={onClose} />
    </div>
  )
}

/**
 * A row in a "···" menu: 38px, base text, an icon then the label. `destructive` for Delete. `locked` is an item a later
 * stage includes: it stays in the menu and focusable, so its tag is read, and picking it does nothing (the menu stays
 * open and `onSelect` doesn't run). A `disabled` item takes the locked text, never a dim.
 */
export function MenuItem({ variant = 'default', locked, onSelect, className, ...rest }: ComponentProps<typeof DropdownMenuItem> & { locked?: boolean }) {
  return (
    <DropdownMenuItem variant={variant} aria-disabled={locked || undefined} onSelect={locked ? e => e.preventDefault() : onSelect}
      className={cn('h-9.5 text-base', variant !== 'destructive' && 'text-foreground', locked && 'text-foreground-3 focus:text-foreground-3',
        'data-[disabled]:text-foreground-3 data-[disabled]:opacity-100', className)} {...rest} />
  )
}

// The least room a floating bar keeps from each window edge, as max-w-screen-gutter-sm does.
const BAR_EDGE = 12

/**
 * Where a floating bar's centre goes: the horizontal centre of `el`, moved in so the bar (measured itself) keeps
 * `BAR_EDGE` from each window edge. Kept up to date as `el`, the bar or the main area resizes.
 */
function useCentreOf(el: RefObject<HTMLElement | null> | undefined, bar: RefObject<HTMLElement | null>) {
  const [x, setX] = useState<number | null>(null)
  useLayoutEffect(() => {
    const node = el?.current
    const own = bar.current
    if (!node || !own) return
    const measure = () => {
      const r = node.getBoundingClientRect()
      // offsetWidth ignores the bar's own translate. The bar is never wider than the window less both edges.
      const half = own.offsetWidth / 2 + BAR_EDGE
      setX(Math.min(Math.max(r.left + r.width / 2, half), document.documentElement.clientWidth - half))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(node)
    // The bar's width changes with what's picked ("3 selected", a Delete that appears).
    ro.observe(own)
    // A content column at its widest moves without resizing when the area around it does (the sidebar collapsing).
    const area = node.closest('main')
    if (area) ro.observe(area)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [el, bar])
  return x
}

/**
 * Select mode's floating bar (the Library, All chats): what's picked, then its actions as `inverse` buttons (a picked
 * Delete as `destructive`). It sits where a toast would, so it carries `data-bottom-dock` and the toasts stack above it.
 * `over` is the content it acts on (the list, the file grid): the bar centres on it, not on the window, as far as it
 * can while keeping 12px from each window edge. The page
 * gives its last row room to scroll clear of the bar (`pb-24` while it shows).
 */
export function SelectionBar({ label, status, over, children }: { label: string; status: ReactNode; over?: RefObject<HTMLElement | null>; children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null)
  const centre = useCentreOf(over, bar)
  return (
    // w-max: the bar is as wide as its content wherever it sits (a fixed box near the right edge would otherwise shrink).
    <div ref={bar} role="toolbar" aria-label={label} data-bottom-dock style={centre === null ? undefined : { left: centre }}
      className="fixed bottom-toast left-1/2 z-bar box-border flex w-max max-w-screen-gutter-sm -translate-x-1/2 items-center gap-1.5 rounded-xl bg-primary py-2 pr-2 pl-4 text-sm text-primary-foreground shadow-menu">
      <span className="ellipsis mr-2 min-w-0 tabular-nums">{status}</span>
      {children}
    </div>
  )
}

// Inhouse's look on the stock accordion: a divider between guides, the tile and title centred with base text, the
// chevron level with them, no underline on hover and the base focus outline in place of the stock ring.
const GUIDE_TRIGGER = 'min-h-14 items-center gap-3 py-2 text-base font-strong hover:no-underline [&>.ms]:translate-y-0 ' +
  'focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring'

/** One guide in Help: an `Accordion` item with its icon tile and title, and the text that opens under it. */
export function Guide({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return (
    <AccordionItem value={title} className="border-divider">
      <AccordionTrigger className={GUIDE_TRIGGER}>
        <IconTile icon={icon} />
        <span className="min-w-0 flex-1">{title}</span>
      </AccordionTrigger>
      <AccordionContent className="ml-11.5 text-base leading-prose text-pretty text-foreground-3">{children}</AccordionContent>
    </AccordionItem>
  )
}

/** The chip's dismiss button: its colours follow the chip's tone, and `tap` widens its hit area to 44px (phone). */
const attachmentDismissVariants = cva('flex-none', {
  variants: {
    tone: { default: 'text-muted-foreground hover:text-muted-foreground', error: 'text-destructive-text hover:text-destructive-text' },
    tap: { true: TAP, false: '' },
  },
  defaultVariants: { tone: 'default', tap: false },
})

/**
 * A file chip on the base `Attachment` (size `sm`): icon, name and size. With `onRemove` it shows a Remove button (the
 * composer's chip, before sending). `error` is a file that wasn't added: `meta` says why and its button is Dismiss; the
 * caller groups rejected chips in one `role="alert"` region. `onDownload` is a saved file's chip; `downloading` marks
 * it processing and disables the button while the file is on its way. `tap` gives the button a 44px hit area (phone).
 */
export function AttachmentChip({ icon, name, meta, onRemove, onDownload, downloading, error, tap }: { icon: string; name: string; meta: string; onRemove?: () => void; /** A saved file's chip: shows Download. `downloading` disables it while the file is on its way. */ onDownload?: () => void; downloading?: boolean; error?: boolean; tap?: boolean }) {
  const removable = !!onRemove
  return (
    <Attachment size="sm" state={error ? 'error' : downloading ? 'processing' : 'done'} {...(error ? { 'data-rejected': '' } : {})}
      className={cn('flex-nowrap items-center data-[state=error]:bg-destructive-tint data-[state=error]:text-destructive-text',
        removable ? 'max-w-70 border-transparent bg-accent pr-1' : 'max-w-full pr-2', onDownload && !error && 'pr-1')}>
      <AttachmentMedia className={cn(removable && !error && 'border border-border bg-card')}>
        <Icon name={error ? 'error' : icon} size={removable ? 17 : 16} />
      </AttachmentMedia>
      {/* A removable chip stacks the name over the size or the reason; the one in a message keeps them on a line. */}
      <AttachmentContent className={cn(!removable && 'flex items-baseline gap-2')}>
        <AttachmentTitle className={cn(!removable && 'min-w-0 flex-1')}>{name}</AttachmentTitle>
        <AttachmentDescription className={cn(!removable && 'mt-0 flex-none')}>{meta}</AttachmentDescription>
      </AttachmentContent>
      {((onDownload && !error) || onRemove) && (
        <AttachmentActions>
          {onDownload && !error && (
            <IconButton icon="download" label={`Download ${name}`} size={16} box="icon-sm" onClick={onDownload} disabled={downloading} aria-busy={downloading || undefined}
              className={attachmentDismissVariants({ tone: 'default', tap })} />
          )}
          {onRemove && (
            <IconButton icon="close" label={`${error ? 'Dismiss' : 'Remove'} ${name}`} size={16} box="icon-sm" onClick={onRemove}
              className={attachmentDismissVariants({ tone: error ? 'error' : 'default', tap })} />
          )}
        </AttachmentActions>
      )}
    </Attachment>
  )
}
