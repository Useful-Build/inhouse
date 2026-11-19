// One run's event stream. The root stamps every event with the run's id and the next `seq` (0, 1, 2, ... with no gaps),
// and closes the stream at the first terminal event: anything after it is dropped, so a run has exactly one end.
import { TERMINAL_EVENTS, type RunEvent, type RunEventBody } from '../../../shared/protocol/index.ts'

export class RunStream {
  #seq = 0
  #ended = false
  readonly runId: string
  readonly #sink: (event: RunEvent) => void

  constructor(runId: string, sink: (event: RunEvent) => void) {
    this.runId = runId
    this.#sink = sink
  }

  get ended(): boolean {
    return this.#ended
  }

  /** Stamps and writes one event. Returns null (and writes nothing) once the run has ended. */
  emit(body: RunEventBody): RunEvent | null {
    if (this.#ended) return null
    const event: RunEvent = { runId: this.runId, seq: this.#seq++, ...body }
    if (TERMINAL_EVENTS.has(body.type)) this.#ended = true
    this.#sink(event)
    return event
  }
}
