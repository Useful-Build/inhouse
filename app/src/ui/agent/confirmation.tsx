// A draft or action waiting on the person's answer, composed from ui-base's Item the way shadcn's Confirmation pattern is
// (UI_BASE_V2 PR E): ItemMedia for the icon, ItemContent for the kicker and title, ItemActions for the buttons.
// Ours keeps the brand-tint sheet, the quoted draft text and the "Open" link; the caller decides which buttons show
// (a sensitive draft gets Review, never a one-tap Approve) and what the answered row says.
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Icon } from '../index'

/** The sheet itself: a brand-tint card, its own after the answer's. */
export const CONFIRMATION_SHEET = 'box-border max-w-full self-start rounded-3xl border-0 bg-draft-sheet px-5 py-4'

type ConfirmationProps = Omit<ComponentProps<typeof Item>, 'title'> & {
  icon: string
  kicker: string
  title: string
  openLabel: string
  onOpen: () => void
  /** The quoted draft text, with its small label. */
  body?: ReactNode
  bodyLabel?: string
  /** The row under the draft: `ConfirmationButtons` while it waits, `ConfirmationResult` once answered. */
  children?: ReactNode
}

export function Confirmation({ icon, kicker, title, openLabel, onOpen, body, bodyLabel, children, className, ...rest }: ConfirmationProps) {
  return (
    <Item {...rest} className={cn(CONFIRMATION_SHEET, 'w-prose-measure flex-col items-stretch gap-0', className)}>
      <div className="flex items-center gap-3">
        <ItemMedia variant="icon" className="size-10 flex-none translate-y-0 self-center rounded-full border border-border bg-draft-kind text-foreground-3" aria-hidden="true">
          <Icon name={icon} size={20} />
        </ItemMedia>
        <ItemContent className="min-w-0 gap-0">
          <ItemDescription className="order-first line-clamp-none text-sm text-muted-foreground">{kicker}</ItemDescription>
          <ItemTitle className="line-clamp-none w-auto text-md font-strong tracking-card wrap-anywhere">{title}</ItemTitle>
        </ItemContent>
        <ItemActions className="flex-none">
          <button type="button" onClick={onOpen} aria-label={`${openLabel}: ${title}`}
            className="flex flex-none items-center gap-0.5 text-base text-foreground-3 hover:text-foreground">
            Open<Icon name="chevron_right" size={18} />
          </button>
        </ItemActions>
      </div>
      {body && (
        <div className="mt-3 rounded-xl bg-draft-kind px-3.5 py-3 text-sm leading-prose text-foreground-2 wrap-anywhere">
          <div className="mono-label mb-1.5 tracking-caps">{bodyLabel ?? 'Your note'}</div>{body}
        </div>
      )}
      {children}
    </Item>
  )
}

/** The buttons while the answer is open: Approve, or Review for a sensitive draft. */
export function ConfirmationButtons({ children }: { children: ReactNode }) {
  return (
    <ItemFooter className="mt-3 justify-start">
      <ItemActions className="flex-wrap">{children}</ItemActions>
    </ItemFooter>
  )
}

/** The row once answered: what happened, and an Undo while there is one. */
export function ConfirmationResult({ line, action }: { line: string; action?: ReactNode }) {
  return (
    <ItemFooter className="mt-3 justify-start gap-2 text-sm font-strong">
      <Icon name="check_circle" size={17} />
      <span className="min-w-0 flex-1">{line}</span>
      {action}
    </ItemFooter>
  )
}
