// Usage: spend against the cap, daily bars, totals and breakdown.
import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { capStatus } from '../state/derive'
import { DEMO_START, fmtCount } from '../agent/clock'
import { useCtx, useUi } from '../state/store'
import type { UsageTab } from '../state/store'
import { AgentMark, Avatar, CardGrid, EmptyState, Page, PageHeader, Segmented } from '../ui'
import { Select, TAP } from '../ui/fields'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const TABS: [UsageTab, string][] = [['person', 'Person'], ['job', 'Job'], ['model', 'Model'], ['tool', 'Tool']]
const COL: Record<UsageTab, string> = { person: 'Person', job: 'Job', model: 'Model', tool: 'Tool read' }
const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** A person's avatar on the Person tab; the agent's own row wears the agent's mark. */
function RowMark({ who }: { who: string }) {
  if (who.startsWith('Inhouse agent')) return <span aria-hidden="true" className="flex size-7.5 flex-none items-center justify-center rounded-full bg-fill"><AgentMark /></span>
  return <Avatar who={who} size={30} fontSize={11} />
}

export function Usage() {
  const ctx = useCtx()
  const { usageMonths } = ctx.data
  const monthIdx = useUi(s => s.usageMonth)
  const month = usageMonths[monthIdx] ?? usageMonths[0]
  const thisMonth = month === usageMonths[0]
  // The cap and alert level saved in Settings (Spending cap) apply to this month only. Finished months keep the ones
  // recorded for them. A cap never changes what was spent: only "reached" compares the two.
  const status = capStatus(ctx)
  const usage = thisMonth ? { ...month, cap: status.cap, alertAt: status.alertAt } : month
  // Every month listed is in the demo's year.
  const monthLabels = usageMonths.map(m => `${m.month} ${DEMO_START.getFullYear()}`)
  const mon = usage.month.slice(0, 3)
  const cap = thisMonth && status.reached
  const tab = useUi(s => s.usageTab)
  const patch = useUi(s => s.patch)
  const phone = useUi(s => s.phone)
  // The daily bars are one tab stop: arrows move between days, Home and End jump to the ends.
  const [barAt, setBarAt] = useState(0)
  const bars = useRef<(HTMLDivElement | null)[]>([])

  const days = usage.daily
  const total = usage.total
  const maxD = Math.max(...days)
  // A day's bar as a share of the peak day. A month with nothing spent yet (day one) draws every bar flat.
  const barHeight = (v: number) => (maxD > 0 ? Math.round(v / maxD * 100) : 0) + '%'
  const dayLabel = (i: number) => `${mon} ${i + 1}`
  const bar = Math.min(barAt, days.length - 1)
  const barKey = (e: KeyboardEvent, i: number) => {
    const last = days.length - 1
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: last }[e.key]
    if (to === undefined) return
    e.preventDefault()
    const t = Math.max(0, Math.min(last, to))
    setBarAt(t)
    bars.current[t]?.focus()
  }
  const peakAt = days.indexOf(maxD) + 1
  const pct = Math.min(100, Math.round(total / usage.cap * 100)) + '%'
  const over = usage.total > usage.cap
  const hint = !thisMonth
    ? over ? `Went over your $${fmtCount(usage.cap)} cap` : `Finished under your $${fmtCount(usage.cap)} cap`
    : cap
      ? `Cap reached with ${30 - days.length} days of the month left`
      : `On track for about $${fmtCount(Math.round(total / days.length * 30))} this month, ${total / days.length * 30 > usage.cap ? 'over' : 'under'} your cap`
  const capNote = !thisMonth
    ? over ? `Closed at ${Math.round(total / usage.cap * 100)}% of the cap.` : `Closed at ${pct} of the cap. Nothing was paused.`
    : cap
      ? 'Cap reached today. Routines and jobs are paused until an admin raises it.'
      : `Admins get an email at ${usage.alertAt}%. Your Inhouse agent pauses routines and jobs at the cap.`
  // A channel counts only from its stage (Act) and once connected: before that, questions come from chats alone, so a
  // row shows its plain `sub`. Once one is, rows that name it show `subWithChannel` with the channel's name.
  const channel = ctx.data.tools.channels.find(c => ctx.S >= c.need)
  const rows = usage.breakdown[tab].map(r => (channel && r.subWithChannel ? { ...r, sub: r.subWithChannel.replace('{channel}', channel.name) } : r))
  const stats: [string, string][] = [
    ['Conversations', fmtCount(usage.conversations)],
    ['Questions asked', fmtCount(usage.questionsAsked)],
    ['Jobs run', fmtCount(usage.jobsRun)],
    // No conversations yet (day one): nothing was spent on one.
    ['Cost per conversation', money(usage.conversations ? total / usage.conversations : 0)],
  ]
  const card = 'rounded-2xl border border-border bg-card'

  return (
    <Page width="wide">
      <PageHeader title="Usage" description="What your Inhouse agent cost to run. AI and hosting are billed at cost, to your own accounts."
        // A picker with one month offers no choice: it shows from two months on.
        actions={monthLabels.length > 1 && (
          <Select label="Month" value={monthLabels[monthIdx] ?? monthLabels[0]} options={monthLabels} minWidth={0} className={cn('text-sm data-[size=default]:h-9', phone && TAP)}
            onChange={v => patch({ usageMonth: monthLabels.indexOf(v) })} />
        )} />

      <CardGrid size="lg" className="mt-7">
        <div className={`${card} px-6 py-5.5`}>
          <div className="text-sm text-muted-foreground">{thisMonth ? 'Spent this month' : `Spent in ${usage.month}`}</div>
          <div className="mt-1.5 text-display leading-figure font-semibold tracking-display tabular-nums">{money(total)}</div>
          <div className="mt-1.5 text-sm text-muted-foreground">{hint}</div>
          <div className="mt-5.5 flex justify-between gap-3 text-sm">
            <span className="font-strong whitespace-nowrap">Spending cap</span>
            <span className="whitespace-nowrap text-muted-foreground">{money(total)} of ${fmtCount(usage.cap)}</span>
          </div>
          <div role="progressbar" aria-label="Spending cap used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={parseInt(pct)} className="mt-2 h-2 overflow-hidden rounded-full bg-fill">
            <i className={`block h-full rounded-full ${cap || over ? 'bg-destructive' : 'bg-chart-2'}`} style={{ width: pct }} />
          </div>
          <div className="mt-2 text-xs text-muted-foreground">{capNote}</div>
        </div>
        <div className={`${card} flex flex-col px-6 pt-5.5 pb-4`}>
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-base font-semibold">
            Daily cost<span className="text-sm font-normal text-muted-foreground">{maxD > 0 ? `Peak ${money(maxD)} on ${dayLabel(peakAt - 1)}` : 'Nothing spent yet'}</span>
          </div>
          {/* Each bar shows its day and cost in a tooltip, on hover or from the keyboard (one tab stop, then the arrow keys).
              A one-row grid, so each focusable day is a cell (a focusable image isn't a control). */}
          <div role="grid" aria-label="Daily cost" aria-readonly="true" className="mt-4 flex min-h-37.5 flex-1 border-b border-divider">
            <div role="row" className="flex flex-1 items-end gap-1.5">
            {days.map((v, i) => (
              <Tooltip key={i}>
                <TooltipTrigger asChild>
                  <div role="gridcell" ref={el => { bars.current[i] = el }} tabIndex={i === bar ? 0 : -1} onKeyDown={e => barKey(e, i)} onFocus={() => setBarAt(i)} aria-label={`${dayLabel(i)}: ${money(v)}`} data-usage-bar
                    // A $0 day (Nov 1, before the first tool was connected) keeps a tick on the baseline, so no slot reads as missing.
                    className={`min-h-bar-tick flex-1 rounded-t-bar rounded-b-xs ${thisMonth && i === days.length - 1 ? 'bg-chart-2' : 'bg-chart-4'}`} style={{ height: barHeight(v) }} />
                </TooltipTrigger>
                <TooltipContent>{`${dayLabel(i)}: ${money(v)}`}</TooltipContent>
              </Tooltip>
            ))}
            </div>
          </div>
          <div className="mt-2 flex justify-between font-mono text-xs font-medium text-muted-foreground">
            <span>{dayLabel(0).toUpperCase()}</span><span>{dayLabel(7).toUpperCase()}</span><span>{dayLabel(days.length - 1).toUpperCase()}</span>
          </div>
        </div>
      </CardGrid>

      <div className="mt-7.5 grid grid-cols-usage-totals gap-5">
        {stats.map(([a, b]) => (
          <div key={a}>
            <div className="text-sm text-muted-foreground">{a}</div>
            <div className="mt-1 text-2xl font-medium tracking-stat tabular-nums">{b}</div>
          </div>
        ))}
      </div>

      <div className="mt-9 flex flex-wrap items-center gap-3">
        <h2 className="flex-1 text-xl font-semibold tracking-section">Breakdown</h2>
        <Segmented label="Break down by" value={tab} options={TABS} onChange={v => patch({ usageTab: v })} />
      </div>
      {rows.length === 0 ? (
        <EmptyState className="mt-3">{ctx.data.status === 'loading' ? 'Still reading your tools. Costs show here once your Inhouse agent has worked.' : 'Nothing spent yet. Costs show here once your Inhouse agent starts working.'}</EmptyState>
      ) : phone ? (
        <div className="mt-3 border-t border-border">
          {rows.map(r => {
            const cost = r.dollars
            const share = Math.round(cost / total * 100) + '%'
            return (
              <div key={r.name} className="flex items-start gap-3 border-b border-border py-3 text-base tabular-nums" data-usage-row data-cost={cost.toFixed(2)} data-conv={r.conversations}>
                {tab === 'person' && <span className="inline-flex"><RowMark who={r.name} /></span>}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-muted-foreground">{r.sub}</div>
                  <div className="mt-2 flex items-center gap-2.5">
                    <span className="font-strong">{money(cost)}</span>
                    <span className="h-1.25 min-w-0 flex-1 overflow-hidden rounded-full bg-fill-hover">
                      <i className="block h-full bg-chart-2" style={{ width: share }} />
                    </span>
                    <span className="w-10 text-right">{share}<span className="sr-only"> of total</span></span>
                  </div>
                  <div className="mt-1 text-sm text-foreground-2">{fmtCount(r.conversations)} {r.conversations === 1 ? 'conversation' : 'conversations'}</div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
      <div className="mt-3 overflow-x-auto">
        <div className="min-w-140">
          <div className="flex border-b border-border pb-2 text-sm text-muted-foreground">
            <span className="flex-1">{COL[tab]}</span>
            <span className="w-27.5 text-right">Cost</span>
            <span className="w-40 text-right">Share</span>
            <span className="w-30 text-right">Conversations</span>
          </div>
          {rows.map(r => {
            const cost = r.dollars
            const share = Math.round(cost / total * 100) + '%'
            return (
              <div key={r.name} className="flex min-h-13.5 items-center border-b border-border text-base tabular-nums" data-usage-row data-cost={cost.toFixed(2)} data-conv={r.conversations}>
                {tab === 'person' && <span className="mr-3 inline-flex"><RowMark who={r.name} /></span>}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{r.name}</span>
                  <span className="text-xs text-muted-foreground">{r.sub}</span>
                </span>
                <span className="w-27.5 text-right font-strong">{money(cost)}</span>
                <span className="flex w-40 items-center justify-end gap-2.5">
                  <span className="h-1.25 w-17.5 overflow-hidden rounded-full bg-fill-hover">
                    <i className="block h-full bg-chart-2" style={{ width: share }} />
                  </span>
                  <span className="w-10 text-right">{share}</span>
                </span>
                <span className="w-30 text-right text-foreground-2">{fmtCount(r.conversations)}</span>
              </div>
            )
          })}
        </div>
      </div>
      )}
    </Page>
  )
}
