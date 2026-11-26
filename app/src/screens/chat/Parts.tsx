// Message parts inside an answer's card (decision D2): the agent's text (about 620px wide), a table between hairlines,
// routines and skills as inset blocks, the "worked for" row, the not-in-this-stage pill, the error line and suggested
// questions. The card itself is the thread's (Chats.tsx): a part draws no card of its own. A draft to approve is the
// exception: it is its own card after the answer's (`ApprovalCard`), drawn by the thread. The sources row is `SourcesRow`.
import { useLayoutEffect } from 'react'
import type { MessagePart } from '../../agent/types'
import { parseHostlist } from '../../../shared/contract/settings-table'
import { draftView, whenOf } from '../../state/derive'
import { fmtNextRun } from '../../lib/format'
import { display } from '../../state/display'
import { useCtx, useUi } from '../../state/store'
import { Button, Icon } from '../../ui'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Markdown } from './markdown'
import { useRevealed } from './reveal'
import { MODEL_OFF_TEXTS } from './notes'
import { cn } from '@/lib/utils'
import { SuggestionChip } from '../../ui/chat'
import { CONFIRMATION_SHEET, Confirmation, ConfirmationButtons, ConfirmationResult } from '../../ui/agent'
import { AskCard } from './AskCard'

const OPEN_LINK = 'flex flex-none items-center gap-0.5 text-base text-foreground-3 hover:text-foreground'
/** A routine or skill inside the answer's card: an inset block a step off the card. */
const INSET = 'box-border max-w-full rounded-2xl border border-divider bg-muted px-4 py-3.5'

function CardHead({ icon, iconSize = 21, tile = 'bg-primary', kicker, title, openLabel, onOpen }: {
  icon: string; iconSize?: number; tile?: string; kicker: string; title: string; openLabel: string; onOpen: () => void
}) {
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className={cn('flex size-10 flex-none items-center justify-center rounded-full text-primary-foreground', tile)}>
        <Icon name={icon} size={iconSize} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-muted-foreground">{kicker}</div>
        <div className="text-md font-strong tracking-card wrap-anywhere">{title}</div>
      </div>
      <button type="button" onClick={onOpen} aria-label={`${openLabel}: ${title}`} className={OPEN_LINK}>
        Open<Icon name="chevron_right" size={18} />
      </button>
    </div>
  )
}

/** A draft the agent made for approval: its own card after the answer's, in the brand-tint sheet look Today's cards use. */
export function ApprovalCard({ problemId }: { problemId: string }) {
  const ctx = useCtx()
  const approve = useUi(s => s.approve)
  const unapprove = useUi(s => s.unapprove)
  const openProblem = useUi(s => s.openProblem)
  // A saved chat can name a draft the agent's data doesn't have now (another scenario, day one): say so, don't crash.
  if (!ctx.data.problems.some(p => p.id === problemId)) {
    return <div className={cn(CONFIRMATION_SHEET, 'text-sm text-muted-foreground')}>This draft isn't in today's list.</div>
  }
  const dv = draftView(ctx, problemId)
  const done = !!dv.approvedAt
  // Money and customer messages are approved from the panel, never with one tap.
  const sensitive = !!(dv.problem.draft.money || dv.problem.draft.customer)
  return (
    <Confirmation data-approval icon="edit_note" kicker="Drafted for your approval" title={dv.draftTitle} openLabel="Open draft"
      onOpen={() => openProblem(problemId)} body={dv.body} bodyLabel={dv.bodyLabel ?? undefined}>
      {!done && (
        <ConfirmationButtons>
          {sensitive
            ? <Button onClick={() => openProblem(problemId)}>Review</Button>
            : <>
                <Button onClick={() => approve(problemId)}>{dv.cta}</Button>
                <Button variant="soft" onClick={() => openProblem(problemId)}>Review and edit</Button>
              </>}
        </ConfirmationButtons>
      )}
      {done && (
        <ConfirmationResult line={dv.approvedLine.replace(' · logged in Activity', '')}
          action={dv.canUndo && <Button variant="soft" size="sm" onClick={() => unapprove(problemId)}>Undo</Button>} />
      )}
    </Confirmation>
  )
}

/**
 * The agent's text. Text of a turn the view saw running shows a few words at a time (reveal.ts). The conversation is a live
 * region, so while words are still coming the part tells the log it is busy (`onBusy`, which sets aria-busy on the log
 * itself: the one place a screen reader looks), and the whole text is announced once, when it is all there.
 */
function TextPart({ id, chat, text, animate, streaming, webFetchHosts, onBusy }: { id: string; chat: string | undefined; text: string; animate: boolean; streaming: boolean; webFetchHosts?: string; onBusy?: (id: string, busy: boolean) => void }) {
  const { shown, done } = useRevealed(text, animate, chat === undefined ? undefined : { chat, id })
  useLayoutEffect(() => {
    if (done || !onBusy) return
    onBusy(id, true)
    return () => onBusy(id, false)
  }, [id, done, onBusy])
  // A partially streamed or revealed bare URL can look like a different destination. While the text is still coming, half-written markdown is closed for the moment.
  const live = streaming || !done
  const linkHosts = live ? [] : parseHostlist(webFetchHosts ?? '') ?? []
  return (
    <div className="max-w-answer-measure min-w-0 text-md leading-reading text-pretty wrap-anywhere"><Markdown text={shown} linkHosts={linkHosts} live={live} /></div>
  )
}

/** `animate`: this part is of a turn the view saw running, so its text is revealed (a part from a saved chat isn't). `chat`: the chat's id, so a part revealed once is not revealed again. `onBusy`: see TextPart. */
export function AgentPart({ part, trace, id, chat, animate = false, streaming = false, onBusy }: { part: MessagePart; trace: string; id: string; chat?: string; animate?: boolean; streaming?: boolean; onBusy?: (id: string, busy: boolean) => void }) {
  const go = useUi(s => s.go)
  const ask = useUi(s => s.ask)
  const retryAnswer = useUi(s => s.retryAnswer)
  const openModelMenu = useUi(s => s.openModelMenu)
  const openTrace = useUi(s => s.openTrace)
  const { S, agent } = useCtx()

  switch (part.type) {
    case 'text':
      return <TextPart id={id} chat={chat} text={part.text} animate={animate} streaming={streaming} webFetchHosts={agent.settings['t:webfetch']} onBusy={onBusy} />

    case 'table': {
      const t = part.table
      return (
        <div className="box-border w-prose-measure max-w-full tabular-nums">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Icon name={t.icon ?? 'local_shipping'} size={16} className="text-foreground" />
            <b className="font-semibold text-foreground">{t.title}</b>· {t.summary}
          </div>
          {/* A wide table scrolls sideways inside the card instead of being cut, by keyboard too. The rows take the
              table's full width, so their lines run under every column. */}
          <div role="region" aria-label={`Table: ${t.title}`} tabIndex={0} className="mt-2 overflow-x-auto border-y border-divider">
            <div className="min-w-fit divide-y divide-divider">
            {t.rows.map(o => (
              <div key={o.order} className="flex min-h-10 items-center gap-2.5 text-sm">
                <span className="w-14 flex-none font-mono text-xs">{o.order}</span>
                <span className="w-14.5 flex-none text-muted-foreground">{o.age}</span>
                <span className="min-w-0 flex-1 text-foreground-2">{o.why}</span>
                <span className="w-12 flex-none text-right font-strong">{o.value}</span>
              </div>
            ))}
            </div>
          </div>
        </div>
      )
    }

    case 'approval':
      return <ApprovalCard problemId={part.problemId} />

    case 'skill':
      return (
        <div className={cn(INSET, 'w-prose-measure')}>
          <CardHead icon="menu_book" iconSize={20} kicker="Created skill" title={part.skill.name} openLabel="Open skill" onOpen={() => go('skills')} />
          <div className="mt-3 text-base leading-normal text-foreground-2">{part.skill.desc}</div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {[`Reads ${part.skill.tools}`, part.skill.mode].map(c => (
              <span key={c} className="inline-flex h-7 items-center rounded-md bg-fill-hover px-2.5 text-xs">{c}</span>
            ))}
          </div>
        </div>
      )

    case 'routine':
      return (
        <div className={cn(INSET, 'w-prose-measure')}>
          <CardHead icon="event_repeat" tile={S === 2 ? 'bg-brand' : 'bg-primary'} kicker="Created routine" title={part.routine.name} openLabel="Open routine" onOpen={() => go('routines')} />
          <div className="mt-3.5 flex items-center gap-2">
            <span className="inline-flex h-7.5 items-center gap-1.5 rounded-lg bg-fill px-2.75 text-sm font-medium">
              <Icon name="schedule" size={16} />{whenOf(part.routine)}
            </span>
          </div>
          <div className="mt-3 text-sm text-muted-foreground">{fmtNextRun(part.routine.next, display())}</div>
          <div className="mt-0.5 text-sm text-muted-foreground">{part.routine.note}</div>
        </div>
      )

    case 'workRow':
      // No time of its own: the thread's time markers say when (UI_BASE_V2 decision 7), so a time never shows twice.
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => openTrace(trace)} aria-label={`${part.text}. See every step`}
              className="-ml-2 flex h-7.5 items-center gap-2 self-start rounded-md pr-1.5 pl-2 text-sm text-foreground-3 hover:bg-fill-hover hover:text-foreground">
              <Icon name="check" size={16} />
              <span>{part.text}</span>
              <Icon name="chevron_right" size={17} />
            </button>
          </TooltipTrigger>
          <TooltipContent>See every step</TooltipContent>
        </Tooltip>
      )

    case 'notInThisStage':
      return (
        <div className="inline-flex min-h-8 items-center gap-1.5 self-start rounded-full border border-dashed border-border-strong px-3 text-sm text-muted-foreground">
          <Icon name="lock" size={14} />{part.text}
        </div>
      )

    // Try again replaces the failed run, so a routine or skill it carried on is updated, not made a second time.
    case 'error':
      return (
        <div className="box-border flex max-w-prose-measure items-center gap-3 text-base leading-normal">
          <Icon name="error" size={19} className="text-destructive" />
          <span className="min-w-0 flex-1">{part.text}</span>
          {MODEL_OFF_TEXTS.includes(part.text) && <Button variant="soft" onClick={() => openModelMenu()}>Pick another model</Button>}
          <Button variant="soft" onClick={() => { retryAnswer(id, trace, part.retryQuestion) }}>Try again</Button>
        </div>
      )

    // The off-script answer's suggested questions (decision D8): each chip asks it.
    case 'suggestions':
      return (
        <div className="flex flex-wrap gap-2 self-start">
          {part.questions.map(q => <SuggestionChip key={q} question={q} onAsk={x => { void ask(x) }} />)}
        </div>
      )

    // Stage 1 M2-H: an action the agent proposed. The card reads itself (`action(id)`) and offers what `can` allows.
    case 'ask':
      return <AskCard actionId={part.actionId} />
  }
}
