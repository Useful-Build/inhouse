// What an action's card says and offers (Stage 1 M2-H, N15, N18), as pure functions: AskCard.tsx draws them. The
// card's own words (`title`, `lines`, `result`, `lapsed`) are the server's; this file adds only the plain labels around
// them. Which buttons show follows the card's `can`, which is for display: the server checks every answer again.
import type { ActionCard, ActionChoice, ActionItem, ActionResolution, ActionState, BatchCovers, Guardrail } from '../../agent/types'
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

/**
 * One button on the card: its label, and what pressing it sends. `key` stays the same while the label changes (a growing
 * batch's count), so a press that started on one label still lands on its button.
 */
export type CardButton =
  | { kind: 'answer'; choice: ActionChoice; label: string; primary: boolean; key: string }
  | { kind: 'undo'; label: string; primary: boolean; key: string }
  | { kind: 'resolve'; outcome: ActionResolution; label: string; primary: boolean; key: string }
  | { kind: 'withdraw'; label: string; primary: boolean; key: string }

/** Why an exact approval is needed, in plain words. */
export const GUARDRAIL_TEXT: Readonly<Record<Guardrail, string>> = {
  money: 'Moves money',
  customer: 'Reaches customers',
  destructive: "Can't be taken back",
  access: 'Changes who has access',
  bulk: 'Changes many records',
  // #492: a count card is either past the day's allowance or larger than one call the permission lets through.
  count: "Past this permission's limit",
  unreviewed: 'Needs a closer look',
  browser: 'Needs a closer look',
}

/** The small line over the title: what the card is asking, or where it got to. */
export function kickerOf(card: ActionCard, whose: Whose = null): string {
  switch (card.state) {
    case 'waiting':
      // Stage 1 M3 (N25): an admins card, as an admin who may answer it sees it, and as its asker does.
      if (card.approverKind === 'admins') {
        if (card.can.approve) return whose === null ? "Needs an admin's approval" : `${cap(whose)} asks an admin`
        return `Waiting for ${whose ?? card.waitingFor ?? 'an admin'}`
      }
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
  // An admins card is answered by any admin (N25): the card can't say who, so it says what happened.
  const admins = card.approverKind === 'admins'
  switch (card.state) {
    case 'waiting': case 'approved': return null
    case 'sending': return card.batch ? 'They are going out now.' : "It's going out now."
    case 'sent': case 'failed': case NEEDS_CHECK: return card.result ?? null
    case 'undone': return admins ? 'It was taken back. Nothing went out.' : `${whose === null ? 'You' : cap(whose)} took it back. Nothing went out.`
    case 'denied': return admins ? "It wasn't approved. Nothing went out." : `${whose === null ? 'You' : cap(whose)} said no. Nothing went out.`
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
    // An ask card's answers and an exact card's are never mixed, whatever `can` says. A batch is always exact (N22).
    const ask = card.kind === 'ask' && !card.batch
    const nudge = ask && card.nudgeAlways && can.alwaysAllow
    const always: CardButton | null = ask && can.alwaysAllow ? { kind: 'answer', choice: 'always', label: 'Always allow', primary: nudge, key: 'always' } : null
    if (always && nudge) out.push(always)
    if (ask && can.allowOnce) out.push({ kind: 'answer', choice: 'once', label: 'Allow once', primary: !nudge, key: 'once' })
    if (always && !nudge) out.push(always)
    if (!ask && can.approve) out.push({ kind: 'answer', choice: 'approve', label: card.batch ? batchApproveLabel(card.batch) : 'Approve', primary: true, key: 'approve' })
    if (can.deny) out.push({ kind: 'answer', choice: 'deny', label: 'No', primary: false, key: 'deny' })
    // Stage 1 M3 (N25): the asker takes back a card someone else answers.
    if (can.withdraw) out.push({ kind: 'withdraw', label: 'Withdraw', primary: false, key: 'withdraw' })
  }
  if (card.state === 'approved' && can.undo) out.push({ kind: 'undo', label: 'Undo', primary: false, key: 'undo' })
  // A batch's unclear items are settled one at a time, in its full list (BatchSheet), never all at once from the card.
  if (card.state === NEEDS_CHECK && can.resolve && !card.batch) {
    out.push({ kind: 'resolve', outcome: 'sent', label: 'It went out', primary: false, key: 'sent' })
    out.push({ kind: 'resolve', outcome: 'failed', label: "It didn't go out", primary: false, key: 'failed' })
  }
  return out
}

// ---------- Stage 1 M3 (N22, N33): batches ----------

type Batch = NonNullable<ActionCard['batch']>

/**
 * A count of what the totals count, in the person's words: "450 orders", "1 order", "2,400 stock units". The server's
 * label is plural; one of them drops its last "s".
 */
export function unitsText(n: number, label: string): string {
  const one = n === 1 && label.endsWith('s') ? label.slice(0, -1) : label
  return `${fmtCount(n, display())} ${one}`
}

/** What the batch's answer covers, in words: "450 orders", or "2,400 stock units, $24.90 (USD)" when it moves money. */
export function coversText(b: Batch): string {
  const units = unitsText(b.totals.units, b.totals.unitsLabel)
  return b.totals.amount ? `${units}, ${b.totals.amount}` : units
}

/** The batch's Approve, naming exactly what it covers (N33): "Approve these 450: 450 orders". */
export function batchApproveLabel(b: Batch): string {
  return `${b.itemCount === 1 ? 'Approve this one' : `Approve these ${fmtCount(b.itemCount, display())}`}: ${coversText(b)}`
}

/**
 * What a batch card's answer sends: the items the card showed (1 to its `itemCount`) and their totals, from the same card
 * whose words were on screen. Undefined for a single card (which sends none).
 */
export function coversOf(card: ActionCard): BatchCovers | undefined {
  if (!card.batch) return undefined
  return { upTo: card.batch.itemCount, totals: { records: card.batch.totals.records, units: card.batch.totals.units } }
}

/** "See all 450": the full list, for a batch with more items than its first lines, or once its items have outcomes. */
export function showsFullList(card: ActionCard): boolean {
  if (!card.batch || card.batch.itemCount === 0) return false
  return card.batch.itemCount > card.batch.firstLines.length || card.state === 'sending' || card.state === 'sent' || card.state === 'failed' || card.state === NEEDS_CHECK
}

/** A finished batch's toast after an approval: how many, and that they start going out (in passes, N22). */
export function batchApprovedToast(upTo: number): string {
  return `Approved ${fmtCount(upTo, display())}. They start going out in a few seconds.`
}

/** What one item of the full list says beside its line, once it has an outcome. Null while it waits. */
export function itemStatus(item: Pick<ActionItem, 'state'>): string | null {
  switch (item.state) {
    case 'pending': return null
    case 'sending': return 'Going out'
    case 'sent': return 'Sent'
    case 'failed': return "Didn't go out"
    case NEEDS_CHECK: return 'Needs a check'
    case 'withdrawn': return 'Withdrawn'
  }
}

/** Items that arrived after the card that was opened (or answered): "12 more arrived while you looked. They wait for their own OK." */
export function moreArrivedText(n: number): string {
  return `${fmtCount(n, display())} more arrived while you looked. ${n === 1 ? 'It waits' : 'They wait'} for ${n === 1 ? 'its' : 'their'} own OK.`
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
export function answeredToast(choice: ActionChoice | 'undo' | 'withdraw' | ActionResolution): string {
  switch (choice) {
    case 'withdraw': return 'Withdrawn. Nothing goes out.'
    case 'once': return 'Allowed once. It goes out in a few seconds.'
    case 'always': return "Allowed. Your Inhouse agent won't ask next time."
    case 'approve': return 'Approved. It goes out in a few seconds.'
    case 'deny': return 'Not approved. Nothing goes out.'
    case 'undo': return 'Taken back. Nothing went out.'
    case 'sent': return 'Marked as sent.'
    case 'failed': return 'Marked as not sent.'
  }
}
