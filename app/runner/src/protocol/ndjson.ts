// NDJSON framing for the local channel between the root runner and a session process: one JSON value per line, each
// line capped. The reader never throws: a line that is too long, not UTF-8 or not JSON comes back as an error result,
// and the reader stops there (the caller ends the session). No zod here, so a plain-Node fixture can import it.

/** The largest line either side accepts. The session caps SDK messages (256 KiB) well under it before sending. */
export const LOCAL_LINE_MAX_BYTES = 1024 * 1024

export type LineResult = { ok: true; value: unknown } | { ok: false; error: string }

const NEWLINE = 0x0a
const utf8 = new TextDecoder('utf-8', { fatal: true })

export class LineReader {
  readonly maxBytes: number
  #parts: Buffer[] = []
  #size = 0
  #failed = false

  constructor(maxBytes: number = LOCAL_LINE_MAX_BYTES) {
    this.maxBytes = maxBytes
  }

  get failed(): boolean {
    return this.#failed
  }

  /** Feeds bytes. Returns the lines they complete, parsed; after the first error, returns that error and then nothing. */
  push(chunk: Buffer): LineResult[] {
    if (this.#failed) return []
    const out: LineResult[] = []
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(NEWLINE, start)
      if (nl === -1) break
      const piece = chunk.subarray(start, nl)
      if (this.#size + piece.length > this.maxBytes) return this.#fail(out, 'line over the size cap')
      const line = this.#size === 0 ? piece : Buffer.concat([...this.#parts, piece])
      this.#parts = []
      this.#size = 0
      start = nl + 1
      const parsed = parseLine(line)
      out.push(parsed)
      if (!parsed.ok) {
        this.#failed = true
        return out
      }
    }
    const rest = chunk.subarray(start)
    if (this.#size + rest.length > this.maxBytes) return this.#fail(out, 'line over the size cap')
    if (rest.length > 0) {
      this.#parts.push(Buffer.from(rest))
      this.#size += rest.length
    }
    return out
  }

  /** At the end of input: an unterminated last line is an error. */
  end(): LineResult[] {
    if (this.#failed || this.#size === 0) return []
    return this.#fail([], 'unterminated last line')
  }

  #fail(out: LineResult[], error: string): LineResult[] {
    this.#failed = true
    this.#parts = []
    this.#size = 0
    out.push({ ok: false, error })
    return out
  }
}

function parseLine(line: Buffer): LineResult {
  let text: string
  try {
    text = utf8.decode(line)
  } catch {
    return { ok: false, error: 'line is not UTF-8' }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: 'line is not JSON' }
  }
}

/** One message as one line. Throws only on values JSON can't encode (a bug at the caller). */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}
