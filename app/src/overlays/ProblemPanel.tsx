// The right-side panel opened from a Today card: what Inhouse agent found, then the draft by stage.
import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { agent } from '../agent'
import { draftView, memberFor, userName } from '../state/derive'
import { useCtx, useUi } from '../state/store'
import { Avatar, Button, Icon, IconButton, IconTile, LogoTile } from '../ui'
import { sevClass } from '../ui/severity'
import { NO_MOTION } from '../ui/motion'
import { claimTrigger, restoreFocus, keepForToast } from '../ui/dialogs'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

const blueNote = 'mx-4.5 mt-2.5 flex items-start gap-2 rounded-lg bg-brand-tint px-3 py-2.5 text-sm text-brand-text'
const card = 'rounded-2xl border border-border bg-card'

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
  const askTitle = () => void ask('Tell me more about: ' + p.title)

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
        <div className="flex items-center gap-2 pt-3.5 pr-3.5 pl-6 text-xs text-muted-foreground">
          <Badge variant="muted" size="lg" className="gap-1.5">
            <i className={cn('size-1.75 rounded-full', sevClass(p.sev))} />{p.area}
          </Badge>
          Found at {p.draftedAt}
          <div className="flex-1" />
          <IconButton icon="close" label="Close" onClick={closeProblem} />
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-6 pt-3 pb-6">
          <SheetTitle className="text-2xl leading-heading font-medium tracking-heading">{p.title}</SheetTitle>
          <div className="mt-2 text-base text-foreground-3">
            <b className="font-semibold text-foreground tabular-nums">{p.cost}</b> {p.costNote}
          </div>

          <div className={`${card} mt-5 px-5 py-4.5`}>
            <div className="mono-label">What your Inhouse agent found</div>
            <p className="mt-2.5 text-md leading-reading">
              {p.found.map(([t, c], i) => (
                <span key={i}>
                  <span>{t}</span>
                  {c && <span className="ml-0.75 inline-flex h-4.25 min-w-4.25 items-center justify-center rounded-sm bg-brand-tint px-1 align-(--app-cite-raise) font-mono text-2xs font-semibold text-brand">{c}</span>}
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
          </div>

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
            <div className={`${card} mt-3 overflow-hidden shadow-float`}>
              <div className="flex items-center gap-2.5 border-b border-divider px-4.5 py-3.5">
                <span className="min-w-0 flex-1 text-base font-semibold"><span className="font-normal text-muted-foreground">Drafted · </span>{dv.draftTitle}</span>
                {dv.waitsLabel && <Badge variant="warning" size="lg" className="gap-1.25">{dv.waitsLabel}</Badge>}
              </div>
              <div className="px-4.5 py-1">
                {dv.lines.map(([a, b]) => (
                  <div key={a} className="flex min-h-9 items-center gap-4 border-b border-divider text-sm">
                    <span className="w-37.5 max-w-19/50 flex-none text-muted-foreground">{a}</span>
                    <span className="min-w-0 flex-1 font-medium tabular-nums">{b}</span>
                  </div>
                ))}
              </div>
              {(dv.body || isEditing) && (
                <div className="mx-4.5 mt-2.5 rounded-lg bg-dialog px-3.5 py-3 text-sm leading-prose text-foreground-2 wrap-anywhere">
                  <div className="mono-label mb-1.5 tracking-caps">{dv.bodyLabel ?? 'Your note'}</div>
                  {isEditing
                    ? <textarea aria-label={dv.bodyLabel ?? 'Your note'} value={dv.body ?? ''} placeholder={dv.body === null ? 'Add a note to this draft' : undefined} onChange={e => agent.editDraft(openId, e.target.value).catch((err: unknown) => { console.warn('Inhouse: could not save the note.', err) })}
                        className="block min-h-37.5 w-full resize-y rounded-md border border-border-strong bg-card px-3 py-2.5 text-sm leading-prose text-foreground focus:border-foreground/45 focus:shadow-halo" />
                    : dv.body}
                </div>
              )}
              {dv.doneNote && (
                <div className={blueNote}><Icon name="check_circle" size={16} weight={400} className="leading-icon" /><span>{dv.doneNote}</span></div>
              )}
              {dv.memory && (
                <div className={blueNote}>
                  <Icon name="neurology" size={16} weight={400} className="leading-icon" />
                  <span className="flex-1">{dv.memory}</span>
                  <button type="button" onClick={() => openSettings('team-memory')} className="rounded-xs font-strong whitespace-nowrap">Manage</button>
                </div>
              )}
              {dv.approverNote && (
                <div className="mx-4.5 mt-3.5 flex items-center gap-2 border-t border-divider pt-3 pb-3.5 text-xs text-foreground-3">
                  {memberFor(ctx.data, dv.approverNote, userName(ctx)) ? <Avatar who={dv.approverNote} size={22} fontSize={9} /> : <Icon name="person" size={15} />}
                  <span className="min-w-0 flex-1">{dv.approverNote}</span>
                  {dv.askApprover && (
                    <button type="button" onClick={() => showToast(`${dv.askApprover?.replace(/^Ask\b/, 'Asking')} isn't connected in this demo.`, { icon: 'info', ms: 4000 })}
                      className="rounded-xs font-strong whitespace-nowrap text-foreground">{dv.askApprover}</button>
                  )}
                </div>
              )}
            </div>
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
                <span className="block text-sm text-brand-text/85">{p.done}. Within your Run limits · logged in Activity.</span>
              </span>
              <Button variant="surface" size="sm" onClick={() => undoHandled(openId)}>Undo</Button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2.5 border-t border-border px-6 pt-3 pb-4">
          {/* The actions live here, on one row above the ask bar, so nothing scrolls out of reach or hides under it. */}
          {dv.mode === 'waiting' && (
            <div className="flex flex-wrap items-center gap-2">
              {/* On a phone the main action has its own row, so its label stays on one line. */}
              <Button variant="primary" size="lg" className="h-auto min-h-9.5 w-full min-w-0 py-1.5 whitespace-normal sm:w-auto sm:flex-none sm:text-left" onClick={() => approve(openId)}>{dv.cta}</Button>
              <Button variant="secondary" size="lg" className="flex-none" onClick={() => patch({ editing: isEditing ? null : openId })}>{isEditing ? 'Done' : 'Edit'}</Button>
              {/* A problem already set aside keeps its reason: Undo would otherwise restore it as declined. */}
              {!ctx.agent.setAside[openId] && <Button variant="ghost" size="lg" className="flex-none" onClick={() => { setAside(openId, 'declined'); closeProblem() }}>Don't send</Button>}
            </div>
          )}
          <button type="button" onClick={askTitle}
            className="flex h-10 w-full items-center gap-2 rounded-xl border border-border bg-card px-3.5 text-base text-muted-foreground">
            <Icon name="chat_bubble" size={17} />Ask about this…
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
