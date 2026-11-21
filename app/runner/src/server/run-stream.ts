// One run's event stream. The root stamps every event with the run's id and the next `seq` (0, 1, 2, ... with no gaps).
// The first terminal event ends the run's body: after it only `released` (once, the run's last event) is stamped, so a
// run has exactly one end and one release.
import { TERMINAL_EVENTS, type RunEvent, type RunEventBody } from '../../../shared/protocol/index.ts'

type Released = Extract<RunEventBody, { type: 'released' }>

export class RunStream {
  #seq = 0
  #ended = false
  #released = false
  readonly runId: string
  readonly #sink: (event: RunEvent) => void

  constructor(runId: string, sink: (event: RunEvent) => void) {
    this.runId = runId
    this.#sink = sink
  }

  /** A terminal event went out. */
  get ended(): boolean {
    return this.#ended
  }

  get released(): boolean {
    return this.#released
  }

  /** The last seq stamped (null before the first). */
  get lastSeq(): number | null {
    return this.#seq === 0 ? null : this.#seq - 1
  }

  /** Stamps and writes one event. Returns null (and writes nothing) once the run has ended; `released` goes by `release`. */
  emit(body: Exclude<RunEventBody, Released>): RunEvent | null {
    if (this.#ended) return null
    const event: RunEvent = { runId: this.runId, seq: this.#seq++, ...body }
    if (TERMINAL_EVENTS.has(body.type)) this.#ended = true
    this.#sink(event)
    return event
  }

  /** The run's last event, after its terminal one. Returns null when it isn't ended yet or was released already. */
  release(body: Omit<Released, 'type'>): RunEvent | null {
    if (!this.#ended || this.#released) return null
    this.#released = true
    const event: RunEvent = { runId: this.runId, seq: this.#seq++, type: 'released', ...body }
    this.#sink(event)
    return event
  }
}
