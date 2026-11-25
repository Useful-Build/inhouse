// "What your Inhouse agent did": the trace window with a Plain / Technical switch, nested Trace rows, replay controls,
// and in Technical view a slim duration bar per row (D2) plus a Code Block detail drawer. Plain view shows prose only
// and never mounts a CodeBlock, s.detail, s.io, model ids, or token counts.
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { traceOf, useTraces } from '../screens/chat/traces'
import { mapTraceToTraceRows, type TraceRow } from '../screens/chat/step-data'
import type { Trace as TraceData, TraceStepKind } from '../agent/types'
import { fmtDuration, fmtTraceCost, traceTicks, type Display } from '../lib/format'
import { display } from '../state/display'
import { useCtx, useUi } from '../state/store'
import { Button, Icon, IconButton, LogoTile, Segmented, Window } from '../ui'
import {
  Badge,
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../ui/agent'

// The hatches (bg-hatch-wait, bg-hatch-approval) are tokens in src/index.css.
const BAR_CLASS: Record<TraceStepKind, string> = {
  root: 'h-2.5 bg-chart-3',
  model: 'h-2.5 bg-foreground-3',
  tool: 'h-2.5 bg-chart-4',
  agent: 'h-2.5 bg-brand',
  wait: 'h-2 bg-hatch-wait border border-border-strong',
  handoff: 'h-0.5 border-t-2 border-dotted border-muted-foreground',
  answer: 'h-2.5 bg-foreground',
  fail: 'h-2.5 bg-destructive',
  approval: 'h-2 bg-hatch-approval border border-warning',
}
const LEGEND: { label: string; className: string }[] = [
  { label: 'Thinking', className: 'h-2.25 rounded-sm bg-foreground-3' },
  { label: 'Using a tool', className: 'h-2.25 rounded-sm bg-chart-4' },
  { label: 'Helper', className: 'h-2.25 rounded-sm bg-brand' },
  { label: 'Waiting', className: 'box-border h-2.25 rounded-sm border border-border-strong bg-hatch-wait' },
  { label: 'Passed on', className: 'border-t-2 border-dotted border-muted-foreground' },
  { label: 'Waits for approval', className: 'box-border h-2.25 rounded-sm border border-warning bg-hatch-approval' },
  { label: 'Failed', className: 'h-2.25 rounded-sm bg-destructive' },
]
/** What kind of step it is, in words, for screen readers on plain rows. */
const KIND_LABEL: Record<TraceStepKind, string> = {
  root: 'All steps', model: 'Thinking', tool: 'Using a tool', agent: 'Helper', wait: 'Waiting', handoff: 'Passed on',
  answer: 'Answer', fail: 'Failed', approval: 'Waits for approval',
}
const COL = 'grid-cols-trace'
const NEXT_SPEED: Record<number, number> = { 1: 2, 2: 5, 5: 1 }

export function TraceWindow() {
  const traceId = useUi(s => s.traceId)
  if (!traceId) return null
  return <TraceBody key={traceId} id={traceId} />
}

function TraceBody({ id }: { id: string }) {
  const close = useUi(s => s.closeOverlays)
  useCtx() // stage and scenario change what getTrace returns (Run drops approval waits, a tool can fail)
  useTraces()
  const trace = traceOf(id)
  if (trace === undefined) return null
  if (!trace) {
    return (
      <Window onClose={close} label="What your Inhouse agent did" size="sm" layer="trace">
        <div className="flex items-center gap-3.5 py-3.5 pr-3.5 pl-6">
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold">What your Inhouse agent did</div>
            <div className="mt-1.5 text-base text-foreground-3">These steps aren't available yet.</div>
          </div>
          <IconButton icon="close" label="Close" size={21} box="icon-lg" onClick={close} className="self-start text-foreground-2" />
        </div>
      </Window>
    )
  }
  return <TraceSteps trace={trace} />
}

function RowTile({ row, vis }: { row: TraceRow; vis: boolean }) {
  const kind = row.kind ?? 'tool'
  const ifg = !vis ? 'text-muted-foreground' : kind === 'agent' ? 'text-brand' : kind === 'fail' ? 'text-destructive' : kind === 'approval' ? 'text-warning-text' : 'text-foreground-2'
  return (
    <span aria-hidden="true" className={cn('flex size-7 flex-none items-center justify-center rounded-md border border-input', ifg)}>
      {row.tool !== null ? <LogoTile k={row.tool} size="xs" round /> : <Icon name={row.icon} size={16} />}
    </span>
  )
}

function durationText(row: TraceRow, t: number | null, d0: Display, trace: TraceData, tech: boolean): string {
  const startMs = row.startMs ?? 0
  const endMs = row.endMs ?? startMs
  const vis = t == null || startMs <= t
  if (!vis) return 'Not reached yet'
  const endT = t == null ? endMs : Math.min(endMs, t)
  const durMs = Math.max(0, endT - startMs)
  if (row.kind === 'approval') return tech ? 'waits for a person' : 'Waits for a person'
  if (row.kind === 'fail') return (tech ? 'failed after ' : 'Failed after ') + fmtDuration(durMs, d0)
  if (tech && row.kind === 'root' && t == null) return `${fmtDuration(durMs, d0)} · ${fmtTraceCost(trace, d0)}`
  return fmtDuration(durMs, d0)
}

function TechDetail({ row, dur }: { row: TraceRow; dur: string }) {
  const kind = row.kind ?? 'tool'
  const detail = row.detail ?? ''
  const parts = [detail, row.io?.input ? `Input:\n${row.io.input}` : ''].filter(Boolean)
  const body = parts.join('\n\n') || '—'
  return (
    <CodeBlock size="sm" variant={kind === 'fail' ? 'destructive' : 'default'} className="relative z-raised">
      <CodeBlockHeader>
        <CodeBlockTitle className="flex flex-wrap items-center gap-1.5">
          <span>kind: {kind}</span>
          <span>·</span>
          <span className="tabular-nums">{dur}</span>
          {row.io?.cut && <Badge variant="warning">cut</Badge>}
          {row.io?.denied && <Badge variant="destructive">denied</Badge>}
        </CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockActions>
        <CodeBlockCopyButton value={body} />
      </CodeBlockActions>
      <CodeBlockContent wrap>{body}</CodeBlockContent>
    </CodeBlock>
  )
}

function TraceSteps({ trace }: { trace: TraceData }) {
  const ctx = useCtx()
  const close = useUi(s => s.closeOverlays)
  const phone = useUi(s => s.phone)
  const [tech, setTech] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [t, setT] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const tRef = useRef<number | null>(null)
  const put = (v: number | null) => { tRef.current = v; setT(v) }

  const { steps } = trace
  const D = trace.durationMs
  const M = D * 1.22

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const next = (tRef.current ?? 0) + 50 * speed * (D > 60_000 ? 6 : 1)
      if (next >= D) { put(D); setPlaying(false) } else put(next)
    }, 50)
    return () => clearInterval(timer)
  }, [playing, speed, D])

  const onPlay = (restart: boolean) => {
    if (playing && !restart) { setPlaying(false); return }
    put(restart || t == null || t >= D ? 0 : t)
    setPlaying(true)
  }
  const onStop = () => { setPlaying(false); put(null) }

  const started = (row: TraceRow) => t == null || (row.startMs ?? 0) <= t
  const d0 = display()
  const fmtDur = (ms: number) => fmtDuration(ms, d0)
  const ticks = traceTicks(D, d0).map(k => ({ label: k.label, left: `${(k.ms / M) * 100}%` }))
  const tree = mapTraceToTraceRows(ctx.data, trace, { t })

  const cnt = (k: TraceStepKind) => steps.filter(s => s.kind === k && (t == null || s.startMs <= t)).length
  const toolsUsed = new Set(steps.filter(s => s.kind === 'tool' && s.label.includes(' · ') && (t == null || s.startMs <= t)).map(s => s.label.split(' · ')[0])).size
  const shown = fmtDur(t == null ? D : t)
  const stats: [string, string | number][] = tech
    ? [['Duration', shown], ['Cost', fmtTraceCost(trace, d0)], ['Tokens', trace.tokens], ['Model calls', cnt('model')], ['Tool calls', cnt('tool')], ['Errors', cnt('fail')]]
    : [['Time taken', shown], ['Cost', fmtTraceCost(trace, d0)], ['Tools used', toolsUsed], ['Steps', steps.length - 1], ['Waits', cnt('wait') + cnt('approval')], ['Problems', cnt('fail')]]

  const renderListNode = (row: TraceRow) => {
    const kind = row.kind ?? 'tool'
    const vis = started(row)
    const startMs = row.startMs ?? 0
    const endMs = row.endMs ?? startMs
    const dur = durationText(row, t, d0, trace, tech)
    const ownDur = fmtDur(Math.max(0, endMs - startMs))
    const open = sel === row.id

    return (
      <li key={row.id} aria-level={row.depth + 1}>
        <TraceCollapsible open={open} onOpenChange={o => setSel(o ? row.id : null)}>
          <TraceCollapsibleTrigger
            data-testid="trace-row"
            style={{ paddingLeft: 16 + row.depth * 16 }}
            className={cn('w-full justify-between gap-2 rounded-none border-b border-divider py-2.5 pr-4 hover:bg-accent', open && 'bg-accent', !vis && 'text-muted-foreground')}>
            <TraceLine status={row.status === 'done' ? undefined : row.status} className="w-full min-w-0 items-start gap-3">
              <RowTile row={row} vis={vis} />
              <span className="min-w-0 flex-1">
                <span className="sr-only">{KIND_LABEL[kind]}: </span>
                <TraceTitle data-step-name className={cn('block overflow-visible text-base text-clip whitespace-normal wrap-anywhere', kind === 'root' && 'font-semibold', vis ? 'text-foreground' : 'text-muted-foreground')}>
                  {row.label}
                </TraceTitle>
                <span className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground tabular-nums">
                  {row.status === 'running' && (
                    <TraceIcon className="animate-spin motion-reduce:animate-none"><Icon name="progress_activity" size={15} /></TraceIcon>
                  )}
                  <TraceDescription>{dur}</TraceDescription>
                  {row.slowest && t == null && <Badge variant="warning" size="lg">Slowest</Badge>}
                </span>
              </span>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="my-0 mr-3 mb-2 border-l border-border pt-2 pr-1 pb-1 pl-4" style={{ marginLeft: 28 + row.depth * 16 }}>
            {tech ? (
              <TechDetail row={row} dur={ownDur} />
            ) : (
              <div className="text-sm text-foreground-3 wrap-anywhere">
                {(row.plainDetail ?? '') + (kind === 'approval' ? '' : ` · took ${ownDur}`)}
              </div>
            )}
          </TraceCollapsibleContent>
        </TraceCollapsible>
        {row.children.length > 0 && (
          <ol role="list" className="flex flex-col">
            {row.children.map(renderListNode)}
          </ol>
        )}
      </li>
    )
  }

  const renderTechNode = (row: TraceRow) => {
    const kind = row.kind ?? 'tool'
    const vis = started(row)
    const startMs = row.startMs ?? 0
    const endMs = row.endMs ?? startMs
    const endT = t == null ? endMs : Math.min(endMs, t)
    const dur = durationText(row, t, d0, trace, true)
    const ownDur = fmtDur(Math.max(0, endMs - startMs))
    const open = sel === row.id

    return (
      <div key={row.id} className="min-w-0">
        <TraceCollapsible open={open} onOpenChange={o => setSel(o ? row.id : null)}>
          <div className={cn('grid min-h-11.5 w-full items-stretch border-b border-divider', COL, open ? 'bg-accent' : 'hover:bg-accent', !vis && 'text-muted-foreground')}>
            <TraceCollapsibleTrigger
              data-testid="trace-row"
              style={{ paddingLeft: 22 + row.depth * 26 }}
              className="h-full w-full justify-between rounded-none py-2 pr-3 hover:text-foreground">
              <TraceLine status={row.status === 'done' ? undefined : row.status} className="min-w-0 flex-1 gap-2.5 text-base">
                <RowTile row={row} vis={vis} />
                {row.status === 'running' && (
                  <TraceIcon className="animate-spin text-muted-foreground motion-reduce:animate-none"><Icon name="progress_activity" size={15} /></TraceIcon>
                )}
                <TraceTitle data-step-name className={cn(kind === 'root' && 'font-semibold', vis ? 'text-foreground' : 'text-muted-foreground')}>
                  {row.label}
                </TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <div onClick={() => setSel(open ? null : row.id)} className="relative cursor-pointer">
              {vis && (
                <>
                  <i
                    className={cn('absolute top-1/2 box-border min-w-0.75 -translate-y-1/2 rounded-sm', BAR_CLASS[kind])}
                    style={{ left: `${(startMs / M) * 100}%`, width: `${Math.max(0, (endT - startMs) / M) * 100}%` }}
                  />
                  <span
                    className="absolute top-1/2 ml-2 flex -translate-y-1/2 items-center gap-2 text-sm whitespace-nowrap text-muted-foreground tabular-nums"
                    style={{ left: `${(endT / M) * 100}%` }}>
                    {dur}
                    {row.slowest && t == null && <Badge variant="warning" size="lg">Slowest</Badge>}
                  </span>
                </>
              )}
            </div>
          </div>
          <TraceCollapsibleContent className="relative z-raised my-0 ml-0 border-b border-divider bg-window-surface px-6 py-3">
            <TechDetail row={row} dur={ownDur} />
          </TraceCollapsibleContent>
        </TraceCollapsible>
        {row.children.length > 0 && row.children.map(renderTechNode)}
      </div>
    )
  }

  return (
    <Window onClose={close} label="What your Inhouse agent did" size="xl" layer="trace">
      {/* On a phone the view switch takes its own row under the title. */}
      <div className={cn('flex flex-wrap items-center gap-x-3.5 gap-y-2 py-3.5 pr-3.5', phone ? 'pl-4' : 'pl-6')}>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold">What your Inhouse agent did</div>
          <div className={cn('text-sm text-muted-foreground', phone ? 'wrap-anywhere' : 'ellipsis')}>{trace.title}</div>
        </div>
        <div className={cn('flex-none', phone && 'order-last w-full')}>
          <Segmented label="View" value={tech ? 'tech' : 'plain'} options={[['plain', 'Plain'], ['tech', 'Technical']]} onChange={v => setTech(v === 'tech')} />
        </div>
        <IconButton icon="close" label="Close" size={21} box="icon-lg" onClick={close} className="self-start text-foreground-2" />
      </div>

      <div className="grid grid-cols-trace-stats border-y border-divider">
        {stats.map(([a, b], i) => (
          <div key={a} className={cn('border-l py-3', phone ? 'px-4' : 'px-5', i === 0 ? 'border-transparent' : 'border-divider')}>
            <div className="text-sm text-muted-foreground">{a}</div>
            <div className="mt-0.5 text-2xl tracking-stat tabular-nums">{b}</div>
          </div>
        ))}
      </div>

      {phone || !tech ? (
        // Plain view (desktop and phone) and phone Technical view: nested rows as a screen-reader list without bar rails.
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ol role="list" aria-label="Steps" className="min-h-0 flex-1 overflow-auto">
            {tree.map(renderListNode)}
          </ol>
          {phone && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-sheet-fade" />}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="relative">
            <div className={cn('grid h-11 border-b border-divider text-sm text-muted-foreground', COL)}>
              <div className="flex items-center gap-2 pl-5.5"><Icon name="account_tree" size={17} />Steps</div>
              <div className="relative">
                {ticks.map(k => <span key={k.label} className="absolute top-3.25 ml-1.5 tabular-nums" style={{ left: k.left }}>{k.label}</span>)}
              </div>
            </div>
            <Trace className="gap-0">
              {tree.map(renderTechNode)}
            </Trace>
            <div aria-hidden="true" className="pointer-events-none absolute top-0 right-0 bottom-0 left-trace-label">
              {ticks.map(k => <i key={k.label} className="absolute top-11 bottom-0 w-px bg-divider" style={{ left: k.left }} />)}
              {t != null && (
                <>
                  <i className="absolute top-9 bottom-0 -ml-px w-0.5 bg-foreground" style={{ left: `${(t / M) * 100}%` }} />
                  <i className="absolute top-8 -ml-playhead-offset size-playhead rounded-full bg-foreground" style={{ left: `${(t / M) * 100}%` }} />
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div className={cn('flex flex-wrap items-center gap-2.5 border-t border-divider py-3', phone ? 'px-4' : 'px-5')}>
        <IconButton icon={playing ? 'pause' : 'play_arrow'} label={playing ? 'Pause replay' : 'Replay'} size={24} box="icon-lg" filled onClick={() => onPlay(false)}
          className="flex-none rounded-full border border-border-strong hover:bg-accent" />
        <IconButton icon="replay" label="Restart" size={22} box="icon-lg" onClick={() => onPlay(true)} className="flex-none hover:bg-accent" />
        {t != null && <IconButton icon="stop" label="Stop and show everything" size={22} box="icon-lg" onClick={onStop} className="flex-none hover:bg-accent" />}
        <Button variant="outline" aria-label={`Replay speed ${speed}×. Change speed`} onClick={() => setSpeed(NEXT_SPEED[speed])} className="flex-none gap-1.5 tabular-nums">
          {speed}×<Icon name="unfold_more" size={17} className="text-muted-foreground" />
        </Button>
        <span className={cn('min-w-0 text-xs leading-note text-muted-foreground', !phone && 'ml-1.5')}>Replays the recorded steps.<br />Nothing runs again.</span>
        <div className="flex-1" />
        {/* The legend reads the timeline's bars: Plain view and phone have none. */}
        {tech && !phone && <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5 text-sm whitespace-nowrap text-foreground-2">
          {LEGEND.map(l => (
            <span key={l.label} className="flex items-center gap-1.75">
              <i aria-hidden="true" className={cn('w-5', l.className)} />{l.label}
            </span>
          ))}
        </div>}
      </div>
    </Window>
  )
}
