import { useState } from 'react'
import { agent } from '../agent'
import { plainSpaces } from '../agent/clock'
import { activityRows, groupByDay, memberFor, userName } from '../state/derive'
import type { ActivityRow } from '../state/derive'
import type { ActivityFilter } from '../state/store'
import { useCtx, useUi } from '../state/store'
import { cn } from '@/lib/utils'
import { Avatar, Button, DetailList, EmptyState, Icon, Page, PageHeader, SectionHeader, Segmented } from '../ui'
import { SearchBox, TAP } from '../ui/fields'

const TABS: [ActivityFilter, string][] = [['all', 'All'], ['change', 'Changes'], ['needs', 'Waiting on you'], ['problem', 'Problems']]

export function Activity() {
  const ctx = useCtx()
  const { S } = ctx
  const filter = useUi(s => s.actFilter)
  const open = useUi(s => s.actOpen)
  const phone = useUi(s => s.phone)
  const patch = useUi(s => s.patch)
  const openProblem = useUi(s => s.openProblem)
  const openTrace = useUi(s => s.openTrace)
  const unapprove = useUi(s => s.unapprove)
  const undoHandled = useUi(s => s.undoHandled)
  const tap = phone ? TAP : undefined
  const undo = ({ type, id }: NonNullable<ActivityRow['undo']>) =>
    type === 'approval' ? unapprove(id) : type === 'handled' ? undoHandled(id) : agent.setAside(id, null)
  const [query, setQuery] = useState('')
  // Both sides with plain spaces: a time typed as "6:04 AM" finds one written with a no-break space.
  const needle = plainSpaces(query.trim().toLowerCase())

  // The list is short (under 20 lines, even with every problem set aside), so it shows whole, with no paging.
  const rows = activityRows(ctx).filter(r => (filter === 'all' || r.kind === filter) && (!needle || plainSpaces(`${r.text} ${r.who} ${r.why} ${r.result}`.toLowerCase()).includes(needle)))
  const days = groupByDay(rows)
  const empty = {
    all: ctx.data.status === 'loading' ? 'Still reading your tools. What your Inhouse agent does shows here.' : 'Nothing yet. Lines show here once your Inhouse agent starts working.',
    change: S === 0 ? 'Nothing was changed. In Watch, your Inhouse agent only reads.' : 'Nothing has been changed yet.',
    needs: S === 0 ? 'Nothing waits for approval in Watch. Today lists what needs you.' : 'Nothing is waiting on you.',
    problem: 'No problems. Every tool was read and every job finished.',
  }[filter]

  return (
    <Page>
      <PageHeader title="Activity" description="What your Inhouse agent did, and what it left for a person. Open a line for the short version." />
      <div className="mt-5.5 flex flex-wrap items-center gap-2.5">
        <SearchBox value={query} onChange={setQuery} placeholder="Search activity" label="Search activity" className="basis-55" />
        <Segmented label="Filter activity" value={filter} options={TABS} onChange={v => patch({ actFilter: v, actOpen: null })} />
      </div>
      {days.length === 0 && (needle
        ? <EmptyState variant="inline" className="mt-7">No lines match "{query.trim()}".</EmptyState>
        : <EmptyState className="mt-7">{empty}</EmptyState>)}
      {days.map(day => (
        <section key={day.label}>
          <SectionHeader title={day.label} count={`${day.rows.length} ${day.rows.length === 1 ? 'line' : 'lines'}`} className="mt-6.5 mb-2.5" />
          <div className="rounded-2xl border border-border bg-card px-5 py-1">
            {day.rows.map((r, i) => {
              const isOpen = open === r.key
              const tr = isOpen && r.trace ? agent.getTrace(r.trace) : null
              const facts: [string, string][] = [['Why', r.why], ['What happened', r.result], ['Who', r.by], ...(r.fix ? [['To fix', r.fix] as [string, string]] : [])]
              return (
                <div key={r.key} className={i === 0 ? '' : 'border-t border-divider'}>
                  <button type="button" data-activity-row className="-mx-2.5 box-border flex min-h-13 w-full items-center gap-3.5 rounded-lg px-2.5 py-1.5 text-left text-base transition-colors hover:bg-accent" aria-expanded={isOpen} onClick={() => patch({ actOpen: isOpen ? null : r.key })}>
                    {!phone && <span className="w-time-column flex-none font-mono text-xs font-medium whitespace-nowrap text-muted-foreground">{r.t}</span>}
                    <span aria-hidden="true" className={`flex size-7.5 flex-none items-center justify-center rounded-md ${r.iconTone}`}>
                      <Icon name={r.icon} size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      {r.text}
                      {/* A phone has no room for the time and the person beside the line: they sit under it. */}
                      {phone && <span className="mt-0.5 block text-xs text-muted-foreground"><span className="font-mono whitespace-nowrap">{r.t}</span> · {r.who}</span>}
                    </span>
                    {!phone && <span className="inline-flex items-center gap-1.75 text-xs whitespace-nowrap text-muted-foreground">{memberFor(ctx.data, r.whoBy ?? r.who, userName(ctx)) && <Avatar who={r.whoBy ?? r.who} size={20} fontSize={9} />}{r.who}</span>}
                    <Icon name={isOpen ? 'expand_less' : 'expand_more'} size={18} className="text-muted-foreground" />
                  </button>
                  {isOpen && (
                    <div className={cn('mb-3.5 rounded-xl bg-muted px-4 py-3.5 text-sm leading-normal', !phone && 'ml-activity-indent')}>
                      <DetailList items={facts} />
                      <div className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-2">
                        {r.review && <Button className={tap} onClick={() => openProblem(r.review!)}>Review</Button>}
                        {r.undo && <Button variant="outline" className={tap} onClick={() => undo(r.undo!)}>Undo</Button>}
                        {r.trace && (
                          <Button variant="ghost" className={cn('gap-0.5 font-normal', tap)} onClick={() => openTrace(r.trace!)}>
                            See every step{tr && ` · ${tr.steps.length - 1} steps`}<Icon name="chevron_right" size={16} />
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </Page>
  )
}
