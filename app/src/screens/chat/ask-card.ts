// What an action's card says and offers (Stage 1 M2-H, N15, N18), as pure functions: AskCard.tsx draws them. The
// card's own words (`title`, `lines`, `result`, `lapsed`) are the server's; this file adds only the plain labels around
// them. Which buttons show follows the card's `can`, which is for display: the server checks every answer again.
import type { ActionCard, ActionChoice, ActionResolution, ActionState, Guardrail } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { NEEDS_CHECK } from '../../../shared/contract/action-states'
import { NOT_FOUND } from '../../../shared/contract/error-codes'
import { fmtCount } from '../../lib/format'
import { display } from '../../state/display'

/** What Approvals lists: what waits for an answer, what is in its hold or going out, and what needs a check. */
export const OPEN_STATES: ActionState[] = ['waiting', 'approved', 'sending', NEEDS_CHECK]

/**
 * How long a settling card waits before its next read: every 2 s for the first 15 reads (30 s, the dispatcher's limit
 * twice over), then twice as long each time, up to 30 s. It never stops on its own: a card in its hold or going out
 * reads itself until it settles, whatever reads fail on the way (no server event is relied on).
 */
export const SETTLE_EVERY_MS = 2000
export const SETTLE_FAST_TRIES = 15
export const SETTLE_MAX_MS = 30_000
export function settleDelayMs(tries: number): number {
  if (tries < SETTLE_FAST_TRIES) return SETTLE_EVERY_MS
  return Math.min(SETTLE_MAX_MS, SETTLE_EVERY_MS * 2 ** (tries - SETTLE_FAST_TRIES + 1))
}

/**
 * Whose card it is, as the words say it: null for the viewer's own (the card says "you"), else the asker's name (an
 * admin sees a member's card on Approvals and in Activity, N15).
 */
export type Whose = string | null

/** The asker's name for a card that isn't the viewer's, else null. An unknown name is "a teammate". */
export function whoseCard(card: ActionCard, meId: string | undefined, nameOf: (id: string) => string | undefined): Whose {
  if (meId === undefined || card.askedBy === meId) return null
  return nameOf(card.askedBy) ?? 'a teammate'
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** One button on the card: its label, and what pressing it sends. */
export type CardButton =
  | { kind: 'answer'; choice: ActionChoice; label: string; primary: boolean }
  | { kind: 'undo'; label: string; primary: boolean }
  | { kind: 'resolve'; outcome: ActionResolution; label: string; primary: boolean }

/** Why an exact approval is needed, in plain words. */
export const GUARDRAIL_TEXT: Readonly<Record<Guardrail, string>> = {
  money: 'Moves money',
  customer: 'Reaches customers',
  destructive: "Can't be taken back",
  access: 'Changes who has access',
  bulk: 'Changes many records',
  count: "Today's allowance is used up",
  unreviewed: 'Needs a closer look',
  browser: 'Needs a closer look',
}

/** The small line over the title: what the card is asking, or where it got to. */
export function kickerOf(card: ActionCard, whose: Whose = null): string {
  switch (card.state) {
    case 'waiting':
      if (whose !== null) return `Waiting for ${whose}`
      return card.kind === 'exact' ? 'Needs your approval' : 'Your Inhouse agent asks first'
    case 'approved': return 'Approved'
    case 'sending': return 'Going out now'
    case 'sent': return 'Done'
    case 'failed': return "Didn't go out"
    case NEEDS_CHECK: return 'Needs a check'
    case 'undone': return 'Taken back'
    case 'denied': return 'Not approved'
    case 'withdrawn': return 'Withdrawn'
    case 'expired': return 'Expired'
  }
}

/** The facts under the title: the tool, how many records, and what makes it sensitive. Never connector output. */
export function factsOf(card: ActionCard): string[] {
  const facts = [card.tool.label]
  if (card.records > 1) facts.push(`${fmtCount(card.records, display())} records`)
  if (card.reachesCustomer && card.guardrail !== 'customer') facts.push('Reaches customers')
  if (!card.reversible && card.guardrail !== 'destructive') facts.push("Can't be taken back")
  if (card.guardrail) facts.push(GUARDRAIL_TEXT[card.guardrail])
  return facts
}

/** What the card says once it isn't waiting for an answer (null while it waits, or in its hold). */
export function outcomeOf(card: ActionCard, whose: Whose = null): string | null {
  switch (card.state) {
    case 'waiting': case 'approved': return null
    case 'sending': return "It's going out now."
    case 'sent': case 'failed': case NEEDS_CHECK: return card.result ?? null
    case 'undone': return `${whose === null ? 'You' : cap(whose)} took it back. Nothing went out.`
    case 'denied': return `${whose === null ? 'You' : cap(whose)} said no. Nothing went out.`
    case 'withdrawn': return card.lapsed ?? 'It was withdrawn. Nothing went out.'
    case 'expired': return card.lapsed ?? 'No one answered in 7 days. Nothing went out.'
  }
}

/**
 * The buttons, from `can` and the card's kind (N15): Allow once, Always allow and No on an ask card (Always allow first when the server
 * nudges it), Approve and No on an exact one, Undo in the hold, and the two answers to "Needs a check".
 */
export function buttonsOf(card: ActionCard): CardButton[] {
  const { can } = card
  const out: CardButton[] = []
  if (card.state === 'waiting') {
    // An ask card's answers and an exact card's are never mixed, whatever `can` says.
    const ask = card.kind === 'ask'
    const nudge = ask && card.nudgeAlways && can.alwaysAllow
    const always: CardButton | null = ask && can.alwaysAllow ? { kind: 'answer', choice: 'always', label: 'Always allow', primary: nudge } : null
    if (always && nudge) out.push(always)
    if (ask && can.allowOnce) out.push({ kind: 'answer', choice: 'once', label: 'Allow once', primary: !nudge })
    if (always && !nudge) out.push(always)
    if (!ask && can.approve) out.push({ kind: 'answer', choice: 'approve', label: 'Approve', primary: true })
    if (can.deny) out.push({ kind: 'answer', choice: 'deny', label: 'No', primary: false })
  }
  if (card.state === 'approved' && can.undo) out.push({ kind: 'undo', label: 'Undo', primary: false })
  if (card.state === NEEDS_CHECK && can.resolve) {
    out.push({ kind: 'resolve', outcome: 'sent', label: 'It went out', primary: false })
    out.push({ kind: 'resolve', outcome: 'failed', label: "It didn't go out", primary: false })
  }
  return out
}

/**
 * How long the hold has left, in ms, from the server's own clock: the gap between `sendAt` and `serverNow` when the card
 * was read, less the time since (`elapsedMs`, on the browser's clock). Null when the card isn't in its hold. No browser
 * timer decides a send: this only draws the countdown, and the server answers Undo.
 */
export function holdLeftMs(card: ActionCard, elapsedMs: number): number | null {
  if (card.state !== 'approved' || !card.sendAt) return null
  return Math.max(0, card.sendAt.ms - card.serverNow.ms - Math.max(0, elapsedMs))
}

/** The hold's line: "Goes out in 8 seconds", then "Going out now". */
export function holdText(leftMs: number): string {
  const s = Math.ceil(leftMs / 1000)
  if (s <= 0) return 'Going out now'
  return `Goes out in ${s} ${s === 1 ? 'second' : 'seconds'}`
}

/** What Undo after "Always allow" adds: Undo takes back this action only, and the permission stays. */
export const ALWAYS_STAYS = 'Always allow stays on. Remove it in Settings, Always allowed.'

/** A card whose state will change by itself soon (the hold ending, the send): read again until it settles. */
export const settling = (card: ActionCard): boolean => card.state === 'approved' || card.state === 'sending'

/**
 * What the card says when an answer was refused. A conflict's card as it is now replaces the old one (`current`); with
 * no `current` (or any other refusal), the card reads itself again so its buttons are the server's.
 */
export function refusalOf(e: unknown): { text: string; current: ActionCard | null } {
  if (!(e instanceof AgentError)) return { text: 'Something went wrong. Try again.', current: null }
  const current = e.code === 'conflict' && e.current ? (e.current as unknown as ActionCard) : null
  if (e.code === 'conflict') return { text: current ? 'This changed before your answer arrived. Here it is now.' : 'This changed before your answer arrived.', current }
  if (e.code === 'forbidden') return { text: "You can't answer this one.", current: null }
  if (e.code === NOT_FOUND) return { text: "This isn't there any more.", current: null }
  return { text: e.message, current: null }
}

/** The toast after an answer went through. */
export function answeredToast(choice: ActionChoice | 'undo' | ActionResolution): string {
  switch (choice) {
    case 'once': return 'Allowed once. It goes out in a few seconds.'
    case 'always': return "Allowed. Your Inhouse agent won't ask next time."
    case 'approve': return 'Approved. It goes out in a few seconds.'
    case 'deny': return 'Not approved. Nothing goes out.'
    case 'undo': return 'Taken back. Nothing went out.'
    case 'sent': return 'Marked as sent.'
    case 'failed': return 'Marked as not sent.'
  }
}
