// The review panel, opened from a Today or Approvals card: what the agent found, then the draft as a document by stage.
import { Fragment, useRef } from 'react'
import { cn } from '@/lib/utils'
import { agent } from '../agent'
import { draftView, memberFor, riskLabel, userName } from '../state/derive'
import { fmtMoney, fmtProse, fmtTime } from '../lib/format'
import { display } from '../state/display'
import { useCtx, useUi } from '../state/store'
import { Avatar, Button, Icon, IconButton, IconTile, LogoTile } from '../ui'
import { isUrgent } from '../ui/severity'
import { NO_MOTION } from '../ui/motion'
import { TAP } from '../ui/fields'
import { claimTrigger, restoreFocus, keepForToast } from '../ui/dialogs'
import { Badge } from '@/components/ui/badge'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

const card = 'rounded-2xl border border-border bg-card'
const FACT_COLS: Record<number, string> = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3' }

/** A source number after a sentence or a fact, pointing at the numbered source list. */
function Cite({ n }: { n: string }) {
  return <span className="ml-0.75 inline-flex h-4.25 min-w-4.25 items-center justify-center rounded-sm bg-brand-tint px-1 align-(--app-cite-raise) font-mono text-2xs font-semibold text-brand">{n}</span>
}

export function ProblemPanel() {
  const openId = useUi(s => s.openId)
  const editing = useUi(s => s.editing)
  const ctx = useCtx()
  const panelRef = useRef<HTMLDivElement>(null)
  const before = useRef<HTMLElement | null>(null)
  const phone = useUi(s => s.phone)
  if (!openId) return null

  const { closeProblem, approve, unapprove, undoHandled, ask, setAside, openSettings, showToast, patch } = useUi.getState()
  const dv = draftView(ctx, openId)
  const p = dv.problem
  const isEditing = editing === openId
  const tap = phone ? TAP : undefined
  const askTitle = () => void ask('Tell me more about: ' + p.title)
  // Approved and handled problems no longer need anyone: no Urgent pill.
  const needsYou = dv.mode === 'waiting' || dv.mode === 'watch'
  const foundAt = fmtTime(p.draftedAt, display())
  const steps = [
    { label: `Found ${foundAt}`, done: true, current: false },
    { label: 'Drafted', done: true, current: false },
    { label: dv.mode === 'handled' ? 'Handled by your agent' : 'Your approval', done: dv.mode !== 'waiting', current: dv.mode === 'waiting' },
    { label: dv.destination ? `Sent to ${dv.destination}` : 'Sent', done: dv.mode === 'handled' || (dv.mode === 'approved' && dv.sent), current: false },
  ]
  const facts = p.facts ?? null
  const risk = riskLabel(dv)
  // A purchase order with structured lines renders as a table; every other draft as key and value rows.
  const items = p.draft.items ?? null
  const to = p.draft.to ?? null
  const itemTotal = items && { minor: items.reduce((n, it) => n + it.each.minor * it.qty, 0), currency: items[0].each.currency }
  const itemCount = items && `${items.reduce((n, it) => n + it.qty, 0)} units`
  // One mark per source tool: a logo, or the source's icon.
  const sourceMarks = p.sources.map(s => ({ key: s.logo ?? s.icon ?? s.name, logo: s.logo, icon: s.icon }))
    .filter((m, i, all) => all.findIndex(o => o.key === m.key) === i)
  const approverName = dv.approverNote ? memberFor(ctx.data, dv.approverNote, userName(ctx))?.name : undefined
  const found = (
    <>
      <p className="mt-2.5 text-md leading-reading">
        {p.found.map(([t, c], i) => (
          <span key={i}>
            <span>{t}</span>
            {c && <Cite n={c} />}
          </span>
        ))}
      </p>
      <div className="mt-3.5 flex flex-col gap-1.75 border-t border-divider pt-3 text-xs text-foreground-3">
        {p.sources.map(s => (
          <div key={s.n} className="flex items-center gap-2">
            <span className="w-3 font-mono text-2xs font-semibold text-brand">{s.n}</span>
            {s.logo && <LogoTile k={s.logo} size="xs" className="-my-px" />}
            {s.icon && <span className="flex w-4.5 flex-none justify-center text-foreground"><Icon name={s.icon} size={14} weight={400} /></span>}
            <span><b className="font-strong text-foreground">{s.name}</b> · {s.text}</span>
          </div>
        ))}
      </div>
    </>
  )
  const dontSend = !ctx.agent.setAside[openId] && (
    <Button variant="ghost" size="lg" className={cn('min-h-11.5 flex-none text-md text-foreground-3', !phone && '-ml-3')} onClick={() => { setAside(openId, 'declined'); closeProblem() }}>Don't send</Button>
  )

  return (
    <Sheet open onOpenChange={o => { if (!o) closeProblem() }}>
      <SheetContent ref={panelRef} side={phone ? 'bottom' : 'right'} showCloseButton={false} aria-describedby={undefined}
        // No slide or fade, like the panel before Radix (and screenshots catch it fully drawn).
        overlayProps={{ className: NO_MOTION }}
        onOpenAutoFocus={e => { before.current = claimTrigger(); e.preventDefault(); panelRef.current?.focus() }}
        onCloseAutoFocus={e => { e.preventDefault(); restoreFocus(before.current) }}
        onPointerDownOutside={keepForToast}
        onInteractOutside={keepForToast}
        data-surface="window"
        className={cn('gap-0 overflow-hidden rounded-2xl border bg-window-surface shadow-menu', NO_MOTION, phone ? 'inset-2.5 h-auto w-auto' : 'inset-y-2.5 right-2.5 h-auto w-problem-panel sm:max-w-none')}>
        <div className="flex items-center gap-1.5 pt-3.5 pr-3.5 pl-6">
          {needsYou && isUrgent(p.sev) && <Badge variant="destructive" size="lg">Urgent</Badge>}
          <Badge variant="muted" size="lg">{p.area}</Badge>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" aria-label="Ask about this" className={cn('text-foreground-3', tap)} onClick={askTitle}>
            <Icon name="chat_bubble" size={16} />Ask
          </Button>
          <IconButton icon="close" label="Close" onClick={closeProblem} />
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-6 pt-3 pb-6">
          <SheetTitle className="text-2xl leading-heading font-medium tracking-heading">{p.title}</SheetTitle>
          <div className="mt-2 text-base text-foreground-3">
            <b className="font-semibold text-foreground tabular-nums">{fmtMoney(p.cost, display())}</b> {p.costNote}
          </div>

          {dv.mode === 'watch' ? (
            <p className="m-0 mt-3 text-sm text-muted-foreground">Found {foundAt}</p>
          ) : (
            <ol aria-label="Progress" className="m-0 mt-3.5 flex list-none flex-wrap items-center gap-x-2 gap-y-1.5 p-0 text-sm text-muted-foreground">
              {steps.map((st, i) => (
                <Fragment key={st.label}>
                  {i > 0 && <li aria-hidden="true" className="h-px w-4 bg-border-strong" />}
                  <li aria-current={st.current ? 'step' : undefined} className={cn('flex items-center gap-1.5', st.current && 'font-semibold text-foreground')}>
                    {st.done
                      ? <span className="flex size-4 flex-none items-center justify-center rounded-full bg-foreground text-background"><Icon name="check" size={12} weight={600} /></span>
                      : st.current
                        ? <span className="flex size-4 flex-none items-center justify-center rounded-full border-hairline border-foreground"><span className="size-1.5 rounded-full bg-foreground" /></span>
                        : <span className="size-4 flex-none rounded-full border-hairline border-border-strong" />}
                    {st.label}
                    {st.done && <span className="sr-only"> (done)</span>}
                  </li>
                </Fragment>
              ))}
            </ol>
          )}

          {facts ? (
            <>
              <div className={cn('mt-5 grid rounded-2xl border border-border bg-card shadow-card', FACT_COLS[facts.length])}>
                {facts.map(f => (
                  <div key={f.label} className="min-w-0 border-l border-divider px-4 pt-3.5 pb-3.5 first:border-l-0">
                    <div className="text-xs text-muted-foreground">{f.label}</div>
                    <div className={cn('mt-1.5 text-2xl leading-none font-semibold tracking-stat tabular-nums', f.tone === 'bad' && 'text-destructive-text')}>{f.value}</div>
                    <div className="mt-1.5 text-xs text-foreground-3">{f.note}{f.source && <Cite n={f.source} />}</div>
                  </div>
                ))}
              </div>
              <Accordion type="single" collapsible className="-mx-2.5 mt-2">
                <AccordionItem value="sources" className="border-b-0">
                  <AccordionTrigger className="items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-normal text-foreground-3 hover:bg-accent hover:no-underline">
                    <span className="flex flex-none">
                      {sourceMarks.map(s => s.logo
                        ? <LogoTile key={s.key} k={s.logo} size="sm" round className="-mr-1.25 last:mr-0" />
                        : <span key={s.key} className="-mr-1.25 flex size-5.5 items-center justify-center rounded-full border border-border bg-card text-foreground last:mr-0"><Icon name={s.icon ?? 'description'} size={13} weight={400} /></span>)}
                    </span>
                    <span className="min-w-0 flex-1">How your Inhouse agent worked it out</span>
                    <span className="text-muted-foreground">{p.sources.length} {p.sources.length === 1 ? 'source' : 'sources'}</span>
                  </AccordionTrigger>
                  <AccordionContent className="px-2.5 pt-1 pb-2">{found}</AccordionContent>
                </AccordionItem>
              </Accordion>
            </>
          ) : (
            <div className={`${card} mt-5 px-5 py-4.5`}>
              <div className="mono-label">What your Inhouse agent found</div>
              {found}
            </div>
          )}

          {dv.mode === 'watch' && (
            <div className="mt-3 flex items-start gap-3.5 rounded-2xl border border-dashed border-border-strong px-5 py-4.5 text-foreground-3">
              <IconTile icon="lightbulb" iconSize={17} tone="hover" />
              <div className="flex-1">
                <div className="text-base font-strong text-foreground">Suggested next step</div>
                <div className="mt-0.5 text-sm">{dv.suggestedNext}. In Act, your Inhouse agent drafts this for you to approve.</div>
              </div>
            </div>
          )}

          {dv.mode === 'waiting' && (
            <>
              <h3 className="mt-5.5 text-sm font-semibold">Drafted for you</h3>
              <article aria-label={`${dv.kind} draft`} className="mt-2.5 rounded-xl bg-popover px-5.5 pt-4 pb-5 shadow-float">
                <div className="flex min-h-8 items-center gap-2.5">
                  <span className="mono-label">{dv.kind}</span>
                  <Badge variant="muted">Draft</Badge>
                  {risk && <Badge variant="warning">{risk}</Badge>}
                  <div className="flex-1" />
                  <Button variant="ghost" size="sm" className={cn('-mr-2', tap)} onClick={() => patch({ editing: isEditing ? null : openId })}>
                    <Icon name="edit" size={15} />{isEditing ? 'Done' : 'Edit'}
                  </Button>
                </div>
                {to && (
                  <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
                    <div><div className="text-xs text-muted-foreground">From</div><div className="mt-0.5 font-semibold">{ctx.data.meta.brand.name}</div></div>
                    <div>
                      <div className="text-xs text-muted-foreground">To</div><div className="mt-0.5 font-semibold">{to.name}</div>
                      {to.note && <div className="text-foreground-3">{to.note}</div>}
                    </div>
                  </div>
                )}
                {items ? (
                  <table className="mt-4.5 w-full border-collapse text-base tabular-nums">
                    <thead className="border-t-hairline border-foreground text-left text-xs text-muted-foreground">
                      <tr>
                        <th scope="col" className="pt-2.5 pb-2 font-normal">Item</th>
                        <th scope="col" className="pt-2.5 pb-2 pl-2.5 text-right font-normal">Qty</th>
                        {!phone && <th scope="col" className="pt-2.5 pb-2 pl-2.5 text-right font-normal">Each</th>}
                        <th scope="col" className="pt-2.5 pb-2 pl-2.5 text-right font-normal">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(it => (
                        <tr key={it.name} className="border-t border-divider">
                          <td className="py-2.5">{it.name}{phone && <div className="text-sm text-foreground-3">{fmtMoney(it.each, display())} each</div>}</td>
                          <td className="py-2.5 pl-2.5 text-right">{it.qty}</td>
                          {!phone && <td className="py-2.5 pl-2.5 text-right text-foreground-3">{fmtMoney(it.each, display())}</td>}
                          <td className="py-2.5 pl-2.5 text-right">{fmtMoney({ minor: it.each.minor * it.qty, currency: it.each.currency }, display())}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t-hairline border-foreground">
                      <tr>
                        <td className="pt-3.5 text-sm text-foreground-3">{itemCount}</td>
                        <td colSpan={phone ? 2 : 3} className="pt-3.5 text-right text-sm text-foreground-3">
                          Total<span className="ml-3 text-2xl font-semibold tracking-stat text-foreground">{fmtMoney(itemTotal!, display())}</span>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                ) : (
                  <div className="mt-2">
                    {dv.lines.map(([a, b]) => (
                      <div key={a} className="flex min-h-9 items-center gap-4 border-b border-divider text-sm">
                        <span className="w-37.5 max-w-19/50 flex-none text-muted-foreground">{a}</span>
                        <span className="min-w-0 flex-1 font-medium tabular-nums">{b}</span>
                      </div>
                    ))}
                  </div>
                )}
                {(dv.body || isEditing) && (
                  <div className="mt-4 text-sm leading-prose text-foreground-2 wrap-anywhere">
                    <div className="mb-1.5 text-sm text-muted-foreground">{dv.bodyLabel ?? 'Your note'}</div>
                    {isEditing
                      ? <textarea aria-label={dv.bodyLabel ?? 'Your note'} value={dv.body ?? ''} placeholder={dv.body === null ? 'Add a note to this draft' : undefined} onChange={e => agent.editDraft(openId, e.target.value).catch((err: unknown) => { console.warn('Inhouse: could not save the note.', err) })}
                          className="block min-h-37.5 w-full resize-y rounded-md border border-border-strong bg-card px-3 py-2.5 text-sm leading-prose text-foreground focus:border-foreground/45 focus:shadow-halo" />
                      : <p className="m-0 text-base">{dv.body}</p>}
                  </div>
                )}
              </article>
              {dv.memory && (
                <div className="mt-3.5 flex items-start gap-2 text-sm text-foreground-3">
                  <Icon name="neurology" size={16} weight={400} className="mt-0.5 text-brand" />
                  <span className="flex-1">{dv.memory}</span>
                  <button type="button" onClick={() => openSettings('team-memory')} className="rounded-xs font-semibold whitespace-nowrap text-brand-text">Manage</button>
                </div>
              )}
              {dv.doneNote && (
                <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-brand-tint px-3 py-2.5 text-sm text-brand-text"><Icon name="check_circle" size={16} weight={400} className="leading-icon" /><span>{dv.doneNote}</span></div>
              )}
            </>
          )}

          {dv.mode === 'approved' && (
            <div className={`${card} mt-3 flex items-center gap-2.5 px-4.5 py-4 text-base`}>
              <Icon name="check_circle" size={20} weight={400} className="text-foreground" />
              <span className="flex-1">
                <b className="font-semibold">{dv.doneText}</b>
                <span className="block text-sm text-muted-foreground">{dv.approvedLine}</span>
              </span>
              {dv.canUndo && <Button variant="soft" size="sm" onClick={() => unapprove(openId)}>Undo</Button>}
            </div>
          )}

          {dv.mode === 'handled' && (
            <div className="mt-3 flex items-center gap-2.5 rounded-2xl bg-brand-tint px-4.5 py-4 text-base text-brand-text">
              <Icon name="check_circle" size={20} weight={400} />
              <span className="flex-1">
                <b className="font-semibold">Handled by Inhouse agent</b>
                <span className="block text-sm text-brand-text/85">{p.done && fmtProse(p.done, display())}. Within your Run limits · logged in Activity.</span>
              </span>
              <Button variant="surface" size="sm" onClick={() => undoHandled(openId)}>Undo</Button>
            </div>
          )}
        </div>

        {dv.mode === 'waiting' && (
          <div className="flex flex-col gap-3 border-t border-divider px-6 pt-3.5 pb-4">
            {dv.approverNote && (
              <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
                {approverName ? <Avatar who={approverName} size={24} fontSize={9} /> : <Icon name="person" size={16} />}
                <span className="min-w-0 flex-1">{approverName ? <><b className="font-semibold text-foreground-2">{approverName}</b>{dv.approverNote.slice(approverName.length)}</> : dv.approverNote}</span>
                {dv.askApprover && (
                  <Button variant="ghost" size="sm" className={cn('-mr-2 flex-none', tap)}
                    onClick={() => showToast(`${dv.askApprover?.replace(/^Ask\b/, 'Asking')} isn't connected in this demo.`, { icon: 'info', ms: 4000 })}>{dv.askApprover}</Button>
                )}
              </div>
            )}
            {/* On a phone the main action has its own full-width row and Don't send sits under it. */}
            <div className={cn('flex gap-2', phone ? 'flex-col' : 'items-center')}>
              {/* A problem already set aside keeps its reason: Undo would otherwise restore it as declined. */}
              {!phone && dontSend}
              <Button variant="primary" size="lg" className="h-auto min-h-11.5 min-w-0 flex-1 py-2 text-md whitespace-nowrap" onClick={() => approve(openId)}>
                {dv.cta}{p.draft.amount && <span className="font-normal tabular-nums">{fmtMoney(p.draft.amount.money, display())}</span>}
              </Button>
              {phone && dontSend}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
