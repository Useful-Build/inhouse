// Shared agent row compositions on top of shadcn/ui's Trace primitives (UI_BASE_V2 decision 3). The Code Block parts are
// in code.tsx, so the steps line doesn't bring them into Today's first load.
// Screens and overlays import from `src/ui/agent`, never directly from `src/components/ui`.
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Trace,
  TraceCollapsible as BaseTraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { Icon, LogoTile } from '../index'

export {
  Badge,
  Trace,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
}

/**
 * The base Trace collapsible, its content clipped with `overflow: clip` instead of the base's `overflow: hidden`. While the
 * content opens with its height animation it is clipped, and a `hidden` box is still a scroll container: focus or a
 * scroll-into-view (a keyboard Tab, a test's click) could scroll the rows up inside the clip, and then the browser pulls
 * them back down as the box grows, so a button there moves under the pointer between press and release (#607). A `clip`
 * box can't be scrolled, so every row stays where it is laid out and only appears once the box reaches it.
 *
 * Its height animation also fills backwards (`animation-fill-mode: backwards`). The animation runs on the main thread and
 * starts in the same frame as the trigger's chevron, which the compositor rotates, so Chrome holds it at its first frame
 * and then gives it the compositor's start time. That time can land just after the clock of the frame that applies it,
 * and for that frame the animation is in its "before" phase: with no fill it has no effect at all, so the list was drawn
 * at its full height (Details there to press) and the next frame collapsed it and opened it from zero under the pointer
 * (#607). A busy page (an answer's markdown landing) stretches that one frame. Filled backwards, the before phase holds
 * the first keyframe, height 0, so the list only ever grows.
 */
export function TraceCollapsible(props: ComponentProps<typeof BaseTraceCollapsible>) {
  return <BaseTraceCollapsible {...props} className={cn('*:data-[slot=trace-collapsible-content]:overflow-clip *:data-[slot=trace-collapsible-content]:fill-mode-backwards', props.className)} />
}

/** A tool logo tile when `tool` is connected, or a round neutral tile with an icon when it isn't. */
export function StepToolTile({ tool, icon = 'link', size = 'md', iconSize = 14, className }: {
  tool: string | null; icon?: string; size?: 'xs' | 'sm' | 'md'; iconSize?: number; className?: string
}) {
  if (tool !== null) return <LogoTile k={tool} size={size} round className={cn(size === 'md' && 'size-7', className)} />
  const box = size === 'xs' ? 'size-4.5' : size === 'sm' ? 'size-5.5' : 'size-7'
  return (
    <span aria-hidden="true" className={cn('flex flex-none items-center justify-center rounded-full border border-border bg-fill text-muted-foreground', box, className)}>
      <Icon name={icon} size={iconSize} />
    </span>
  )
}

/** Icon slot for a Trace row: a round tool logo when matched, else the step's kind icon. */
export function TraceRowMark({ tool, icon, status, tileSize = 'xs', iconSize = 15, className }: {
  tool: string | null
  icon: string
  status?: 'done' | 'running' | 'error' | 'pending'
  tileSize?: 'xs' | 'sm' | 'md'
  iconSize?: number
  className?: string
}) {
  if (tool !== null) return <LogoTile k={tool} size={tileSize} round className={className} />
  return (
    <TraceIcon className={cn(status === 'running' && icon === 'progress_activity' && 'animate-spin motion-reduce:animate-none', className)}>
      <Icon name={icon} size={iconSize} />
    </TraceIcon>
  )
}

export type TraceLineStatus = ComponentProps<typeof TraceLine>['status']
