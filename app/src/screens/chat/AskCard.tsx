// An action the agent proposed, as its card (Stage 1 M2-H, N15, N18): in a chat (the `ask` part) and on Approvals. It
// shows the server's words, offers only what `can` allows, counts the hold down from the server's clock, and reads the
// card again when an `action.updated` names it or while it settles (the hold's end, the send: with backoff, through
// failed reads, until it settles). The buttons send the rev the card was read at; a refusal says why, a conflict shows
// the card as it is now, and a refusal with no card in it reads the card again.
// Stage 1 M3-U (N33, N25): a batch shows its first lines, its totals and "See all" (the full list in a sheet that loads
// with its first opening), and its answer covers exactly the items and totals on screen when the press began. A waiting
// batch reads itself every few seconds, since items joining it keep its rev (no `action.updated`). An admins card says
// whom it waits for, and its asker may withdraw it.
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { agent } from '../../agent'
import type { ActionCard } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { NOT_FOUND } from '../../../shared/contract/error-codes'
import { NEEDS_CHECK } from '../../../shared/contract/action-states'
import { useUi } from '../../state/store'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button, Icon } from '../../ui'
import { CONFIRMATION_SHEET } from '../../ui/agent'
import {
  ALWAYS_STAYS, answeredToast, batchApprovedToast, buttonsOf, coversOf, coversText, factsOf, holdLeftMs, holdText, kickerOf, moreArrivedText, outcomeOf,
  refusalOf, settleDelayMs, settling, showsFullList,
} from './ask-card'
import type { CardButton, Whose } from './ask-card'
import { readAsks } from '../../shell/asks-count'
import { fmtCount } from '../../lib/format'
import { display } from '../../state/display'
import type { BatchSheetProps } from './BatchSheet'

/** How often a waiting batch reads itself: items joining it keep its rev, so no `action.updated` names them. */
export const BATCH_REFRESH_MS = 5000

// The full list loads with its first opening, outside Today's first load (scripts/check-bundle.mjs). A module Vite's
// preload-error handling left undefined never settles, so the fallback (nothing) stays until the reload.
const BatchSheet = lazy(async () => {
  const m = await import('./BatchSheet')
  return m === undefined ? new Promise<never>(() => {}) : { default: m.BatchSheet }
})

const GONE_KICKER = 'No longer there'
const GONE_ICON = 'info'
const GONE_TEXT = "This isn't there any more."

/** A card as read, and when (on the browser's clock), so the hold's countdown is the server's gap less the time since. */
interface Read { card: ActionCard; at: number }

const ICON: Record<ActionCard['state'], string> = {
  waiting: 'front_hand', approved: 'schedule', sending: 'schedule_send', sent: 'check_circle', failed: 'error', needs_check: 'info',
  undone: 'undo', denied: 'block', withdrawn: 'block', expired: 'hourglass_empty',
}

/**
 * The chat's `ask` part. The Inhouse team (reading a chat under a support grant) has no actions (route 120 refuses
 * them): the part says an action was proposed and reads nothing.
 */
export function AskPart({ actionId }: { actionId: string }) {
  const inhouse = useSyncExternalStore(agent.subscribe, () => agent.me()?.role === 'inhouse')
  if (inhouse) {
    return <div className={cn(CONFIRMATION_SHEET, 'w-prose-measure text-sm text-muted-foreground')} data-action-card="hidden">Your Inhouse agent proposed an action here. Only the brand's team can see it.</div>
  }
  return <AskCard actionId={actionId} />
}

/**
 * `actionId` names the card; `initial` is the card when the caller has already read it (Approvals' list). `onChange`
 * hears every newer card (an answer, a re-read). `onOpenChat` adds an Open link for a card whose chat this person may
 * open (`chatId` is set). `whose` is the asker's name when the card isn't the viewer's own (ask-card.ts `whoseCard`).
 */
export function AskCard({ actionId, initial, onChange, onOpenChat, whose = null, className }: {
  actionId: string; initial?: ActionCard; onChange?: (card: ActionCard) => void; onOpenChat?: (chatId: string) => void; whose?: Whose; className?: string
}) {
  const [read, setRead] = useState<Read | null>(() => (initial ? { card: initial, at: Date.now() } : null))
  const [failed, setFailed] = useState<string | null>(null)
  // The card is gone on the server (a read answered not found): no button is offered any more.
  const [gone, setGone] = useState(false)
  // Bumped after each settling read, whether it worked or not, so the next one is always scheduled.
  const [settleReads, setSettleReads] = useState(0)
  // This card was answered "Always allow" here: Undo then says the permission stays.
  const [allowedAlways, setAllowedAlways] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Set at once on a press (state lags a render), so a double click can't send twice.
  const pressing = useRef(false)
  // The card on screen when a press began (pointer down): a batch whose count grew before the click lands still answers
  // for what its button said then.
  const pressedOn = useRef<ActionCard | null>(null)
  // The full list is open, with the card as it was when it opened: its answer covers that card's items and totals.
  const [sheet, setSheet] = useState<ActionCard | null>(null)
  // The most items seen on this batch while it waited (its reads, the full list's pages), and how many the answer left
  // for their own card.
  const tipSeen = useRef(initial?.batch?.itemCount ?? 0)
  const [leftOver, setLeftOver] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const showToast = useUi(s => s.showToast)
  const titleId = useId()
  // The newest rev seen, so an older answer arriving late never replaces a newer card.
  const rev = useRef(initial?.rev ?? 0)
  const tries = useRef(0)
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })

  const state = useRef<ActionCard['state'] | null>(initial?.state ?? null)
  const take = useCallback((card: ActionCard) => {
    if (card.rev < rev.current) return
    rev.current = card.rev
    // A card that moved by itself (to "Needs a check", back to waiting, settled) changes what waits on this person.
    if (state.current !== null && state.current !== card.state) void readAsks()
    state.current = card.state
    if (card.state === 'waiting' && card.batch) tipSeen.current = Math.max(tipSeen.current, card.batch.itemCount)
    setRead({ card, at: Date.now() })
    setNow(Date.now())
    setFailed(null)
    onChangeRef.current?.(card)
  }, [])

  const load = useCallback((): Promise<void> => agent.action(actionId).then(take, (e: unknown) => {
    // A first read that failed says so (with Try again). A card already on screen stays; gone, it offers nothing more.
    if (rev.current === 0) setFailed(refusalOf(e).text)
    else if (e instanceof AgentError && e.code === NOT_FOUND) setGone(true)
    else console.warn('Inhouse: could not read the action again.', e)
  }), [actionId, take])

  useEffect(() => { if (!initial) void load() }, [initial, load])
  // An `action.updated` for this card, newer than what is on screen: read it again.
  useEffect(() => agent.onActionUpdated(u => { if (u.actionId === actionId && u.rev > rev.current) load() }), [actionId, load])

  const card = read?.card ?? null
  const left = card && read ? holdLeftMs(card, now - read.at) : null
  // The hold's countdown ticks once a second; at its end, and while it goes out, the card is read again until it settles:
  // with backoff (ask-card.ts `settleDelayMs`), never giving up, and on through a read that failed.
  useEffect(() => {
    if (!card || !settling(card) || gone) { tries.current = 0; return }
    if (left !== null && left > 0) {
      const t = setTimeout(() => setNow(Date.now()), Math.min(1000, left))
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => { tries.current++; void load().finally(() => setSettleReads(n => n + 1)) }, settleDelayMs(tries.current))
    return () => clearTimeout(t)
  }, [card, left, load, now, gone, settleReads])

  // A waiting batch reads itself every few seconds while the page shows (its count and totals grow as items join).
  const growing = !!card && card.state === 'waiting' && !!card.batch && !gone
  useEffect(() => {
    if (!growing) return
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, BATCH_REFRESH_MS)
    return () => clearInterval(t)
  }, [growing, load])

  if (!card) {
    return (
      <div className={cn(CONFIRMATION_SHEET, 'flex w-prose-measure flex-wrap items-center gap-2 text-sm text-muted-foreground', className)} data-action-card="loading" role="status">
        <span className="min-w-0 flex-1">{failed ?? 'Loading the action.'}</span>
        {failed !== null && <Button variant="outline" size="sm" onClick={() => { setFailed(null); void load() }}>Try again</Button>}
      </div>
    )
  }

  /**
   * Sends one press. `shown` is the card whose words were on screen when it began: its rev, and for a batch the items and
   * totals the answer covers (never a newer read's). `item` settles one item of a batch (the full list's).
   */
  const send = (b: CardButton, shown: ActionCard, item?: number) => {
    if (pressing.current) return
    pressing.current = true
    setBusy(true)
    setRefusal(null)
    const covers = coversOf(shown)
    const sent = b.kind === 'answer' ? agent.answerAction(shown.id, shown.rev, b.choice, covers)
      : b.kind === 'undo' ? agent.undoAction(shown.id, shown.rev)
        : b.kind === 'withdraw' ? agent.withdrawAction(shown.id, shown.rev)
          : agent.resolveAction(shown.id, shown.rev, b.outcome, item)
    const before = state.current
    sent.then(next => {
      take(next)
      if (b.kind === 'answer' && b.choice === 'always') setAllowedAlways(true)
      if (b.kind === 'answer' && covers) setLeftOver(Math.max(0, tipSeen.current - covers.upTo))
      // The pressed button is gone with the old state: keep the keyboard on the card (the list stays open for an item).
      if (item === undefined) { setSheet(null); headingRef.current?.focus() }
      // The sidebar's badge counts what waits on this person: read it again (once: `take` already did if the state moved).
      if (state.current === before) void readAsks()
      const words = b.kind === 'answer' && b.choice === 'approve' && covers ? batchApprovedToast(covers.upTo)
        : answeredToast(b.kind === 'answer' ? b.choice : b.kind === 'undo' ? 'undo' : b.kind === 'withdraw' ? 'withdraw' : b.outcome)
      showToast(b.kind === 'undo' && allowedAlways ? `${words} ${ALWAYS_STAYS}` : words, { icon: 'check', ms: 4000 })
    }, (e: unknown) => {
      const r = refusalOf(e)
      setRefusal(r.text)
      // The card as it is now: from the conflict, else read again (the buttons follow the server's card). A conflict means
      // someone or something moved the card first, so the badge reads again (once: `take` already did if the state moved).
      if (r.current) take(r.current)
      else void load()
      // An open list starts again from the card as it is now, so its next answer names what it then shows.
      if (r.current) setSheet(s => (s ? r.current : s))
      if (e instanceof AgentError && e.code === 'conflict' && state.current === before) void readAsks()
    }).finally(() => { pressing.current = false; setBusy(false) })
  }
  const press = (b: CardButton) => { const shown = pressedOn.current ?? card; pressedOn.current = null; send(b, shown) }

  const buttons = gone ? [] : buttonsOf(card)
  // A card gone from the server (not found on a read) no longer says where it was: it may have gone out or not.
  const outcome = gone ? GONE_TEXT : outcomeOf(card, whose)
  const alwaysStays = allowedAlways && card.state === 'undone'
  const holdLine = !gone && left !== null ? holdText(left) : null
  const waitingLapse = card.state === 'waiting' && card.lapsed
  const batch = card.batch
  const fullList = !gone && showsFullList(card)
  const sheetProps: BatchSheetProps | null = sheet && {
    card, opened: sheet, whose, busy, refusal,
    onClose: () => setSheet(null),
    onSawTip: n => { tipSeen.current = Math.max(tipSeen.current, n) },
    onAnswer: b => send(b, sheet),
    onResolve: (outcome, n) => send({ kind: 'resolve', outcome, label: '', primary: false, key: 'item' }, card, n),
  }
  return (
    <div role="group" aria-labelledby={titleId} data-action-card={gone ? 'gone' : card.state} data-action-id={card.id}
      className={cn(CONFIRMATION_SHEET, 'flex w-prose-measure flex-col', className)}>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="flex size-10 flex-none items-center justify-center rounded-full border border-border bg-draft-kind text-foreground-3">
          <Icon name={gone ? GONE_ICON : ICON[card.state]} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn('text-sm', card.state === NEEDS_CHECK && !gone ? 'font-medium text-warning-text' : 'text-muted-foreground')}>{gone ? GONE_KICKER : kickerOf(card, whose)}</div>
          <h3 id={titleId} ref={headingRef} tabIndex={-1} className="text-md font-strong tracking-card wrap-anywhere outline-none">{card.title}</h3>
        </div>
        {onOpenChat && card.chatId && (
          <button type="button" onClick={() => onOpenChat(card.chatId!)} aria-label={`Open the chat: ${card.title}`}
            className="flex flex-none items-center gap-0.5 self-center text-base text-foreground-3 hover:text-foreground">
            Open<Icon name="chevron_right" size={18} />
          </button>
        )}
      </div>
      {card.lines.length > 0 && (
        <ul className="m-0 mt-3 list-none rounded-xl bg-draft-kind px-3.5 py-2.5 text-sm leading-prose text-foreground-2 wrap-anywhere" data-card-lines>
          {card.lines.map((l, i) => <li key={`${i}|${l}`}>{l}</li>)}
          {batch && batch.itemCount > card.lines.length && (
            <li className="text-muted-foreground">{`and ${fmtCount(batch.itemCount - card.lines.length, display())} more`}</li>
          )}
        </ul>
      )}
      {batch && batch.itemCount > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" data-batch-totals>
          <span className="min-w-0 flex-1 text-foreground-2"><span className="text-muted-foreground">In all: </span><span className="font-strong">{coversText(batch)}</span></span>
          {fullList && (
            <Button variant="outline" size="sm" onPointerDown={() => { pressedOn.current = card }}
              onClick={() => { const shown = pressedOn.current ?? card; pressedOn.current = null; setSheet(shown) }}
              aria-haspopup="dialog" aria-label={`See all ${fmtCount(batch.itemCount, display())}: ${card.title}`}>
              {`See all ${fmtCount(batch.itemCount, display())}`}
            </Button>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {factsOf(card).map((f, i) => <Badge key={f} variant={i === 0 ? 'status' : 'warning'} size="lg">{f}</Badge>)}
      </div>
      {waitingLapse && <p className="m-0 mt-3 text-sm text-warning-text">{card.lapsed}</p>}
      {outcome && <p className="m-0 mt-3 text-sm font-strong text-foreground-2">{outcome}</p>}
      {alwaysStays && <p className="m-0 mt-1 text-sm text-foreground-2">{ALWAYS_STAYS}</p>}
      {leftOver > 0 && card.state !== 'waiting' && <p className="m-0 mt-1 text-sm text-foreground-2" data-left-over>{moreArrivedText(leftOver)} They're in Approvals.</p>}
      {holdLine && (
        <p className="m-0 mt-3 flex items-center gap-2 text-sm font-strong" data-hold>
          <Icon name="schedule" size={17} /><span role="timer" aria-live="off">{holdLine}</span>
        </p>
      )}
      {buttons.length > 0 && (
        <div data-card-actions className="mt-3 flex flex-wrap gap-2">
          {buttons.map(b => (
            <Button key={b.key} variant={b.primary ? 'primary' : 'soft'} disabled={busy} onPointerDown={() => { pressedOn.current = card }} onClick={() => press(b)}
              aria-label={b.kind === 'answer' ? undefined : `${b.label}: ${card.title}`}>{b.label}</Button>
          ))}
        </div>
      )}
      {/* A batch's unclear items are settled one at a time, in its full list. */}
      {buttons.length === 0 && batch && card.state === NEEDS_CHECK && card.can.resolve && !gone && (
        <div data-card-actions className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setSheet(card)} aria-haspopup="dialog">Check each change</Button>
        </div>
      )}
      {refusal && !sheet && <p role="alert" className="m-0 mt-3 text-sm text-destructive-text">{refusal}</p>}
      {sheetProps && <Suspense fallback={null}><BatchSheet {...sheetProps} /></Suspense>}
    </div>
  )
}
