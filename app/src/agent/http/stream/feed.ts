// A run's frames, as the browser takes them (p3-design section 2, "Version-first decode"). One `RunFeed` per attached run:
//  - the envelope is read first: a version this build doesn't accept asks for a reload, nothing else changes;
//  - an accepted version whose event doesn't parse advances `seq`, is skipped and logged once (never a re-attach loop);
//  - a `(runId, seq)` already seen is dropped, a frame ahead of the next seq waits and asks for a re-attach from the last
//    contiguous seq, so the events leave in order and each exactly once.
// Plain code: no zod (the schemas load only where they parse, see http/schemas.ts), so the store can use it.
import type { ChatEvent } from '../../../../shared/contract/runs'

/** What the client needs to read a frame: whether it knows version `v`, and the event parser (null when it can't read it). */
export interface FeedParts {
  accepts(v: number): boolean
  parseEvent(raw: unknown): ChatEvent | null
  /** Called once per feed, for the first event it couldn't read. */
  logSkip?(seq: number): void
}

/** What a feed hands on, in order. */
export type FeedOut =
  | { kind: 'event'; runId: string; seq: number; at: { iso: string; ms: number }; event: ChatEvent }
  /** A frame of a version this build can't read: the person is asked to reload. Nothing after it is read. */
  | { kind: 'reload' }

export interface Pushed {
  out: FeedOut[]
  /** A frame ahead of the next seq arrived: attach again from `from` (the last contiguous seq). */
  reattachFrom: number | null
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Frames that may wait ahead of the next seq: a replay sends 500 at a time, so this is room for several. A frame past it is dropped; the gap stays and a re-attach fills it. */
const AHEAD_MAX = 2000

/** What waits for its turn: the frame's place, and its event when the rest of the envelope read (null when it didn't: an unreadable event). */
interface Waiting { seq: number; at: { iso: string; ms: number } | null; event: unknown }

const isInstantLike = (v: unknown): v is { iso: string; ms: number } => isRec(v) && typeof v.iso === 'string' && typeof v.ms === 'number'

export class RunFeed {
  private last = 0
  private ahead = new Map<number, Waiting>()
  private skipLogged = false
  private reloading = false
  /** The contiguous seq a re-attach was already asked from: one ask per gap, however many frames land beyond it. */
  private askedFrom: number | null = null
  readonly runId: string
  private readonly parts: FeedParts
  constructor(runId: string, parts: FeedParts, fromSeq = 0) { this.runId = runId; this.parts = parts; this.last = fromSeq }

  /** The last seq delivered or skipped with every earlier one: where a re-attach starts (`fromSeq`). */
  get contiguous(): number { return this.last }
  get reloadAsked(): boolean { return this.reloading }

  push(raw: unknown): Pushed {
    const out: FeedOut[] = []
    if (this.reloading) return { out, reattachFrom: null }
    if (!isRec(raw)) return { out, reattachFrom: null }
    // The version is read first, before anything else in the frame: one this build doesn't accept asks for a reload.
    if (typeof raw.v !== 'number' || !Number.isInteger(raw.v)) return { out, reattachFrom: null }
    if (!this.parts.accepts(raw.v)) {
      this.reloading = true
      return { out: [{ kind: 'reload' }], reattachFrom: null }
    }
    // A frame that can't be placed (another run, no seq) is dropped. One that can be placed but whose envelope doesn't read is an
    // unreadable event: its seq advances, it is skipped and logged once, and nothing re-attaches for it (design section 2).
    const { runId, seq } = raw
    if (runId !== this.runId || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return { out, reattachFrom: null }
    // Seen already: dropped. A gap that is still open asks once, not again.
    if (seq <= this.last || this.ahead.has(seq)) return { out, reattachFrom: this.ask() }
    if (this.ahead.size >= AHEAD_MAX && seq > this.last + 1) return { out, reattachFrom: this.ask() }
    const placed = typeof raw.chatId === 'string' && isInstantLike(raw.at)
    this.ahead.set(seq, { seq, at: placed ? (raw.at as { iso: string; ms: number }) : null, event: raw.event })
    for (let next = this.ahead.get(this.last + 1); next; next = this.ahead.get(this.last + 1)) {
      this.ahead.delete(next.seq)
      this.last = next.seq
      const event = next.at ? this.parts.parseEvent(next.event) : null
      if (event && next.at) out.push({ kind: 'event', runId: this.runId, seq: next.seq, at: next.at, event })
      else if (!this.skipLogged) { this.skipLogged = true; this.parts.logSkip?.(next.seq) }
    }
    return { out, reattachFrom: this.ask() }
  }

  /** The seq to attach from while a gap is open, once per gap; null when nothing waits or it was asked already. */
  private ask(): number | null {
    if (this.ahead.size === 0 || this.askedFrom === this.last) return null
    this.askedFrom = this.last
    return this.last
  }

  /** The socket dropped, or the server's `attached` says it holds more than this feed has: where to attach from. A new attach may be asked for again. */
  reattachFrom(): number {
    this.askedFrom = null
    return this.last
  }
}
