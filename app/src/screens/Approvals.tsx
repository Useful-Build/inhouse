import { amountOf, draftView, flags, lowRiskIds, memberFor, pendingIds, problemById, userName, visibleProblems } from '../state/derive'
import { sevClass } from '../ui/severity'
import { useCtx, useUi } from '../state/store'
import type { ApprovalSort } from '../state/store'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Avatar, Button, DetailList, Dot, EmptyState, Icon, IconTile, Page, PageHeader, SectionHeader } from '../ui'
import { Select, TAP } from '../ui/fields'

const SORTS: [ApprovalSort, string][] = [['oldest', 'Oldest first'], ['newest', 'Newest first'], ['stake', 'Most at stake']]

export function Approvals() {
  const ctx = useCtx()
  const approve = useUi(s => s.approve)
  const unapprove = useUi(s => s.unapprove)
  const openProblem = useUi(s => s.openProblem)
  const openTeam = useUi(s => s.openTeam)
  const { approveMany, setAside, newChat, patch } = useUi.getState()
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
  // Edit opens the draft in the panel with its text ready to change; a draft with no text is changed by asking.
  const edit = (id: string) => {
    const dv = draftView(ctx, id)
    if (dv.body === null) { newChat(`Change the draft "${dv.problem.draft.title}": `); return }
    openProblem(id)
    patch({ editing: id })
  }
  const noData = flags(ctx).noData
  // Watch lists what Today shows: problems a person set aside aren't counted.
  const watchList = visibleProblems(ctx)
  const nProblems = watchList.length
  const approvedList = ctx.data.problems.filter(p => agent.approved[p.id]).map(p => draftView(ctx, p.id))

  const waitingActions = (
    <>
      {lowRisk.length >= 2 && (
        <Button variant="outline" size="sm" className={tap} onClick={() => approveMany(lowRisk)}>
          <Icon name="done_all" size={16} />Approve all low-risk
        </Button>
      )}
      <Select label="Sort drafts" value={SORTS.find(([k]) => k === sort)![1]} options={SORTS.map(([, l]) => l)} minWidth={0}
        onChange={v => patch({ approvalSort: SORTS.find(([, l]) => l === v)![0] })}
        className={cn('rounded-lg border-transparent bg-transparent pr-1.5 pl-2.5 text-sm text-foreground-3 data-[size=default]:h-7', tap)} />
    </>
  )

  return (
    <Page>
      <PageHeader title="Approvals" description="Work your Inhouse agent drafted. Nothing goes out until someone approves it." />

      {S === 0 && (
        <div className="mt-7 flex items-start gap-4 rounded-2xl border border-dashed border-border-strong p-7 text-foreground-3">
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
          <SectionHeader title="Waiting for you" count={pending.length} className={phone ? 'mt-7.5 mb-2.5' : 'mt-7.5 mb-3'}
            actions={phone ? undefined : waitingActions} />
          {phone && <div className="mb-3 flex flex-wrap items-center gap-2">{waitingActions}</div>}
          {pending.length === 0 && <EmptyState>All caught up. New drafts will show up here.</EmptyState>}
          <div className="flex flex-col gap-3">
            {pending.map(id => {
              const dv = draftView(ctx, id)
              return (
                <Card key={id} className="gap-0 overflow-hidden rounded-2xl border-border py-0 shadow-card">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-divider px-4.5 py-3.5">
                    <Dot className={sevClass(dv.problem.sev)} />
                    <h2 className="min-w-40 flex-1 text-base font-semibold">{dv.draftTitle}</h2>
                    {dv.waitsLabel && (
                      <Badge variant="warning">{dv.waitsLabel}</Badge>
                    )}
                    <span className="text-xs text-muted-foreground">{dv.problem.area} · {dv.problem.draftedAt}</span>
                  </div>
                  <DetailList variant="ruled" strong items={dv.lines} className="px-4.5 py-1 text-sm" />
                  {dv.body && (
                    <div className="mx-4.5 mt-2.5 rounded-lg bg-dialog px-3.5 py-3 text-sm leading-prose text-foreground-2 wrap-anywhere">
                      <div className="mono-label mb-1.5 tracking-caps">{dv.bodyLabel}</div>
                      {dv.body}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 px-4.5 pt-3.5 pb-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="lg" className={tap} onClick={() => approve(id)}>{dv.cta}</Button>
                      <Button variant="secondary" size="lg" className={tap} onClick={() => openProblem(id)}>Open</Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" size="lg" className={tap} onClick={() => edit(id)}>Edit</Button>
                      <Button variant="ghost" size="lg" className={tap} onClick={() => setAside(id, 'declined')}>Don't send</Button>
                    </div>
                    <div className="flex-1" />
                    <span className="text-right text-xs text-muted-foreground">{dv.footNote}</span>
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
                  <div key={dv.problem.id} className="flex min-h-14.75 items-center gap-2.5 border-b border-divider py-1.5 text-sm">
                    <Icon name="check_circle" size={17} weight={400} className="text-foreground" />
                    <span className="min-w-0 flex-1">{dv.doneText}</span>
                    <span className="inline-flex items-center gap-1.75 text-muted-foreground">{memberFor(ctx.data, dv.metaBy, userName(ctx)) && <Avatar who={dv.metaBy} size={20} fontSize={9} />}{dv.meta}</span>
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
