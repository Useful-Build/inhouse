// Page parts every screen repeats: the page column, its header, section heads, card grids, key and value lists and
// empty states. Screens compose these instead of rebuilding the look by hand.
import type { ComponentProps, ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const pageVariants = cva('page', {
  variants: {
    // The page width steps (--app-page-* in src/index.css): every list page shares `default`, so the content edge
    // doesn't move between them; Today and Usage are `wide`; a skill's page, its instructions beside a rail, is `detail`.
    width: { default: 'max-w-page-default', wide: 'max-w-page-wide', detail: 'max-w-page-detail' },
  },
  defaultVariants: { width: 'default' },
})

export type PageWidth = NonNullable<VariantProps<typeof pageVariants>['width']>

/** A page's centered column, at one of the page width steps. */
export function Page({ width, className, ...rest }: ComponentProps<'div'> & { width?: PageWidth }) {
  return <div className={cn(pageVariants({ width }), className)} {...rest} />
}

/**
 * A page's title (the h1), an optional line under it that adds information, and actions on the right. `leading` sits
 * before the title and stays beside it on a phone too (a tool's logo); `tag` sits beside the title, or under it with
 * 8px gaps when the screen is narrow (a tool's status).
 */
export function PageHeader({ title, description, actions, leading, tag, truncate, className }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; leading?: ReactNode; tag?: ReactNode; className?: string
  /** Keep a long title on one line and cut it with an ellipsis (a name the user chose, like a library place). The full name shows in a tooltip. */
  truncate?: boolean
}) {
  // A cut title keeps 2px under its line for descenders, so the block (37px) stays under the 38px actions beside it
  // and the row is the actions' height: the Library's type tabs then sit level with the place list.
  // max-w-full: a cut title beside or above a tag still ends at its column's edge.
  const h1 = <h1 className={cn('text-3xl leading-title font-medium tracking-title', truncate && 'ellipsis max-w-full pb-0.5')}>{title}</h1>
  // The title with its tooltip first, then the tag beside it, so a cut title keeps its tag.
  const named = truncate && typeof title === 'string'
    ? <Tooltip><TooltipTrigger asChild>{h1}</TooltipTrigger><TooltipContent className="max-w-80">{title}</TooltipContent></Tooltip>
    : h1
  const text = <>
    {tag
      // The tag's box centres on the line box, which sits 2px above the title's capitals: it moves down by that much.
      ? <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">{named}<div className="flex flex-none sm:translate-y-0.5">{tag}</div></div>
      : named}
    {description && <p className="mt-2 text-md text-pretty text-foreground-3">{description}</p>}
  </>
  const basis = description ? 'basis-80' : truncate ? 'basis-40' : 'basis-0'
  return (
    <div className={cn('flex flex-wrap items-end gap-x-5 gap-y-3.5', leading && 'items-center', className)}>
      {leading
        ? <div className={cn('flex min-w-32 grow items-center gap-4', basis)}>{leading}<div className="min-w-0 flex-1">{text}</div></div>
        : <div className={cn('min-w-32 grow', basis)}>{text}</div>}
      {actions && <div className="flex max-w-full flex-none flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
  )
}

const sectionTitleVariants = cva('flex items-center gap-2.5 text-base font-semibold', {
  variants: {
    // Straight on the dotted page (Today): a page-coloured patch keeps it readable.
    onDots: { true: 'on-page', false: '' },
  },
  defaultVariants: { onDots: false },
})

/**
 * A section's title (an h2), with an optional count as "Title · 6", a leading mark and actions on the right. It sits on
 * the page's content edge: never indent it at the call.
 */
export function SectionHeader({ title, count, icon, actions, onDots, id, className }: {
  /** The h2's id, for a section that names itself with `aria-labelledby`. */
  id?: string
  title: ReactNode; count?: ReactNode; icon?: ReactNode; actions?: ReactNode; onDots?: boolean; className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1', className)}>
      {/* The title takes the free space and wraps in balanced lines, so the action keeps its place on the first row.
          The dot is held to the words on both sides, so a line never starts with it. */}
      <div className="min-w-0 flex-1">
        <h2 id={id} className={cn(sectionTitleVariants({ onDots }), 'w-fit max-w-full text-balance')}>
          {icon}
          <span>{title}{count != null && <>{'\u00a0'}<span className="font-normal text-muted-foreground">{'·\u00a0'}{count}</span></>}</span>
        </h2>
      </div>
      {actions && <div className="ml-auto flex-none">{actions}</div>}
    </div>
  )
}

const cardGridVariants = cva('grid', {
  variants: {
    // The narrowest a card gets before the row wraps (--app-grid-cards-*).
    size: { sm: 'grid-cols-cards-sm', default: 'grid-cols-cards', lg: 'grid-cols-cards-lg', wide: 'grid-cols-cards-wide' },
    // `cards` for bordered cards, `rows` for borderless list rows laid out in columns (Tools, Skills). A row's hover
    // fill bleeds out by its 12px padding (`p-3`), so its icon and its button sit on the content edge with the headings.
    variant: { cards: 'gap-4', rows: '-mx-3 gap-x-4 gap-y-0.5' },
  },
  defaultVariants: { size: 'default', variant: 'cards' },
})

/** An auto-filling grid of cards or list rows. */
export function CardGrid({ size, variant, className, ...rest }: ComponentProps<'div'> & VariantProps<typeof cardGridVariants>) {
  return <div className={cn(cardGridVariants({ size, variant }), className)} {...rest} />
}

const detailRowVariants = cva('flex gap-x-4', {
  variants: {
    // ruled: a divider under each row (inside a card). compact: tight rows (a detail panel, a side column).
    // relaxed: roomy rows that put the value under the key when the row is narrow.
    variant: {
      ruled: 'min-h-11.25 items-center border-b border-divider py-1',
      compact: 'py-1',
      relaxed: 'flex-wrap gap-y-0.5 py-2.25',
    },
  },
  defaultVariants: { variant: 'compact' },
})

const detailKeyVariants = cva('flex-none text-muted-foreground', {
  variants: {
    variant: { ruled: 'w-45 max-w-19/50', compact: 'w-24', relaxed: 'shrink-0 basis-45' },
  },
  defaultVariants: { variant: 'compact' },
})

/** Key and value rows. `strong` sets the values in medium weight. Text size comes from the parent. */
export function DetailList({ items, variant, strong, className }: {
  items: [string, ReactNode][]; strong?: boolean; className?: string
} & VariantProps<typeof detailRowVariants>) {
  return (
    <dl className={className}>
      {items.map(([k, v]) => (
        <div key={k} className={detailRowVariants({ variant })}>
          <dt className={detailKeyVariants({ variant })}>{k}</dt>
          <dd className={cn('min-w-0 text-pretty wrap-anywhere', variant === 'relaxed' ? 'grow basis-50' : 'flex-1', strong && 'font-medium tabular-nums')}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const emptyStateVariants = cva('text-center text-foreground-3', {
  variants: {
    // card: a bordered card where a list would be. inline: a quiet line in the page (a search with no results).
    variant: {
      card: 'rounded-2xl border border-border bg-card p-5.5 text-base',
      inline: 'my-10 text-md',
    },
  },
  defaultVariants: { variant: 'card' },
})

/** What shows where a list is empty. */
export function EmptyState({ variant, className, children }: { className?: string; children: ReactNode } & VariantProps<typeof emptyStateVariants>) {
  return <p role="status" className={cn(emptyStateVariants({ variant }), className)}>{children}</p>
}
