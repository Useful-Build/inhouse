// The thread's markers (UI_BASE_V2 decision 7), worked out from the messages alone: a time before the first message, after a
// gap of an hour or more and at a day change, and "Switched to <model>" when an answer's model differs from the answer before.
// A marker goes before a block of the thread: a question, a note, or an answer turn (agent messages in a row, one card).
import type { ChatMessage } from '../../agent/types'
import { daysBefore, msOf, type Display } from '../../lib/format'

export type ThreadMarker = { kind: 'time'; at: number } | { kind: 'model'; model: string }

/** A gap between turns this long or longer gets a time marker. */
export const MARKER_GAP_MS = 60 * 60_000

/**
 * The markers before each block, keyed by the block's first message id. Messages without a time (sample answers, notes) never
 * start a time marker and don't move the clock; messages without a model don't count for a switch. A block gets at most one
 * of each kind, the time first.
 */
export function threadMarkers(msgs: readonly ChatMessage[], d: Display): Map<string, ThreadMarker[]> {
  const out = new Map<string, ThreadMarker[]>()
  let lastAt: number | undefined
  let lastModel: string | undefined
  let block = ''
  let modelSeen = false
  let prevRole: ChatMessage['role'] | undefined
  const put = (id: string, m: ThreadMarker) => out.set(id, [...(out.get(id) ?? []), m])
  for (const m of msgs) {
    const starts = m.role !== 'agent' || prevRole !== 'agent'
    if (starts) { block = m.id; modelSeen = false }
    prevRole = m.role
    const at = m.role === 'event' || m.at === undefined ? undefined : msOf(m.at)
    // Only a block's first message can carry a time marker: one inside an answer's card has nowhere to show.
    if (starts && at !== undefined && (lastAt === undefined || at - lastAt >= MARKER_GAP_MS || daysBefore(lastAt, at, d) !== 0)) put(block, { kind: 'time', at })
    if (at !== undefined) lastAt = at
    if (m.role === 'agent' && m.model !== undefined) {
      // The model an answer turn opens with, against the one before it: a change inside one card isn't marked.
      if (!modelSeen && lastModel !== undefined && m.model !== lastModel) put(block, { kind: 'model', model: m.model })
      modelSeen = true
      lastModel = m.model
    }
  }
  return out
}
