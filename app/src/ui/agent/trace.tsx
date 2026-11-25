// Shared agent row compositions on top of shadcn/ui's Trace primitives (UI_BASE_V2 decision 3). The Code Block parts are
// in code.tsx, so the steps line doesn't bring them into Today's first load.
// Screens and overlays import from `src/ui/agent`, never directly from `src/components/ui`.
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Trace,
  TraceCollapsible,
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
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
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
