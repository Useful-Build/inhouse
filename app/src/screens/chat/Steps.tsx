// The two quiet controls around an answer: the steps line above its card ("Checked Shopify and ShipBob · 3 steps", which
// opens the list of steps in place, with a way on into the trace window) and the sources row at the foot of the card.
import { useId, useState } from 'react'
import type { MessagePart, Trace } from '../../agent/types'
import { fmtDuration, fmtTime } from '../../lib/format'
import type { At } from '../../lib/format'
import { display } from '../../state/display'
import { listNames } from '../../state/derive'
import { useCtx, useUi } from '../../state/store'
import { Icon, LogoCount, LogoTile } from '../../ui'
import { TAP } from '../../ui/fields'
import { cn } from '@/lib/utils'
import { sourcesOf, stepRows, toolNames } from './step-data'

/** A round mark for a tool step or source: its logo, or a plain link mark when it isn't one of the connected tools. */
function Mark({ tool, className }: { tool: string | null; className?: string }) {
  return tool === null
    ? <span aria-hidden="true" className={cn('flex size-7 flex-none items-center justify-center rounded-full border border-border bg-fill text-muted-foreground', className)}><Icon name="link" size={14} /></span>
    : <LogoTile k={tool} size="md" round className={cn('size-7', className)} />
}

const Chevron = ({ open, turn }: { open: boolean; turn: string }) => (
  <span aria-hidden="true" className={cn('flex flex-none transition-transform duration-200', open && turn)}><Icon name="expand_more" size={17} /></span>
)

/**
 * The finished steps, collapsed above the answer's card. Opening it lists each step with its time; at its foot, the mode that
 * answered, how long it took and when (as far as they're known), and Details, which opens the trace window.
 */
export function StepsLine({ trace, traceId, model, at, onToggle }: { trace: Trace; traceId: string; model?: string; at?: At; onToggle?: () => void }) {
  const ctx = useCtx()
  const phone = useUi(s => s.phone)
  const openTrace = useUi(s => s.openTrace)
  const [open, setOpen] = useState(false)
  const listId = useId()
  const rows = stepRows(ctx.data, trace)
  const names = toolNames(ctx.data, rows)
  // The steps listed (the run's own root line isn't one): a trace with none has no line.
  const n = rows.length
  if (n === 0) return null
  const count = `${n} ${n === 1 ? 'step' : 'steps'}`
  const d = display()
  const meta = [model, fmtDuration(trace.durationMs, d), at === undefined ? undefined : fmtTime(at, d)].filter(Boolean).join(' · ')
  return (
    <div data-steps className="mb-1.5 flex max-w-full flex-col items-start">
      <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => { onToggle?.(); setOpen(o => !o) }}
        className={cn('-ml-1.5 flex h-7 max-w-full items-center gap-1.5 rounded-md pr-1 pl-1.5 text-sm text-foreground-3 hover:bg-fill-hover hover:text-foreground', phone && TAP)}>
        {/* The check and "Checked" only when the run read from a tool; the count never gets cut, the tool names do. */}
        {names.length > 0 && <Icon name="check" size={16} className="flex-none" />}
        {names.length > 0 && <span className="ellipsis min-w-0">Checked {listNames(names)}</span>}
        <span className="flex-none whitespace-pre tabular-nums">{names.length > 0 ? ` · ${count}` : count}</span>
        <Chevron open={open} turn="-rotate-180" />
      </button>
      <div id={listId} hidden={!open} className="mt-1 flex w-full max-w-answer-measure flex-col">
        {open && (
          <>
            <ul className="flex flex-col">
              {rows.map((r, i) => (
                <li key={i} className="flex min-h-9 items-center gap-2.5 rounded-lg px-1.5 text-sm">
                  {r.tool === null
                    ? <span aria-hidden="true" className="flex size-7 flex-none items-center justify-center text-muted-foreground"><Icon name="check" size={15} /></span>
                    : <Mark tool={r.tool} />}
                  <span className="min-w-0 flex-1 text-foreground-2 wrap-anywhere">{r.text}</span>
                  {r.ms > 0 && <span className="flex-none text-muted-foreground tabular-nums">{fmtDuration(r.ms, d)}</span>}
                </li>
              ))}
            </ul>
            <div className="mt-0.5 ml-1.5 flex flex-wrap items-center gap-x-3 self-start">
              <button type="button" onClick={() => openTrace(traceId)}
                className={cn('flex h-7 items-center gap-0.5 rounded-md pr-1 pl-1.5 text-sm text-muted-foreground hover:bg-fill-hover hover:text-foreground', phone && TAP)}>
                Details<Icon name="chevron_right" size={17} />
              </button>
              <span data-steps-meta className="text-sm text-muted-foreground tabular-nums">{meta}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** The answer's sources, as one quiet pill at the foot of its card: the tools' overlapping logos, the count and a chevron. Opens a plain list. No row when there are none. */
export function SourcesRow({ parts, trace, onToggle }: { parts: readonly MessagePart[]; trace: Trace | null | undefined; onToggle?: () => void }) {
  const ctx = useCtx()
  const phone = useUi(s => s.phone)
  const [open, setOpen] = useState(false)
  const listId = useId()
  const sources = sourcesOf(ctx.data, parts, trace)
  if (sources.length === 0) return null
  const tools = [...new Set(sources.flatMap(s => (s.tool === null ? [] : [s.tool])))]
  const d = display()
  return (
    <div data-sources className="flex min-w-0 max-w-full flex-col items-start">
      <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => { onToggle?.(); setOpen(o => !o) }}
        className={cn('flex h-8 items-center gap-2 rounded-full bg-fill py-0 pr-2 pl-1.5 text-sm text-foreground-3 hover:bg-fill-hover hover:text-foreground', phone && TAP)}>
        {tools.length > 0 && (
          <span aria-hidden="true" className="flex items-center -space-x-1.5">
            {tools.slice(0, 3).map(k => <LogoTile key={k} k={k} size="sm" round className="ring-2 ring-fill" />)}
            {tools.length > 3 && <LogoCount n={tools.length - 3} size="sm" className="ring-2 ring-fill" />}
          </span>
        )}
        <span>{sources.length} {sources.length === 1 ? 'source' : 'sources'}</span>
        <Chevron open={open} turn="-rotate-180" />
      </button>
      <ul id={listId} hidden={!open} className="mt-2 flex w-full max-w-answer-measure flex-col">
        {open && sources.map(s => (
          <li key={s.id} className="flex items-center gap-3 rounded-xl px-1.5 py-1.5 hover:bg-fill-hover">
            <Mark tool={s.tool} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium wrap-anywhere">{s.title}</div>
              <div className="text-sm text-muted-foreground wrap-anywhere">{s.read ? `${s.toolName} · ${s.read}` : s.toolName}</div>
            </div>
            {s.ms !== undefined && <span className="flex-none text-sm text-muted-foreground tabular-nums">{fmtDuration(s.ms, d)}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
