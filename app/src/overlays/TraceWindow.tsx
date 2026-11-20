// "What your Inhouse agent did": the trace window with a Plain / Technical switch, a timeline and a replay. On a phone
// the timeline is a plain list of the steps, each name in full with its time under it (H6, L9).
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { traceOf, useTraces } from '../screens/chat/traces'
import type { Trace, TraceStep, TraceStepKind } from '../agent/types'
import { fmtDuration, fmtMoney, traceTicks } from '../lib/format'
import { display } from '../state/display'
import { useCtx, useUi } from '../state/store'
import { Button, Icon, IconButton, Segmented, Window } from '../ui'
import { Badge } from '@/components/ui/badge'

// The hatches (bg-hatch-wait, bg-hatch-approval) are tokens in src/index.css. The approval one's stripes are a faint
// warning color on nothing.
// icon, bar classes
const KINDS: Record<TraceStepKind, [string, string]> = {
  root: ['hub', 'h-4 bg-chart-3'],
  model: ['neurology', 'h-4 bg-foreground-3'],
  tool: ['build', 'h-4 bg-chart-4'],
  agent: ['account_tree', 'h-4 bg-brand'],
  wait: ['hourglass_empty', 'h-3.5 bg-hatch-wait'],
  handoff: ['swap_horiz', 'h-0.5 border-t-2 border-dotted border-muted-foreground'],
  answer: ['chat_bubble', 'h-4 bg-foreground'],
  fail: ['error', 'h-4 bg-destructive'],
  approval: ['front_hand', 'h-3.5 bg-hatch-approval'],
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
/** What kind of step it is, in words, for the phone list (its tile's colour and icon say it to the eye). */
const KIND_LABEL: Record<TraceStepKind, string> = {
  root: 'All steps', model: 'Thinking', tool: 'Using a tool', agent: 'Helper', wait: 'Waiting', handoff: 'Passed on',
  answer: 'Answer', fail: 'Failed', approval: 'Waits for approval',
}
const COL = 'grid-cols-trace'
const NEXT_SPEED: Record<number, number> = { 1: 2, 2: 5, 5: 1 }
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

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

function TraceSteps({ trace }: { trace: Trace }) {
  const close = useUi(s => s.closeOverlays)
  const phone = useUi(s => s.phone)
  const [tech, setTech] = useState(false)
  const [sel, setSel] = useState<number | null>(null)
  const [t, setT] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const tRef = useRef<number | null>(null)
  const put = (v: number | null) => { tRef.current = v; setT(v) }

  const { steps } = trace
  // Times here are ms from the start of the run: the run's length, each step's start and end, and the replay's `t`.
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

  const started = (s: { startMs: number }) => t == null || s.startMs <= t
  const d0 = display()
  const fmtDur = (ms: number) => fmtDuration(ms, d0)
  const ticks = traceTicks(D, d0).map(k => ({ label: k.label, left: `${(k.ms / M) * 100}%` }))
  // The slowest model, tool or agent step. A run that failed before any (a tool that couldn't sign in) has none.
  const slow = steps.filter(s => s.kind === 'model' || s.kind === 'tool' || s.kind === 'agent')
    .reduce<TraceStep | null>((a, s) => (!a || s.endMs - s.startMs > a.endMs - a.startMs ? s : a), null)
  const cnt = (k: TraceStepKind) => steps.filter(s => s.kind === k && started(s)).length
  const toolsUsed = new Set(steps.filter(s => s.kind === 'tool' && s.label.includes(' · ')).map(s => s.label.split(' · ')[0])).size
  const shown = fmtDur(t == null ? D : t)
  const stats: [string, string | number][] = tech
    ? [['Duration', shown], ['Cost', fmtMoney(trace.cost, d0, { cents: 'always' })], ['Tokens', trace.tokens], ['Model calls', cnt('model')], ['Tool calls', cnt('tool')], ['Errors', cnt('fail')]]
    : [['Time taken', shown], ['Cost', fmtMoney(trace.cost, d0, { cents: 'always' })], ['Tools used', toolsUsed], ['Steps', steps.length - 1], ['Waits', cnt('wait') + cnt('approval')], ['Problems', cnt('fail')]]

  const plainIo = (s: (typeof steps)[number]) => s.kind === 'model'
    ? cap1(s.detail.split(' · ').slice(1).join(' · ') || 'It worked this out itself, without reading a tool')
    : s.detail.replace('Input: ', 'Asked for: ').replace('Output: ', 'Got back: ')
  const picked = sel != null ? steps[sel] : null
  const pickedDur = picked ? fmtDur(picked.endMs - picked.startMs) : ''

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
          <div key={a} className={`border-l py-3 ${phone ? 'px-4' : 'px-5'} ${i === 0 ? 'border-transparent' : 'border-divider'}`}>
            <div className="text-sm text-muted-foreground">{a}</div>
            <div className="mt-0.5 text-2xl tracking-stat tabular-nums">{b}</div>
          </div>
        ))}
      </div>

      {phone ? (
        // A list for screen readers too (Safari drops it without the role), each step at its depth.
        <div className="relative flex min-h-0 flex-1 flex-col">
        <ol role="list" aria-label="Steps" className="min-h-0 flex-1 overflow-auto">
          {steps.map((s, i) => {
            const vis = started(s)
            const endT = t == null ? s.endMs : Math.min(s.endMs, t)
            const running = t != null && s.startMs <= t && t < s.endMs
            const ifg = !vis ? 'text-muted-foreground' : s.kind === 'agent' ? 'text-brand' : s.kind === 'fail' ? 'text-destructive' : s.kind === 'approval' ? 'text-warning-text' : 'text-foreground-2'
            const dur = s.kind === 'approval' ? 'Waits for a person' : s.kind === 'fail' ? 'Failed after ' + fmtDur(Math.max(0, endT - s.startMs)) : fmtDur(Math.max(0, endT - s.startMs))
            return (
              <li key={i} aria-level={s.depth + 1} className="border-b border-divider">
                <button type="button" data-testid="trace-row" aria-pressed={sel === i} onClick={() => setSel(sel === i ? null : i)}
                  className={cn('flex w-full items-start gap-3 py-2.5 pr-4 text-left', sel === i ? 'bg-accent' : 'hover:bg-accent', !vis && 'text-muted-foreground')}
                  style={{ paddingLeft: 16 + s.depth * 16 }}>
                  <span aria-hidden="true" className={`flex size-7 flex-none items-center justify-center rounded-md border border-input ${ifg}`}><Icon name={KINDS[s.kind][0]} size={16} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="sr-only">{KIND_LABEL[s.kind]}: </span>
                    <span data-step-name className={cn('block text-base wrap-anywhere', s.kind === 'root' && 'font-semibold')}>{s.label}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground tabular-nums">
                      {running && <Icon name="progress_activity" size={15} />}
                      {vis ? dur : 'Not reached yet'}
                      {s === slow && t == null && <Badge variant="warning" size="lg">Slowest</Badge>}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        {/* The list scrolls under the footer: a fade at its foot says there is more, instead of a cut line. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-sheet-fade" />
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="relative">
          <div className={`grid ${COL} h-11 border-b border-divider text-sm text-muted-foreground`}>
            <div className="flex items-center gap-2 pl-5.5"><Icon name="account_tree" size={17} />Steps</div>
            <div className="relative">
              {ticks.map(k => <span key={k.label} className="absolute top-3.25 ml-1.5 tabular-nums" style={{ left: k.left }}>{k.label}</span>)}
            </div>
          </div>
          {steps.map((s, i) => {
            const k = KINDS[s.kind]
            const endT = t == null ? s.endMs : Math.min(s.endMs, t)
            const running = t != null && s.startMs <= t && t < s.endMs
            const vis = started(s)
            const dur = s.kind === 'approval' ? 'waits for a person'
              : s.kind === 'fail' ? 'failed after ' + fmtDur(Math.max(0, endT - s.startMs))
                : s.kind === 'root' && t == null ? fmtDur(s.endMs - s.startMs) + ' · ' + fmtMoney(trace.cost, d0, { cents: 'always' })
                  : fmtDur(Math.max(0, endT - s.startMs))
            // A step the replay hasn't reached yet is muted text, its tile too (never dimmed).
            const ifg = !vis ? 'text-muted-foreground' : s.kind === 'agent' ? 'text-brand' : s.kind === 'fail' ? 'text-destructive' : s.kind === 'approval' ? 'text-warning-text' : 'text-foreground-2'
            return (
              <button key={i} type="button" data-testid="trace-row" aria-pressed={sel === i} onClick={() => setSel(sel === i ? null : i)}
                className={`grid ${COL} h-11.5 w-full border-b border-divider text-left ${sel === i ? 'bg-accent' : 'bg-transparent hover:bg-accent'} ${vis ? '' : 'text-muted-foreground'}`}>
                <span className={`flex min-w-0 items-center gap-2.5 pr-3 text-base ${s.kind === 'root' ? 'font-semibold' : 'font-normal'}`} style={{ paddingLeft: 22 + s.depth * 26 }}>
                  <span aria-hidden="true" className={`flex size-7 flex-none items-center justify-center rounded-md border border-input ${ifg}`}><Icon name={k[0]} size={16} /></span>
                  {running && <Icon name="progress_activity" size={15} className="text-muted-foreground" />}
                  <span className="ellipsis">{s.label}</span>
                </span>
                <span className="relative">
                  {vis && (
                    <>
                      <i className={cn('absolute top-1/2 box-border min-w-0.75 -translate-y-1/2 rounded-sm', k[1])} style={{ left: `${(s.startMs / M) * 100}%`, width: `${Math.max(0, (endT - s.startMs) / M) * 100}%` }} />
                      <span className="absolute top-1/2 ml-2 flex -translate-y-1/2 items-center gap-2 text-sm whitespace-nowrap text-muted-foreground tabular-nums" style={{ left: `${(endT / M) * 100}%` }}>
                        {dur}
                        {s === slow && t == null && <Badge variant="warning" size="lg">Slowest</Badge>}
                      </span>
                    </>
                  )}
                </span>
              </button>
            )
          })}
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

      {picked && (
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 border-t border-divider bg-muted px-6 py-3 text-sm">
          <b className="font-semibold">{picked.label}</b>
          <span className="min-w-0 wrap-anywhere text-foreground-3">
            {tech ? `${picked.detail} · kind: ${picked.kind} · ${pickedDur}` : plainIo(picked) + (picked.kind === 'approval' ? '' : ` · took ${pickedDur}`)}
          </span>
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
        {/* The legend reads the timeline's bars: a phone's list has none. */}
        {!phone && <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5 text-sm whitespace-nowrap text-foreground-2">
          {LEGEND.map(l => (
            <span key={l.label} className="flex items-center gap-1.75">
              <i aria-hidden="true" className={`w-5 ${l.className}`} />{l.label}
            </span>
          ))}
        </div>}
      </div>
    </Window>
  )
}
