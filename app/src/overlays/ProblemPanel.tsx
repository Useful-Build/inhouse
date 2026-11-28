// The review window, opened from a Today or Approvals card: a short brief on the left, the draft on one sheet on the
// right, the decision across the foot. "1 of N" steps through the list it was opened from.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { escapeClosesMenuOnly } from '../ui/dialogs'
import { agent, demo } from '../agent'
import { draftView } from '../state/derive'
import type { Ctx, DraftView } from '../state/derive'
import { fmtMoney, fmtTime, hasAmount } from '../lib/format'
import { display } from '../state/display'
import { useCtx, useUi } from '../state/store'
import { Button, DetailList, Icon, IconButton, InhouseMark, LogoTile, MenuItem, Window } from '../ui'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { isUrgent } from '../ui/severity'
import { TAP } from '../ui/fields'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'

/** "A", "A and B", "A, B and C" (no Oxford comma). */
const andList = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
const lower1 = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)
const sentence = (s: string) => /[.!?]$/.test(s) ? s : `${s}.`

/**
 * What the agent found, as label and value rows. The morning check sends real pairs ("Late orders", "4"); the demo's
 * rows are pieces of one sentence, each ending on a source number, so they read back as that sentence, with no numbers.
 */
function foundView(p: DraftView['problem']): { rows: [string, string][] } | { text: string } {
  const cited = p.found.some(([, v]) => v !== '' && p.sources.some(s => s.n === v))
  return cited ? { text: p.found.map(([t]) => t).join('').trim() } : { rows: p.found }
}

/** Still waiting on someone: what Approve moves past to reach. */
const stillNeeds = (ctx: Ctx, id: string) => {
  if (ctx.agent.setAside[id]) return false
  const mode = draftView(ctx, id).mode
  return mode === 'waiting' || mode === 'watch'
}

export function ProblemPanel() {
  const openId = useUi(s => s.openId)
  const queue = useUi(s => s.queue)
  const editing = useUi(s => s.editing)
  const phone = useUi(s => s.phone)
  const ctx = useCtx()
  // Why the last Approve here was refused, by problem: the window stays on that draft and says so.
  const [failed, setFailed] = useState<{ id: string; text: string } | null>(null)
  const [approving, setApproving] = useState(false)
  // A refusal belongs to the window as it was: stepping to another problem or closing clears it.
  const [seenId, setSeenId] = useState(openId)
  if (seenId !== openId) { setSeenId(openId); setFailed(null) }
  if (!openId) return null

  const { closeProblem, stepProblem, approve, unapprove, ask, setAside, openTrace, showToast, patch } = useUi.getState()
  const dv = draftView(ctx, openId)
  const p = dv.problem
  const isEditing = editing === openId
  const tap = phone ? TAP : undefined
  const watch = dv.mode === 'watch'
  // Approved and handled problems no longer need anyone: no Urgent.
  const needsYou = dv.mode === 'waiting' || watch

  // "1 of N": the list the window was opened from, as it was then. Problems no longer in the data drop out.
  const list = queue.filter(id => ctx.data.problems.some(q => q.id === id))
  const at = list.indexOf(openId)
  const stepping = list.length > 1 && at >= 0
  const approveAndNext = async () => {
    if (approving) return
    setApproving(true); setFailed(null)
    const refused = await approve(openId)
    setApproving(false)
    // Refused: stay on this draft and say why. Moved on meanwhile (closed, stepped): leave the window where it is now.
    if (refused !== null) { setFailed({ id: openId, text: refused }); return }
    if (useUi.getState().openId !== openId) return
    // Straight on to the next one that still needs someone (the held toast keeps the Undo), or close at the end.
    const next = [...list.slice(at + 1), ...list.slice(0, Math.max(at, 0))].find(id => id !== openId && stillNeeds(ctx, id))
    if (next) stepProblem(next)
    else closeProblem()
  }
  const refusal = failed?.id === openId ? failed.text : null

  // The draft's parts: who it goes to and its subject sit on the sheet's header line and title, not as rows.
  const items = p.draft.items?.length ? p.draft.items : null
  const toLine = dv.lines.find(([k]) => k === 'To')?.[1]
  const subject = dv.lines.find(([k]) => k === 'Subject')?.[1]
  const rows = dv.lines.filter(([k]) => k !== 'To' && k !== 'Subject')
  const recipients: ReactNode = p.draft.to
    ? <>To <b className="font-medium text-foreground">{p.draft.to.name}</b>{p.draft.to.note && `, ${p.draft.to.note}`}</>
    : toLine ? <>To <b className="font-medium text-foreground">{toLine}</b></> : dv.kind
  const itemTotal = items && { minor: items.reduce((n, it) => n + it.each.minor * it.qty, 0), currency: items[0].each.currency }
  const units = items?.reduce((n, it) => n + it.qty, 0)

  // The brief: what's at risk, then what the agent drafted (at Watch and once handled, what it saw).
  const risk = <>{hasAmount(p.cost) && <><b className="font-semibold text-foreground tabular-nums">{fmtMoney(p.cost, display())}</b>{' '}</>}{sentence(p.costNote)}</>
  const second = watch || dv.mode === 'handled' ? sentence(p.sub) : `Your agent drafted a fix: ${lower1(sentence(dv.draftTitle))}`

  const found = foundView(p)
  const tools = andList(p.sources.map(s => s.name).filter((v, i, a) => a.indexOf(v) === i))
  const marks = p.sources.map(s => ({ key: s.logo ?? s.icon ?? s.name, logo: s.logo, icon: s.icon }))
    .filter((m, i, all) => all.findIndex(o => o.key === m.key) === i)
  const foundList = 'rows' in found
    ? found.rows.length > 0 && <DetailList variant="ruled" strong items={found.rows} className="text-base" />
    : found.text && <p className="m-0 text-base leading-prose text-foreground-2">{found.text}</p>

  const checked = p.sources.length > 0 && (
    // Keyed by problem, so stepping to the next one starts it closed.
    <Accordion key={openId} type="single" collapsible className="-mx-2.5">
      <AccordionItem value="checked" className="border-b-0">
        <AccordionTrigger className={cn('items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-normal text-muted-foreground hover:bg-accent hover:no-underline', tap)}>
          <span className="flex flex-none">
            {marks.map(m => m.logo
              ? <LogoTile key={m.key} k={m.logo} size="xs" round className="-mr-1 last:mr-0" />
              : <span key={m.key} className="-mr-1 flex size-4.5 items-center justify-center rounded-full border border-border bg-card text-foreground last:mr-0"><Icon name={m.icon ?? 'description'} size={11} weight={400} /></span>)}
          </span>
          <span className="min-w-0 flex-1">Checked {tools} at {fmtTime(p.draftedAt, display())}</span>
        </AccordionTrigger>
        <AccordionContent className="flex flex-col gap-3 px-2.5 pt-1 pb-2">
          {!watch && foundList}
          <ul className="m-0 flex list-none flex-col gap-1.75 p-0 text-sm text-foreground-3">
            {p.sources.map(s => (
              <li key={s.n} className="flex items-center gap-2">
                {s.logo && <LogoTile k={s.logo} size="xs" />}
                {s.icon && <span className="flex w-4.5 flex-none justify-center text-foreground"><Icon name={s.icon} size={14} weight={400} /></span>}
                {/* A record's own name ("#1042") reads with the tool; a bare citation number ("2") never shows. */}
                <span className="min-w-0"><b className="font-strong text-foreground">{s.name}</b>{!/^\d+$/.test(s.n) && ` ${s.n}`} · {s.text}</span>
              </li>
            ))}
          </ul>
          {p.trace && (
            <button type="button" onClick={() => openTrace(p.trace!)} className={cn('self-start rounded-xs text-sm font-medium text-foreground-3 hover:text-foreground', tap)}>See every step</button>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )

  const sheet = 'rounded-2xl bg-card shadow-card'
  const draft = (
    <article aria-label={`${dv.kind} draft`} className={sheet}>
      <div className="flex min-h-12 items-center gap-2.5 border-b border-divider py-2 pr-3 pl-5.5 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">{recipients}</span>
        {/* A Slack post has no Edit: the product's card goes out as the agent wrote it, or not at all. */}
        {dv.mode === 'waiting' && p.draft.kind !== 'Slack post' && (
          <Button variant="ghost" size="sm" className={cn('flex-none text-foreground', tap)} onClick={() => patch({ editing: isEditing ? null : openId })}>
            {isEditing ? 'Done' : 'Edit'}
          </Button>
        )}
      </div>
      <div className="px-5.5 pt-4 pb-5">
        {items ? (
          <table className="w-full border-collapse text-base tabular-nums">
            <caption className="pb-2 text-left text-md font-semibold">{dv.draftTitle}</caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="pt-1 pb-2 font-normal">Item</th>
                <th scope="col" className="pt-1 pb-2 pl-2.5 text-right font-normal">Qty</th>
                {!phone && <th scope="col" className="pt-1 pb-2 pl-2.5 text-right font-normal">Each</th>}
                <th scope="col" className="pt-1 pb-2 pl-2.5 text-right font-normal">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.name} className="border-t border-divider">
                  <td className="py-2.5">{it.name}{phone && <div className="text-sm text-foreground-3">{fmtMoney(it.each, display())} each</div>}</td>
                  <td className="py-2.5 pl-2.5 text-right">{it.qty}</td>
                  {!phone && <td className="py-2.5 pl-2.5 text-right text-muted-foreground">{fmtMoney(it.each, display())}</td>}
                  <td className="py-2.5 pl-2.5 text-right">{fmtMoney({ minor: it.each.minor * it.qty, currency: it.each.currency }, display())}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border-strong">
              <tr>
                <td className="pt-3 text-sm text-muted-foreground">{units} {units === 1 ? 'unit' : 'units'}</td>
                <td colSpan={phone ? 2 : 3} className="pt-3 text-right text-xl font-semibold tracking-stat">
                  <span className="sr-only">Total </span>{fmtMoney(itemTotal!, display())}
                </td>
              </tr>
            </tfoot>
          </table>
        ) : (
          <>
            <div className="text-md font-semibold">{subject ?? dv.draftTitle}</div>
            {rows.length > 0 && <DetailList variant={phone ? 'relaxed' : 'ruled'} strong items={rows} className="mt-2 text-sm" />}
          </>
        )}
        {(dv.body || isEditing) && (
          <div className="mt-3.5 text-base leading-prose text-foreground-2 wrap-anywhere">
            {/* An email's text needs no label under its subject; a note on an order or a change does. */}
            {!subject && <div className="mb-1 text-sm text-muted-foreground">{dv.bodyLabel ?? 'Your note'}</div>}
            {isEditing
              ? <textarea aria-label={dv.bodyLabel ?? 'Your note'} value={dv.body ?? ''} placeholder={dv.body === null ? 'Add a note to this draft' : undefined} onChange={e => agent.editDraft(openId, e.target.value).catch((err: unknown) => { console.warn('Inhouse: could not save the note.', err) })}
                  className="block min-h-37.5 w-full resize-y rounded-md border border-border-strong bg-card px-3 py-2.5 text-sm leading-prose text-foreground focus:border-foreground/45 focus:shadow-halo" />
              : <p className="m-0 whitespace-pre-line">{dv.body}</p>}
          </div>
        )}
      </div>
    </article>
  )

  const suggestion = (
    <div className={cn(sheet, 'px-6 pt-5.5 pb-6')}>
      <div className="flex items-center gap-2.5 text-sm font-semibold text-foreground-2">
        <span className="flex size-6.5 items-center justify-center rounded-lg border border-border"><InhouseMark size={13} /></span>
        Your Inhouse agent suggests
      </div>
      <p className="m-0 mt-3.5 text-xl leading-normal font-medium tracking-section">{sentence(dv.suggestedNext)}</p>
      <p className="m-0 mt-3.5 text-sm text-muted-foreground">For now your agent only suggests. It doesn't send anything.</p>
    </div>
  )

  // Everything besides the main action, behind one "More" button: Don't send first (a problem already set aside keeps
  // its reason, so it isn't offered again), then asking someone, then snoozing or saying it isn't a problem.
  const putAside = (why: 'snoozed' | 'dismissed' | 'declined') => { setAside(openId, why); closeProblem() }
  const aside = !!ctx.agent.setAside[openId]
  // Asking the approver isn't wired up anywhere yet: the demo says so in a toast, the product leaves it out.
  const askApprover = dv.mode === 'waiting' && demo !== null ? dv.askApprover : null
  // More shows only with something in it (Watch on a set-aside problem has nothing).
  const hasMore = !watch || !aside
  const more = hasMore && (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="lg" className={cn('flex-none', phone && 'min-h-11', tap)}>More<Icon name="expand_more" size={18} /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" collisionPadding={16} aria-label="More actions" aria-labelledby={undefined} className="w-menu-message max-w-screen-gutter border-input"
        // Escape closes only this menu: Radix hears it first, in the capture phase, so stopping it keeps App's Escape
        // (close the whole window) from hearing it too.
        onEscapeKeyDown={escapeClosesMenuOnly}>
        {dv.mode === 'waiting' && !aside && <>
          <MenuItem onSelect={() => putAside('declined')}>
            <Icon name="cancel_schedule_send" size={18} /><span className="flex-1">Don't send</span>
          </MenuItem>
          <DropdownMenuSeparator />
        </>}
        {askApprover && (
          <MenuItem onSelect={() => showToast(`${askApprover.replace(/^Ask\b/, 'Asking')} isn't connected in this demo.`, { icon: 'info', ms: 4000 })}>
            <Icon name="person" size={18} /><span className="flex-1">{askApprover}</span>
          </MenuItem>
        )}
        {!watch && (
          <MenuItem onSelect={() => void ask('Tell me more about: ' + p.title)}>
            <Icon name="chat_bubble" size={18} /><span className="flex-1">Ask Inhouse</span>
          </MenuItem>
        )}
        {!aside && <>
          <MenuItem onSelect={() => putAside('snoozed')}>
            <Icon name="snooze" size={18} /><span className="flex-1">Snooze until tomorrow</span>
          </MenuItem>
          <MenuItem onSelect={() => putAside('dismissed')}>
            <Icon name="do_not_disturb_on" size={18} /><span className="flex-1">Not a problem</span>
          </MenuItem>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const status = (icon: string, title: string, line: string, undo: (() => void) | null) => (
    <div className="flex items-center gap-2.5 text-base">
      <Icon name={icon} size={20} weight={400} className="flex-none text-foreground" />
      <span className="min-w-0 flex-1">
        <b className="font-semibold">{title}</b>
        <span className="block text-sm text-muted-foreground">{line}</span>
      </span>
      {undo && <Button variant="soft" size="sm" className={tap} onClick={undo}>Undo</Button>}
    </div>
  )

  return (
    <Window onClose={closeProblem} label={p.title} size={phone ? 'md' : 'wide'}>
      <div className={cn('flex flex-none items-center gap-1.5 pt-3.5 text-sm', phone ? 'pr-2.5 pl-5' : 'pr-4 pl-8')}>
        {/* As on the cards: the Urgent pill, then the area. */}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {needsYou && isUrgent(p.sev) && <Badge variant="destructive" size="lg">Urgent</Badge>}
          <span className="truncate text-muted-foreground">{p.area}</span>
        </span>
        {stepping && <>
          <span className="mr-0.5 text-muted-foreground tabular-nums">{at + 1} of {list.length}</span>
          <IconButton icon="expand_less" label="Previous" size={18} box="icon-sm" disabled={at === 0} onClick={() => stepProblem(list[at - 1])} className={tap} />
          <IconButton icon="expand_more" label="Next" size={18} box="icon-sm" disabled={at === list.length - 1} onClick={() => stepProblem(list[at + 1])} className={tap} />
        </>}
        <IconButton icon="close" label="Close" size={18} box="icon-sm" onClick={closeProblem} className={tap} />
      </div>

      {/* Two columns only when the window itself has room for both (a container query): a narrow desktop window, beside
          an open sidebar, stacks them as on a phone, so the draft never shrinks to a sliver. */}
      <div className="@container min-h-0 flex-1 overflow-auto">
        <div className={cn('flex flex-col', phone ? 'gap-5 px-5 pt-2 pb-5' : 'gap-5 px-8 pt-3 pb-6 @3xl:flex-row @3xl:gap-9')}>
          <div className={cn('flex flex-col', !phone && '@3xl:w-82.5 @3xl:flex-none')}>
            <h2 className="text-window-title leading-card font-semibold tracking-tight text-pretty">{p.title}</h2>
            <p className="m-0 mt-3 text-md leading-prose text-foreground-2">{risk} {second}</p>
            {watch && foundList && <div className="mt-4">{foundList}</div>}
            <div className="min-h-5 flex-1" />
            {!phone && checked}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {watch ? suggestion : draft}
            {/* Why the approval went back to waiting, in the outbox's words (a Pause, or the channel left the list). */}
            {p.lapsed && dv.mode !== 'approved' && <p className="m-0 px-1 text-sm text-warning-text">{p.lapsed}</p>}
            {dv.mode === 'waiting' && dv.doneNote && (
              <div className="flex items-start gap-2 rounded-lg bg-brand-tint px-3 py-2.5 text-sm text-brand-text"><Icon name="check_circle" size={16} weight={400} className="leading-icon" /><span>{dv.doneNote}</span></div>
            )}
            {/* Who usually approves, when it's someone else: a quiet note under the draft. Asking them is in the menu. */}
            {dv.mode === 'waiting' && dv.approverNote && (
              <div className="flex items-start gap-2 rounded-lg bg-fill px-3 py-2.5 text-sm text-foreground-3"><Icon name="person" size={16} weight={400} className="leading-icon" /><span className="min-w-0 flex-1 text-pretty">{dv.approverNote}</span></div>
            )}
          </div>
          {phone && checked}
        </div>
      </div>

      {refusal !== null && (
        <p role="alert" className={cn('flex-none border-t border-divider pt-3 text-sm text-destructive-text', phone ? 'px-5' : 'pr-6 pl-8')}>It wasn't approved, and nothing went out. {refusal}</p>
      )}
      <div className={cn('flex flex-none gap-2 border-t border-divider pt-3.5 pb-4', phone ? 'flex-wrap items-center px-5' : 'items-center pr-6 pl-8')}>
        {/* The decision reads left to right: the main action, then More (Don't send first, then everything else). */}
        {watch && <>
          <Button variant="primary" size="lg" className={tap} onClick={() => void ask('Tell me more about: ' + p.title)}>Ask Inhouse</Button>
          {more}
        </>}
        {dv.mode === 'waiting' && <>
          <Button variant="primary" size="lg" disabled={approving} className={cn('h-auto min-h-10 min-w-0 py-2 whitespace-nowrap', phone && 'w-full')} onClick={() => void approveAndNext()}>
            {dv.cta}{p.draft.amount && p.draft.money && <span className="font-normal tabular-nums">{fmtMoney(p.draft.amount.money, display())}</span>}
          </Button>
          {more}
        </>}
        {dv.mode === 'approved' && <div className="flex-1">{status('check_circle', dv.doneText, dv.approvedLine, dv.canUndo ? () => unapprove(openId) : null)}</div>}
      </div>
    </Window>
  )
}
