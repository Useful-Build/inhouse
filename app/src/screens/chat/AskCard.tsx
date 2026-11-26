// An action the agent proposed, as its card (Stage 1 M2-H, N15, N18): in a chat (the `ask` part) and on Approvals. It
// shows the server's words, offers only what `can` allows, counts the hold down from the server's clock, and reads the
// card again when an `action.updated` names it or while it settles (the hold's end, the send). The buttons send the rev
// the card was read at; a refusal says why, and a conflict shows the card as it is now.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { agent } from '../../agent'
import type { ActionCard } from '../../agent/types'
import { NEEDS_CHECK } from '../../../shared/contract/action-states'
import { useUi } from '../../state/store'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button, Icon } from '../../ui'
import { CONFIRMATION_SHEET } from '../../ui/agent'
import { SETTLE_EVERY_MS, SETTLE_TRIES, answeredToast, buttonsOf, factsOf, holdLeftMs, holdText, kickerOf, outcomeOf, refusalOf, settling } from './ask-card'
import type { CardButton } from './ask-card'

/** A card as read, and when (on the browser's clock), so the hold's countdown is the server's gap less the time since. */
interface Read { card: ActionCard; at: number }

const ICON: Record<ActionCard['state'], string> = {
  waiting: 'front_hand', approved: 'schedule', sending: 'schedule_send', sent: 'check_circle', failed: 'error', needs_check: 'info',
  undone: 'undo', denied: 'block', withdrawn: 'block', expired: 'hourglass_empty',
}

/**
 * `actionId` names the card; `initial` is the card when the caller has already read it (Approvals' list). `onChange`
 * hears every newer card (an answer, a re-read). `onOpenChat` adds an Open link for a card whose chat this person may
 * open (`chatId` is set).
 */
export function AskCard({ actionId, initial, onChange, onOpenChat, className }: {
  actionId: string; initial?: ActionCard; onChange?: (card: ActionCard) => void; onOpenChat?: (chatId: string) => void; className?: string
}) {
  const [read, setRead] = useState<Read | null>(() => (initial ? { card: initial, at: Date.now() } : null))
  const [failed, setFailed] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const showToast = useUi(s => s.showToast)
  const titleId = useId()
  // The newest rev seen, so an older answer arriving late never replaces a newer card.
  const rev = useRef(initial?.rev ?? 0)
  const tries = useRef(0)
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })

  const take = useCallback((card: ActionCard) => {
    if (card.rev < rev.current) return
    rev.current = card.rev
    setRead({ card, at: Date.now() })
    setNow(Date.now())
    setFailed(null)
    onChangeRef.current?.(card)
  }, [])

  const load = useCallback(() => {
    agent.action(actionId).then(take, (e: unknown) => {
      // A card already on screen stays; only a first read that failed says so.
      if (rev.current === 0) setFailed(refusalOf(e).text)
    })
  }, [actionId, take])

  useEffect(() => { if (!initial) load() }, [initial, load])
  // An `action.updated` for this card, newer than what is on screen: read it again.
  useEffect(() => agent.onActionUpdated(u => { if (u.actionId === actionId && u.rev > rev.current) load() }), [actionId, load])

  const card = read?.card ?? null
  const left = card && read ? holdLeftMs(card, now - read.at) : null
  // The hold's countdown ticks once a second; at its end, and while it goes out, the card is read again until it settles.
  useEffect(() => {
    if (!card || !settling(card)) { tries.current = 0; return }
    if (left !== null && left > 0) {
      const t = setTimeout(() => setNow(Date.now()), Math.min(1000, left))
      return () => clearTimeout(t)
    }
    if (tries.current >= SETTLE_TRIES) return
    const t = setTimeout(() => { tries.current++; load() }, SETTLE_EVERY_MS)
    return () => clearTimeout(t)
  }, [card, left, load, now])

  if (!card) {
    return (
      <div className={cn(CONFIRMATION_SHEET, 'w-prose-measure text-sm text-muted-foreground', className)} data-action-card="loading" role="status">
        {failed ?? 'Loading the action.'}
      </div>
    )
  }

  const press = (b: CardButton) => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    const sent = b.kind === 'answer' ? agent.answerAction(card.id, card.rev, b.choice)
      : b.kind === 'undo' ? agent.undoAction(card.id, card.rev)
        : agent.resolveAction(card.id, card.rev, b.outcome)
    sent.then(next => {
      take(next)
      showToast(answeredToast(b.kind === 'answer' ? b.choice : b.kind === 'undo' ? 'undo' : b.outcome), { icon: 'check', ms: 4000 })
    }, (e: unknown) => {
      const r = refusalOf(e)
      setRefusal(r.text)
      if (r.current) take(r.current)
    }).finally(() => setBusy(false))
  }

  const buttons = buttonsOf(card)
  const outcome = outcomeOf(card)
  const holdLine = left !== null ? holdText(left) : null
  const waitingLapse = card.state === 'waiting' && card.lapsed
  return (
    <div role="group" aria-labelledby={titleId} data-action-card={card.state} data-action-id={card.id}
      className={cn(CONFIRMATION_SHEET, 'flex w-prose-measure flex-col', className)}>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="flex size-10 flex-none items-center justify-center rounded-full border border-border bg-draft-kind text-foreground-3">
          <Icon name={ICON[card.state]} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn('text-sm', card.state === NEEDS_CHECK ? 'font-medium text-warning-text' : 'text-muted-foreground')}>{kickerOf(card)}</div>
          <h3 id={titleId} className="text-md font-strong tracking-card wrap-anywhere">{card.title}</h3>
        </div>
        {onOpenChat && card.chatId && (
          <button type="button" onClick={() => onOpenChat(card.chatId!)} aria-label={`Open the chat: ${card.title}`}
            className="flex flex-none items-center gap-0.5 self-center text-base text-foreground-3 hover:text-foreground">
            Open<Icon name="chevron_right" size={18} />
          </button>
        )}
      </div>
      {card.lines.length > 0 && (
        <ul className="m-0 mt-3 list-none rounded-xl bg-draft-kind px-3.5 py-2.5 text-sm leading-prose text-foreground-2 wrap-anywhere">
          {card.lines.map((l, i) => <li key={`${i}|${l}`}>{l}</li>)}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {factsOf(card).map((f, i) => <Badge key={f} variant={i === 0 ? 'status' : 'warning'} size="lg">{f}</Badge>)}
      </div>
      {waitingLapse && <p className="m-0 mt-3 text-sm text-warning-text">{card.lapsed}</p>}
      {outcome && <p className="m-0 mt-3 text-sm font-strong text-foreground-2">{outcome}</p>}
      {holdLine && (
        <p className="m-0 mt-3 flex items-center gap-2 text-sm font-strong" data-hold>
          <Icon name="schedule" size={17} /><span role="timer" aria-live="off">{holdLine}</span>
        </p>
      )}
      {buttons.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {buttons.map(b => (
            <Button key={b.label} variant={b.primary ? 'primary' : 'soft'} disabled={busy} onClick={() => press(b)}
              aria-label={b.kind === 'answer' ? undefined : `${b.label}: ${card.title}`}>{b.label}</Button>
          ))}
        </div>
      )}
      {refusal && <p role="alert" className="m-0 mt-3 text-sm text-destructive-text">{refusal}</p>}
    </div>
  )
}
