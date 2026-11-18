import { amountOf, draftView, flags, lowRiskIds, memberFor, pendingIds, problemById, userName, visibleProblems } from '../state/derive'
import { sevClass } from '../ui/severity'
import { Skeleton } from '@/components/ui/skeleton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useCtx, useUi } from '../state/store'
import type { ApprovalSort } from '../state/store'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Avatar, Button, DetailList, Dot, EmptyState, Icon, IconButton, IconTile, MenuItem, Page, PageHeader, SectionHeader } from '../ui'
import { Select, TAP } from '../ui/fields'

const SORTS: [ApprovalSort, string][] = [['oldest', 'Oldest first'], ['newest', 'Newest first'], ['stake', 'Most at stake']]

export function Approvals() {
  const ctx = useCtx()
  const approve = useUi(s => s.approve)
  const unapprove = useUi(s => s.unapprove)
  const openProblem = useUi(s => s.openProblem)
  const openTeam = useUi(s => s.openTeam)
  const { approveMany, setAside, patch } = useUi.getState()
  const phone = useUi(s => s.phone)
  const sort = useUi(s => s.approvalSort)
  const tap = phone ? TAP : undefined
  const { S, agent } = ctx
  // Sorted on the minute of the day, never on the shown "6:02 AM". Drafts made at the same minute keep the agent's
  // order, whichever way time sorts.
  const draftedMin = (id: string) => problemById(ctx.data, id).draftedMin
  const byTime = (a: string, b: string) => draftedMin(a) - draftedMin(b)
  const pending = pendingIds(ctx).sort(sort === 'stake'
    ? (a, b) => amountOf(draftView(ctx, b).problem) - amountOf(draftView(ctx, a).problem)
    : sort === 'newest' ? (a, b) => byTime(b, a) : byTime)
  const lowRisk = lowRiskIds(ctx)
  // Edit always opens the panel with the draft in view: its text ready to change, or a note field when it has no text.
  const edit = (id: string) => {
    openProblem(id)
    patch({ editing: id })
  }
  const { noData, isFirst, isLoading } = flags(ctx)
  // Watch lists what Today shows: problems a person set aside aren't counted.
  const watchList = visibleProblems(ctx)
  const nProblems = watchList.length
  const approvedList = ctx.data.problems.filter(p => agent.approved[p.id]).map(p => draftView(ctx, p.id))

  const approveAll = lowRisk.length >= 2 && (
    <Button variant="outline" size="sm" className={tap} onClick={() => approveMany(lowRisk)}>
      <Icon name="done_all" size={16} />Approve all low-risk
    </Button>
  )
  const waitingActions = (
    <>
      {approveAll}
      <Select label="Sort drafts" value={SORTS.find(([k]) => k === sort)![1]} options={SORTS.map(([, l]) => l)} minWidth={0}
        onChange={v => patch({ approvalSort: SORTS.find(([, l]) => l === v)![0] })}
        className={cn('rounded-lg border-transparent bg-transparent pr-1.5 pl-2.5 text-sm text-foreground-3 data-[size=default]:h-7', tap)} />
    </>
  )

  return (
    <Page>
      <PageHeader title="Approvals" description="Work your Inhouse agent drafted. Nothing goes out until someone approves it." />

      {S === 0 && (
        <div data-watch-block className="mt-7 flex items-start gap-4 rounded-2xl border border-dashed border-border-strong p-7 text-foreground-3">
          <IconTile icon="task_alt" iconSize={20} size="lg" tone="outline" />
          <div className="min-w-0 flex-1">
            <div className="text-md font-semibold text-foreground">{noData || nProblems === 0 ? 'In Act, drafted fixes would be waiting here' : `In Act, today's ${nProblems} ${nProblems === 1 ? 'fix' : 'fixes'} would be waiting here`}</div>
            <div className="mt-1 max-w-140 text-base leading-prose">{noData || nProblems === 0 ? 'In Act, your Inhouse agent drafts a fix for each problem it finds. Nothing goes out until someone approves it, here or in Slack.' : 'Your Inhouse agent found these problems this morning. In Act it also drafts the fix for each one, and nothing goes out until someone approves it, here or in Slack.'}</div>
            {!noData && nProblems > 0 && <ul className="m-0 mt-3.5 list-none border-t border-border p-0">
              {watchList.map(p => (
                <li key={p.id} className="flex min-h-9.75 items-center gap-2.5 border-b border-border text-sm">
                  <Icon name="edit_note" size={16} />
                  <span className="min-w-0 flex-1 text-foreground-2">{p.draft.title}</span>
                  <span className="whitespace-nowrap text-muted-foreground tabular-nums">{p.cost}</span>
                </li>
              ))}
            </ul>}
            <Button variant="link" className="mt-3.5" onClick={() => openTeam('change', "We'd like to talk about moving to Act.")}>Talk to your Inhouse team about Act →</Button>
          </div>
        </div>
      )}

      {S >= 1 && (
        <>
          {/* On a phone the header keeps one line: no sort, only Approve all low-risk. */}
          <SectionHeader title="Waiting for you" count={noData ? undefined : pending.length} className="mt-7.5 mb-3"
            actions={noData ? undefined : phone ? approveAll || undefined : waitingActions} />
          {isFirst && <EmptyState>Nothing to approve yet. Drafts wait here once your tools are connected.</EmptyState>}
          {isLoading && (
            <div className="flex flex-col gap-3">
              <p role="status" className="sr-only">Reading your tools</p>
              {[0, 1].map(i => (
                <div key={i} aria-hidden="true" className="box-border flex flex-col gap-2.5 rounded-2xl border border-border bg-card p-4.5">
                  <Skeleton className="h-3.5 w-3/5 animate-none rounded-sm bg-fill-hover" />
                  <Skeleton className="h-2.5 w-4/5 animate-none rounded-sm" />
                  <Skeleton className="h-2.5 w-7/10 animate-none rounded-sm" />
                  <Skeleton className="mt-1.5 h-9.5 w-30 animate-none rounded-lg bg-fill-hover" />
                </div>
              ))}
            </div>
          )}
          {!noData && pending.length === 0 && <EmptyState>All caught up. New drafts will show up here.</EmptyState>}
          <div className="flex flex-col gap-3">
            {pending.map(id => {
              const dv = draftView(ctx, id)
              // Low risk (no money, no customers): one-tap Approve. Anything else: Review, which opens the panel.
              const low = lowRisk.includes(id)
              return (
                <Card key={id} className="gap-0 overflow-hidden rounded-2xl border-border py-0 shadow-card">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-divider px-4.5 py-3.5">
                    <Dot className={sevClass(dv.problem.sev)} />
                    <h2 className="min-w-40 flex-1 text-base font-semibold">{dv.draftTitle}</h2>
                    <Badge variant={low ? 'muted' : 'warning'}>{low ? 'Low risk' : dv.waitsLabel ?? 'Needs review'}</Badge>
                    <span className="text-xs text-muted-foreground">{dv.problem.area} · {dv.problem.draftedAt}</span>
                  </div>
                  <DetailList variant="ruled" strong items={dv.lines} className="px-4.5 py-1 text-sm" />
                  {dv.body && (
                    <div className="mx-4.5 mt-2.5 rounded-lg bg-dialog px-3.5 py-3 text-sm leading-prose text-foreground-2 wrap-anywhere">
                      <div className="mono-label mb-1.5 tracking-caps">{dv.bodyLabel}</div>
                      {dv.body}
                    </div>
                  )}
                  <p className="m-0 px-4.5 pt-3 text-xs text-muted-foreground">{dv.footNote}</p>
                  <div className="flex items-center gap-2 px-4.5 pt-3 pb-4">
                    <Button size="lg" className={tap} onClick={low ? () => approve(id) : () => openProblem(id)}>{low ? dv.cta : 'Review'}</Button>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <IconButton icon="more_horiz" label={`More actions for ${dv.draftTitle}`} size={18} box="icon-lg" className={tap} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" collisionPadding={16} aria-label="Draft actions" aria-labelledby={undefined} className="w-menu-message max-w-screen-gutter border-input">
                        {low && (
                          <MenuItem onSelect={() => openProblem(id)}>
                            <Icon name="visibility" size={18} /><span className="flex-1">Review</span>
                          </MenuItem>
                        )}
                        <MenuItem onSelect={() => edit(id)}>
                          <Icon name="edit" size={18} /><span className="flex-1">Edit</span>
                        </MenuItem>
                        <MenuItem onSelect={() => setAside(id, 'declined')}>
                          <Icon name="do_not_disturb_on" size={18} /><span className="flex-1">Don't send</span>
                        </MenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </Card>
              )
            })}
          </div>
          {approvedList.length > 0 && (
            <section aria-labelledby="approved-today">
              <SectionHeader id="approved-today" title="Approved today" className="mt-7.5 mb-2.5" />
              <Card className="gap-0 rounded-2xl border-border px-4.5 py-0.5 shadow-none">
                {approvedList.map(dv => (
                  // On a phone the text takes its own line and the time and Undo wrap under it.
                  <div key={dv.problem.id} className="flex min-h-14.75 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-divider py-2 text-sm">
                    <Icon name="check_circle" size={17} weight={400} className="text-foreground" />
                    <span className="min-w-0 flex-1 basis-40">{dv.doneText}</span>
                    <span className={cn('inline-flex items-center gap-1.75 text-muted-foreground', phone && 'order-3 basis-full pl-6.5')}>{memberFor(ctx.data, dv.metaBy, userName(ctx)) && <Avatar who={dv.metaBy} size={20} fontSize={9} />}{dv.meta}</span>
                    {dv.canUndo && <Button variant="soft" size="sm" className={tap} onClick={() => unapprove(dv.problem.id)}>Undo</Button>}
                  </div>
                ))}
              </Card>
            </section>
          )}
        </>
      )}
    </Page>
  )
}
