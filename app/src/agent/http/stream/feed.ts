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

/** The envelope's fields, checked by hand: null when it isn't one. */
function envelopeOf(raw: unknown): { v: number; runId: string; seq: number; at: { iso: string; ms: number }; event: unknown } | null {
  if (!isRec(raw)) return null
  const { v, runId, seq, at, event } = raw
  if (typeof v !== 'number' || !Number.isInteger(v)) return null
  if (typeof runId !== 'string' || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null
  if (!isRec(at) || typeof at.iso !== 'string' || typeof at.ms !== 'number') return null
  return { v, runId, seq, at: { iso: at.iso, ms: at.ms }, event }
}

export class RunFeed {
  private last = 0
  private ahead = new Map<number, NonNullable<ReturnType<typeof envelopeOf>>>()
  private skipLogged = false
  private reloading = false

  readonly runId: string
  private readonly parts: FeedParts
  constructor(runId: string, parts: FeedParts, fromSeq = 0) { this.runId = runId; this.parts = parts; this.last = fromSeq }

  /** The last seq delivered or skipped with every earlier one: where a re-attach starts (`fromSeq`). */
  get contiguous(): number { return this.last }
  get reloadAsked(): boolean { return this.reloading }

  push(raw: unknown): Pushed {
    const out: FeedOut[] = []
    if (this.reloading) return { out, reattachFrom: null }
    const env = envelopeOf(raw)
    // A frame that isn't an envelope at all can't be placed: drop it (the next frame's gap re-attaches if one was lost).
    if (!env || env.runId !== this.runId) return { out, reattachFrom: null }
    if (!this.parts.accepts(env.v)) {
      this.reloading = true
      return { out: [{ kind: 'reload' }], reattachFrom: null }
    }
    // Seen already: dropped. A gap that is still open still asks to be filled.
    if (env.seq <= this.last || this.ahead.has(env.seq)) return { out, reattachFrom: this.ahead.size > 0 ? this.last : null }
    this.ahead.set(env.seq, env)
    for (let next = this.ahead.get(this.last + 1); next; next = this.ahead.get(this.last + 1)) {
      this.ahead.delete(next.seq)
      this.last = next.seq
      const event = this.parts.parseEvent(next.event)
      if (event) out.push({ kind: 'event', runId: this.runId, seq: next.seq, at: next.at, event })
      else if (!this.skipLogged) { this.skipLogged = true; this.parts.logSkip?.(next.seq) }
    }
    return { out, reattachFrom: this.ahead.size > 0 ? this.last : null }
  }

  /** The socket dropped, or the server's `attached` says it holds more than this feed has: where to attach from. */
  reattachFrom(): number { return this.last }
}
