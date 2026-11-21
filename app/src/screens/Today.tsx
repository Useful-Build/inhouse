// Today: greeting, composer, then the problem cards (or the first-day and loading states).
import { Fragment } from 'react'
import { Composer } from '../components/Composer'
import { amountOf, draftView, flags, handled, issueCards, kindIcon, pendingIds, riskLabel, setupRows, todayCopy, TONE_TEXT } from '../state/derive'
import { isUrgent } from '../ui/severity'
import { fmtMoney } from '../lib/format'
import { display } from '../state/display'
import { useCtx, useUi } from '../state/store'
import { Skeleton } from '@/components/ui/skeleton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { AgentMark, Button, CardGrid, EmptyState, Icon, IconButton, LogoTile, MenuItem, SectionHeader } from '../ui'
import { Select, TAP } from '../ui/fields'

const SORT_AMOUNT = 'Biggest amount first'
const SKELETON_WIDTHS = ['w-39/50', 'w-16/25', 'w-43/50', 'w-7/10', 'w-29/50', 'w-41/50'] // 78, 64, 86, 70, 58 and 82%

export function Today() {
  const ctx = useCtx()
  const phone = useUi(s => s.phone)
  const { go, openProblem, approve, undoHandled, ask, openTeam, openTool, setAside } = useUi.getState()
  const tap = phone ? TAP : undefined
  const f = flags(ctx)
  const copy = todayCopy(ctx)
  const todaySort = useUi(s => s.todaySort)
  const byAmount = todaySort === 'amount' && !phone
  const cards = issueCards(ctx)
  // Handled cards stay after the ones that need the person, in every sort.
  if (byAmount) cards.sort((a, b) => Number(a.handled) - Number(b.handled) || amountOf(b.problem) - amountOf(a.problem))
  const h = handled(ctx)
  const setup = setupRows(ctx.data)
  // The first tool the agent doesn't have yet: the one Today waits for.
  const next = setup.find(s => !ctx.data.tools.connected.includes(s.key))
  // The header follows the state: what needs you, or how the day ended.
  const settled = ctx.S >= 1 && pendingIds(ctx).length === 0
  const allApproved = settled && cards.length > 0 && cards.length === ctx.data.problems.length && cards.every(c => ctx.agent.approved[c.problem.id])
  const headTitle = !settled ? 'Needs you' : allApproved ? 'All approved' : 'Nothing waiting'

  return (
    <div className="relative mx-auto box-border max-w-page-wide px-(--app-pad-x) pt-today-top pb-14">
      <div className="flex flex-col items-center text-center">
        <h1 className="rounded-3xl bg-background px-3.5 text-hero leading-hero font-medium tracking-title text-pretty shadow-page-xl">
          {copy.greeting}<span className="block text-muted-foreground">{copy.headline}</span>
        </h1>
        <div className="mt-6.5 flex w-full justify-center">
          <Composer variant="today" showToolsLabel={!phone} />
        </div>
      </div>

      {f.isFirst && (
        <div className="mx-auto mt-7 max-w-today-column">
          <SectionHeader onDots title="Getting your Inhouse agent ready" count={`${ctx.data.tools.connected.length} of ${setup.length} tools connected`} className="mb-3"
            actions={<button type="button" className={cn('on-page text-sm font-strong whitespace-nowrap text-foreground transition-colors hover:text-foreground-3', tap)} onClick={() => openTeam('tool')}>Message the team →</button>} />
          <div className="rounded-2xl border border-border bg-card px-4.5 py-0.5">
            {setup.map((s, i) => (
              <button key={s.key} type="button" data-setup-row={s.key} onClick={() => openTool(s.key)} className={`flex min-h-13.25 w-full items-center gap-3 border-t text-left text-base ${i === 0 ? 'border-transparent' : 'border-divider'}`}>
                <LogoTile k={s.key} size="md" />
                <span className="min-w-0 flex-1 font-medium">{s.name}</span>
                <span className="flex items-center gap-1.5 text-sm whitespace-nowrap text-foreground-3">
                  <i className={`size-1.5 rounded-full ${s.key === next?.key ? 'bg-warning' : 'bg-fill-strong'}`} />{s.when}
                </span>
                <Icon name="chevron_right" size={18} className="text-faint" />
              </button>
            ))}
          </div>
          <p className="on-page mx-1 mt-3 mb-0 text-sm text-pretty text-muted-foreground shadow-page-md">
            Today fills in the day after {next?.name ?? 'your first tool'} is connected. Until then your Inhouse agent has nothing to read, so it won't guess.
          </p>
        </div>
      )}

      {f.isLoading && (
        <div className="mt-7">
          <SectionHeader onDots icon={<AgentMark />} title="Reading your tools" count={`${ctx.data.tools.readDone} of ${ctx.data.tools.connected.length} done`} className="mb-3" />
          <CardGrid size="wide" aria-hidden="true">
            {SKELETON_WIDTHS.map(w => (
              <div key={w} className="box-border flex min-h-47.5 flex-col gap-2.5 rounded-2xl border border-border bg-card p-4.5">
                <Skeleton className="h-2.5 w-18 animate-none rounded-sm" />
                <Skeleton className={`h-3.5 animate-none rounded-sm bg-fill-hover ${w}`} />
                <Skeleton className="h-2.5 w-31/50 animate-none rounded-sm" />
                <div className="flex-1" />
                <Skeleton className="h-4.5 w-21 animate-none rounded-sm bg-fill-hover" />
              </div>
            ))}
          </CardGrid>
        </div>
      )}

      {!f.noData && (
        <div className="mt-7">
          <SectionHeader onDots title={headTitle} count={allApproved ? undefined : copy.countLabel} className="mb-3"
            actions={phone || settled ? undefined : (
              <Select label="Sort cards" value={byAmount ? SORT_AMOUNT : copy.sortLabel} options={[copy.sortLabel, SORT_AMOUNT]} minWidth={0}
                onChange={v => useUi.getState().patch({ todaySort: v === SORT_AMOUNT ? 'amount' : 'default' })}
                className={cn('rounded-lg border-transparent bg-transparent pr-1.5 pl-2.5 text-sm text-foreground-3 data-[size=default]:h-7.5', tap)} />
            )} />

          {ctx.S === 2 && (
            <button type="button" onClick={() => go('activity')}
              className={`mb-3 box-border flex w-full items-center rounded-xl bg-brand-tint px-4 py-3 text-sm text-brand-text transition-colors hover:bg-brand/12 ${phone ? 'flex-wrap gap-x-3 gap-y-1.5' : 'flex-nowrap gap-3'}`}>
              <Icon name="check_circle" size={18} weight={400} />
              <b className="font-semibold whitespace-nowrap">{h.count} handled before you woke up</b>
              {/* On a phone the list gets its own full-width lines under the title. */}
              <span className={`min-w-0 text-left text-brand-text ${phone ? 'order-3 grow basis-full' : 'ellipsis flex-1'}`}>{phone ? h.summary.split(' · ').map((item, i, all) => <Fragment key={item}><span className="whitespace-nowrap">{item}{i < all.length - 1 && ' ·'}</span>{' '}</Fragment>) : h.summary}</span>
              <span className={`font-semibold whitespace-nowrap ${phone ? 'order-2 ml-auto' : ''}`}>See activity</span>
            </button>
          )}

          {cards.length === 0 && <EmptyState>Every card is set aside for today. Activity lists them, each with Undo.</EmptyState>}
          <CardGrid size="wide">
            {cards.map(c => {
              const p = c.problem
              const dv = draftView(ctx, p.id)
              // Handled and approved cards are muted with the done token, never dimmed with opacity.
              const done = c.dimmed ? 'text-done' : ''
              const open = () => openProblem(p.id)
              const askAbout = () => void ask('Tell me more about: ' + p.title)
              // Snooze and dismiss are for cards that still need the person, not ones approved or handled.
              const needsYou = !c.handled && !ctx.agent.approved[p.id]
              // A draft waiting on the person gets the agent's sheet; approved, handled and Watch cards keep the status line.
              const waiting = c.primary !== null || c.quiet === 'Review'
              const low = c.primary === 'Approve'
              const risk = low ? null : riskLabel(dv)
              return (
                // The title is the card's one link: its ::after stretches over the card, and the card's other buttons sit above it.
                <article key={p.id} className="today-card relative flex cursor-pointer flex-col rounded-2xl bg-card shadow-card transition focus-within:shadow-float hover:shadow-float" aria-label={p.title}>
                  <div className="flex flex-1 flex-col pt-4 pr-4 pl-5.5">
                    <div className="flex min-h-7 items-center gap-2">
                      {!c.dimmed && isUrgent(p.sev) && <Badge variant="destructive" size="lg">Urgent</Badge>}
                      <span className={cn('flex-1 text-sm font-medium text-foreground-3', done)}>{p.area}</span>
                      {p.logos.length > 0 && (
                        <span className="mr-1 flex flex-none">
                          {p.logos.map(l => <LogoTile key={l} k={l} size="sm" round className="-mr-1.25 last:mr-0" />)}
                        </span>
                      )}
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <IconButton icon="more_horiz" label={`More actions for ${p.title}`} size={18} variant={c.dimmed ? 'ghost' : 'card'} box="icon-sm" className={cn('relative z-raised -my-1.5 -mr-1', c.dimmed && done, tap)} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" collisionPadding={16} aria-label="Card actions" aria-labelledby={undefined} className="w-menu-message max-w-screen-gutter border-input">
                          <MenuItem onSelect={askAbout}>
                            <Icon name="chat_bubble" size={18} /><span className="flex-1">Ask about this</span>
                          </MenuItem>
                          {needsYou && <>
                            <MenuItem onSelect={() => setAside(p.id, 'snoozed')}>
                              <Icon name="snooze" size={18} /><span className="flex-1">Snooze until tomorrow</span>
                            </MenuItem>
                            <MenuItem onSelect={() => setAside(p.id, 'dismissed')}>
                              <Icon name="do_not_disturb_on" size={18} /><span className="flex-1">Not a problem</span>
                            </MenuItem>
                          </>}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <button type="button" onClick={open}
                      className={`mt-3 mr-1.5 block cursor-pointer rounded-xs text-left text-xl leading-snug font-semibold tracking-card after:absolute after:inset-0 after:rounded-2xl ${done}`}>{p.title}</button>
                    <div className="mt-1.5 mr-1.5 text-base text-foreground-3">{p.sub}</div>
                    {/* The space sits above the amount, so amounts and bottom blocks line up across a row. */}
                    <div className="min-h-3.5 flex-1" />
                    <div className={`flex flex-wrap items-baseline gap-x-2 pb-4 ${done}`}>
                      <span className="text-2xl leading-none font-semibold tracking-stat tabular-nums">{fmtMoney(p.cost, display())}</span>
                      <span className="text-sm text-pretty text-muted-foreground">{p.costNote}</span>
                    </div>
                  </div>
                  {waiting ? (
                    // The agent's drafted fix, on its faint brand tint: in this app the brand means "your agent".
                    <div className="mx-2 mb-2 flex flex-col rounded-xl bg-draft-sheet p-3.5">
                      <div className="flex min-h-5.5 items-center gap-2 text-sm text-muted-foreground">
                        <span className="flex size-5.5 flex-none items-center justify-center rounded-md border border-border bg-draft-kind text-foreground-3">
                          <Icon name={kindIcon(dv.kind)} size={14} weight={400} />
                        </span>
                        <span className="min-w-0 flex-1">Draft · {dv.kind}</span>
                        {risk && <span className="font-semibold text-warning-text tabular-nums">{risk}</span>}
                      </div>
                      <div className="mt-2.5 text-base font-medium text-foreground-2">{dv.draftTitle}</div>
                      {dv.summary && <p className="m-0 mt-0.5 text-sm text-pretty text-muted-foreground">{dv.summary}</p>}
                      {/* Run: what the agent already did, or that a person undid its job. */}
                      {c.sheetNote && (
                        <div className={cn('mt-2 flex items-start gap-1.5 text-sm', TONE_TEXT[c.tone])}>
                          <Icon name={c.statusIcon} size={15} weight={400} className="mt-px" />
                          <span className="min-w-0 flex-1 text-pretty">{c.sheetNote}</span>
                        </div>
                      )}
                      <Button className={cn('relative z-raised mt-3 whitespace-nowrap', phone ? 'w-full' : 'self-start', tap)} onClick={low ? () => approve(p.id) : open}>
                        {low ? <><Icon name="check" size={16} />{dv.cta}</> : <>Review draft<Icon name="arrow_forward" size={16} /></>}
                      </Button>
                    </div>
                  ) : (
                    <div className="mx-2 mb-2 flex flex-col gap-3 rounded-xl bg-muted p-3.5">
                      {/* Two lines tall on desktop, so every status block in a grid row lines up whether the status wraps or not. */}
                      <div className={cn('flex items-start gap-1.5 text-sm', !phone && 'min-h-today-status', c.dimmed ? done : TONE_TEXT[c.tone])}>
                        <Icon name={c.statusIcon} size={15} weight={400} className="mt-px" />
                        <span className="min-w-0 flex-1 text-pretty">{c.status}</span>
                      </div>
                      {c.quiet && (
                        <Button variant="secondary" className={cn('relative z-raised self-start', tap)} onClick={c.quiet === 'Ask about this' ? askAbout : c.quiet === 'Undo' ? () => undoHandled(p.id) : open}>{c.quiet}</Button>
                      )}
                    </div>
                  )}
                </article>
              )
            })}
          </CardGrid>
        </div>
      )}
    </div>
  )
}
