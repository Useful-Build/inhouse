// The two quiet controls around an answer: the Chain of Thought steps line above its card ("Checked Shopify and ShipBob · 3 steps")
// and the Sources row at the foot of the card, built on Trace primitives from src/ui/agent.
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { MessagePart, Trace as TraceData } from '../../agent/types'
import { fmtDuration, type At, type Display } from '../../lib/format'
import { display } from '../../state/display'
import { listNames } from '../../state/derive'
import { useCtx, useUi } from '../../state/store'
import { Button, Icon, LogoCount, LogoTile } from '../../ui'
import {
  StepToolTile,
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceLine,
  TraceRowMark,
  TraceTitle,
} from '../../ui/agent'
import { TAP } from '../../ui/fields'
import { mapTraceToTraceRows, sourcesOf, stepRows, toolNames, type TraceRow } from './step-data'

function StepBranch({ rows, d }: { rows: readonly TraceRow[]; d: Display }) {
  return (
    // Full-width rows, so durations line up down the column: Trace sizes a row that holds a line to its content (`w-fit`,
    // through a child selector a plain `w-full` on the row can't beat), and `cn` swaps that one class for this.
    <Trace className="gap-1.5 *:has-[>[data-slot=trace-line]]:w-full">
      {rows.map(r => {
        const ms = r.endMs !== undefined && r.startMs !== undefined ? Math.max(0, r.endMs - r.startMs) : 0
        return (
          <div key={r.id} className="flex min-w-0 flex-col gap-1.5">
            <TraceLine status={r.status === 'done' ? undefined : r.status} className="w-full gap-2.5 px-1 py-0.5 text-sm">
              <TraceRowMark tool={r.tool} icon={r.icon} tileSize="sm" iconSize={15} />
              <TraceTitle className="flex-1 text-foreground-2 whitespace-normal wrap-anywhere">{r.title}</TraceTitle>
              {ms > 0 && <TraceDescription>{fmtDuration(ms, d)}</TraceDescription>}
            </TraceLine>
            {r.children.length > 0 && (
              <div className="ml-2.5 border-l border-border pl-3.5">
                <StepBranch rows={r.children} d={d} />
              </div>
            )}
          </div>
        )
      })}
    </Trace>
  )
}

/**
 * The finished steps, collapsed above the answer's card as Chain of Thought. Opening it lists each step with its tool
 * logo or kind icon and duration; at its foot, Details (opens the trace window), the mode that answered and total duration.
 */
export function StepsLine({ trace, traceId, model, at: _at, onToggle }: { trace: TraceData; traceId: string; model?: string; at?: At; onToggle?: () => void }) {
  const ctx = useCtx()
  const phone = useUi(s => s.phone)
  const openTrace = useUi(s => s.openTrace)
  const [open, setOpen] = useState(false)
  const rows = stepRows(ctx.data, trace)
  const names = toolNames(ctx.data, rows)
  // The steps listed (the run's own root line isn't one): a trace with none has no line.
  const n = rows.length
  if (n === 0) return null
  const tree = mapTraceToTraceRows(ctx.data, trace)
  const stepTree = tree.flatMap(r => (r.kind === 'root' ? r.children : [r]))
  const count = `${n} ${n === 1 ? 'step' : 'steps'}`
  const d = display()
  const meta = [model, fmtDuration(trace.durationMs, d)].filter(Boolean).join(' · ')

  return (
    <TraceCollapsible data-steps open={open} onOpenChange={o => { onToggle?.(); setOpen(o) }} className="mb-1.5 items-start">
      <TraceCollapsibleTrigger
        className={cn('-ml-1.5 h-7 gap-1.5 pr-1 pl-1.5 text-sm hover:bg-fill-hover', phone && TAP)}>
        {/* The check and "Checked" only when the run read from a tool; the count never gets cut, the tool names do. */}
        {names.length > 0 && <Icon name="check" size={16} className="flex-none" />}
        {names.length > 0 && <span className="ellipsis min-w-0">Checked {listNames(names)}</span>}
        <span className="flex-none whitespace-pre tabular-nums">{names.length > 0 ? ` · ${count}` : count}</span>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="w-full max-w-answer-measure pr-0">
        <StepBranch rows={stepTree} d={d} />
        <div className="mt-2 flex flex-wrap items-center gap-x-3">
          <Button variant="quiet" size="sm" onClick={() => openTrace(traceId)}
            className={cn('h-7 gap-0.5 rounded-md pr-1 pl-1.5 text-sm text-muted-foreground hover:bg-fill-hover hover:text-foreground hover:no-underline', phone && TAP)}>
            Details<Icon name="chevron_right" size={17} />
          </Button>
          <span data-steps-meta className="text-sm text-muted-foreground tabular-nums">{meta}</span>
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/**
 * The answer's sources, on shadcn's Sources pattern: one quiet pill trigger with overlapping tool logos, count and
 * chevron, opening a plain list of internal tool records (no links). No row when there are none.
 */
export function SourcesRow({ parts, trace, onToggle }: { parts: readonly MessagePart[]; trace: TraceData | null | undefined; onToggle?: () => void }) {
  const ctx = useCtx()
  const phone = useUi(s => s.phone)
  const [open, setOpen] = useState(false)
  const sources = sourcesOf(ctx.data, parts, trace)
  if (sources.length === 0) return null
  const tools = [...new Set(sources.flatMap(s => (s.tool === null ? [] : [s.tool])))]
  const d = display()

  return (
    <TraceCollapsible data-sources open={open} onOpenChange={o => { onToggle?.(); setOpen(o) }} className="min-w-0 items-start">
      <TraceCollapsibleTrigger
        className={cn('h-8 gap-2 rounded-full bg-fill py-0 pr-2 pl-1.5 text-sm hover:bg-fill-hover', phone && TAP)}>
        {tools.length > 0 && (
          <span aria-hidden="true" className="flex items-center -space-x-1.5">
            {tools.slice(0, 3).map(k => <LogoTile key={k} k={k} size="sm" round className="ring-2 ring-fill" />)}
            {tools.length > 3 && <LogoCount n={tools.length - 3} size="sm" className="ring-2 ring-fill" />}
          </span>
        )}
        <span>{sources.length} {sources.length === 1 ? 'source' : 'sources'}</span>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="w-full max-w-answer-measure">
        <Trace className="gap-1">
          <ul role="list" className="flex flex-col gap-1">
            {sources.map(s => (
              <li key={s.id} className="flex items-center gap-3 rounded-xl px-1.5 py-1.5 hover:bg-fill-hover">
                <StepToolTile tool={s.tool} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground wrap-anywhere">{s.title}</div>
                  <div className="text-sm text-muted-foreground wrap-anywhere">{s.read ? `${s.toolName} · ${s.read}` : s.toolName}</div>
                </div>
                {s.ms !== undefined && <TraceDescription className="text-sm">{fmtDuration(s.ms, d)}</TraceDescription>}
              </li>
            ))}
          </ul>
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
