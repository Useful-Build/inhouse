import { useRef, useState } from 'react'
import { agent } from '../agent'
import { traceOf, useTraces } from './chat/traces'
import { plainSteps, sentence } from './activity/plain-steps'
import { ActionRows } from './activity/ActionRows'
import { keepUnitsTogether, plainSpaces } from '../agent/clock'
import { activityRows, groupByDay } from '../state/derive'
import type { ActivityKind, ActivityRow } from '../state/derive'
import type { ActivityFilter } from '../state/store'
import { useCtx, useUi } from '../state/store'
import { fmtDayGroup } from '../lib/format'
import { display, nowOf } from '../state/display'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { Button, EmptyState, Icon, IconButton, Page, PageHeader, SectionHeader, Segmented } from '../ui'
import { SearchBox, TAP } from '../ui/fields'
import { NO_MOTION } from '../ui/motion'
import { claimTrigger, keepForToast, rememberTrigger, restoreFocus } from '../ui/dialogs'

const TABS: [ActivityFilter, string][] = [['all', 'All'], ['needs', 'Needs you'], ['change', 'Changes']]

/** What the sheet's top line calls a row: only "Needs you" asks for anything, so only it stands out. */
const STATUS: Record<ActivityKind, string> = { needs: 'Needs you', problem: 'Needs a look', change: 'Done', read: 'Checked' }

type Undo = NonNullable<ActivityRow['undo']>
type Day = { label: string; rows: ActivityRow[] }

export function Activity() {
  useTraces()
  const ctx = useCtx()
  const { S } = ctx
  const filter = useUi(s => s.actFilter)
  // The open line's sheet. Kept in the page, so coming back to Activity doesn't open the last line again.
  const [open, setOpen] = useState<string | null>(null)
  const patch = useUi(s => s.patch)
  const [query, setQuery] = useState('')
  // Both sides with plain spaces: a time typed as "6:04 AM" finds one written with a no-break space.
  const needle = plainSpaces(query.trim().toLowerCase())

  // The list is short (under 20 lines, even with every problem set aside), so it shows whole, with no paging.
  const all = activityRows(ctx)
  const rows = all.filter(r => (filter === 'all' || r.kind === filter) && (!needle || plainSpaces(`${r.text} ${r.who} ${r.why} ${r.result}`.toLowerCase()).includes(needle)))
  // The day's group as All chats names it: "Today", "Yesterday", else the row's own date ("Fri, Nov 13").
  const now = nowOf(), d0 = display()
  const dayName = (r: ActivityRow) => (r.day === 'Today' ? r.day : fmtDayGroup(r.at, now, d0) === 'Yesterday' ? 'Yesterday' : r.day)
  const days: Day[] = groupByDay(rows).map(d => ({ label: dayName(d.rows[0]), rows: d.rows }))
  // The open row is looked up in every row, not just the shown ones, so a search typed behind the sheet doesn't close it.
  const openRow = open ? all.find(r => r.key === open) : undefined
  const empty = {
    all: ctx.data.status === 'loading' ? 'Still reading your tools. What your Inhouse agent does shows here.' : 'Nothing yet. Lines show here once your Inhouse agent starts working.',
    change: S === 0 ? 'Nothing was changed. In Watch, your Inhouse agent only reads.' : 'Nothing has been changed yet.',
    needs: S === 0 ? 'Nothing waits for approval in Watch. Today lists what needs you.' : 'Nothing needs you right now.',
  }[filter]

  return (
    <Page>
      <PageHeader title="Activity" className="mb-3.5" />
      <div className="flex flex-wrap items-center gap-2.5">
        <SearchBox value={query} onChange={setQuery} placeholder="Search activity" label="Search activity" className="grow basis-55" />
        <Segmented label="Filter activity" value={filter} options={TABS} onChange={v => { patch({ actFilter: v }); setOpen(null) }} />
      </div>
      {/* Stage 1 M2-H: the agent's actions (the demo's are its sample cards). Not "Needs you": Approvals answers those. */}
      {filter !== 'needs' && <ActionRows needle={needle} />}
      {days.length === 0 && (needle
        ? <EmptyState variant="inline" className="mt-7">No lines match "{query.trim()}".</EmptyState>
        : <EmptyState className="mt-6">{empty}</EmptyState>)}
      {days.map(day => (
        <section key={day.label} aria-label={day.label}>
          <SectionHeader title={day.label} className="mt-6 mb-2.5" />
          {/* The All chats card: a 2px gap, so two hovered rows next to each other stay two rows. */}
          <ul className="m-0 flex list-none flex-col gap-0.5 rounded-2xl border border-border bg-card px-2 py-1">
            {day.rows.map(r => (
              <li key={r.key}>
                <button type="button" data-activity-row aria-haspopup="dialog" onClick={() => setOpen(r.key)}
                  className={cn('flex min-h-13 w-full items-center gap-3.5 rounded-lg py-2 pr-3 pl-3 text-left transition-colors hover:bg-accent focus-visible:bg-accent',
                    open === r.key && 'bg-fill-hover hover:bg-fill-hover')}>
                  <Icon name="history" size={19} className="flex-none text-muted-foreground" />
                  <span className="min-w-0 flex-1 text-md text-pretty">{keepUnitsTogether(r.text)}</span>
                  {/* On the selected fill muted text falls under 4.5:1, so the open row's time steps up a level. */}
                  <span data-activity-time className={cn('flex-none text-sm whitespace-nowrap tabular-nums', open === r.key ? 'text-foreground-3' : 'text-muted-foreground')}>{r.t}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {openRow && <ActivitySheet row={openRow} day={dayName(openRow)} onClose={() => setOpen(null)} />}
    </Page>
  )
}

/** One line, opened: what happened in one paragraph, its one action, and the steps behind it on request. */
function ActivitySheet({ row: r, day, onClose }: { row: ActivityRow; day: string; onClose: () => void }) {
  useTraces()
  const phone = useUi(s => s.phone)
  const { openProblem, unapprove, undoHandled } = useUi.getState()
  const [stepsOpen, setStepsOpen] = useState(false)
  // Closing gives focus back to the row that opened the sheet, as Window does.
  const before = useRef<HTMLElement | null>(null)
  // It opens with focus on the sheet itself, so Close shows no focus ring or tooltip until someone tabs to it.
  const panel = useRef<HTMLDivElement>(null)
  const tap = phone ? TAP : undefined
  const trace = r.trace ? traceOf(r.trace) : null
  const steps = trace ? plainSteps(trace) : []
  const story = [r.why, r.result, r.by, r.fix ?? ''].map(sentence).filter(Boolean).join(' ')
  const undo = ({ type, id }: Undo) => {
    onClose()
    if (type === 'approval') unapprove(id)
    else if (type === 'handled') undoHandled(id)
    else void agent.setAside(id, null)
  }
  // The sheet and its button go away, so the review window gives focus back to the Activity row that opened the sheet
  // (after openProblem, which remembers what has focus now: this button).
  const review = (id: string) => { onClose(); openProblem(id); rememberTrigger(before.current) }

  return (
    <Sheet open onOpenChange={o => { if (!o) onClose() }}>
      <SheetContent ref={panel} side={phone ? 'bottom' : 'right'} showCloseButton={false} aria-describedby={undefined}
        onPointerDownOutside={keepForToast} onInteractOutside={keepForToast}
        overlayProps={{ className: NO_MOTION }}
        onOpenAutoFocus={e => { before.current = claimTrigger(); e.preventDefault(); panel.current?.focus() }}
        // Unless what the sheet opened (the review panel) has taken focus already.
        onCloseAutoFocus={e => { e.preventDefault(); if (document.activeElement === document.body) restoreFocus(before.current) }}
        data-surface="window"
        className={cn('gap-0 overflow-hidden rounded-2xl border bg-window-surface shadow-menu', NO_MOTION, phone ? 'inset-x-2.5 bottom-2.5 h-auto max-h-window-max w-auto' : 'inset-y-2.5 right-2.5 h-auto w-activity-panel sm:max-w-none')}>
        <div className="flex items-center gap-1.5 pt-3.5 pr-3.5 pl-6 text-sm">
          <span className={cn('font-medium', r.kind === 'needs' ? 'text-warning-text' : 'text-foreground-2')}>{STATUS[r.kind]}</span>
          <span className="text-muted-foreground">· {day}, {r.t}</span>
          <div className="flex-1" />
          <IconButton icon="close" label="Close" onClick={onClose} className={tap} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 pt-3 pb-6">
          <SheetTitle className="text-2xl leading-heading font-medium tracking-heading text-pretty">{keepUnitsTogether(r.text)}</SheetTitle>
          <p className="mt-3 text-base leading-prose text-foreground-2">{keepUnitsTogether(story)}</p>
          {(r.review || r.undo) && (
            <div className="mt-5 flex flex-wrap gap-2">
              {r.review
                ? <Button size="lg" className={tap} onClick={() => review(r.review!)}>Review the draft</Button>
                : <Button variant="outline" size="lg" className={tap} onClick={() => undo(r.undo!)}>Undo</Button>}
            </div>
          )}
          {steps.length > 0 && (
            <div className="mt-7 border-t border-divider pt-5">
              <Button variant="ghost" aria-expanded={stepsOpen} aria-controls="activity-steps" onClick={() => setStepsOpen(o => !o)}
                className={cn('-ml-2.5 gap-1 px-2.5 font-medium text-foreground', tap)}>
                How your agent worked it out<Icon name={stepsOpen ? 'expand_less' : 'expand_more'} size={18} className="text-muted-foreground" />
              </Button>
              {stepsOpen && (
                <ol id="activity-steps" className="m-0 mt-3 flex list-decimal flex-col gap-2 pl-5 text-base leading-normal text-foreground-2">
                  {steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
