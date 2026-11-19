// The session's end of the local channel: NDJSON on the session process's own stdin (from the root) and stdout (to the
// root). No Node IPC channel, so nothing the session sends is parsed by Node's own channel code in the root.
//
// stdout is the channel and nothing else: every log line goes to stderr. `openRootChannel` points `console` at stderr,
// so a stray console call can't corrupt the channel; a stray direct write to stdout still reaches the root, which ends
// only this session with `protocol`.
//
// Children of the session (the CLI and its tools) never get these descriptors: the SDK spawns the CLI with its own
// stdio pipes (`stdio: ['pipe', 'pipe', 'pipe']`), and Node opens every other descriptor close-on-exec. A tool can't
// reopen them through /proc/<session pid>/fd/0 or /1 either: Node's stdio pipes are socketpairs (libuv), and the
// kernel refuses to open a socket through /proc (ENXIO). No zod here, so a plain-Node fixture can import it.
import { Console } from 'node:console'
import net from 'node:net'
import { LOCAL_LINE_MAX_BYTES, LineReader, encodeLine, type LineResult } from '../protocol/ndjson.ts'

export const FROM_ROOT_FD = 0
export const TO_ROOT_FD = 1

export type RootChannel = {
  send(message: unknown): void
  /** Every line from the root, parsed, or the one error that ends the channel. Lines that came early are queued. */
  onMessage(handler: (line: LineResult) => void): void
  /** Flushes what was sent, then closes both descriptors. */
  close(): Promise<void>
}

/** Every `console` method writes to stderr from here on (log, info, debug, table, dir and the rest). */
export function consoleToStderr(): void {
  const toStderr = new Console({ stdout: process.stderr, stderr: process.stderr })
  for (const key of Object.keys(toStderr) as (keyof Console)[]) {
    const value = toStderr[key]
    if (typeof value === 'function') (console as unknown as Record<string, unknown>)[key] = value
  }
}

export function openRootChannel(maxLineBytes: number = LOCAL_LINE_MAX_BYTES): RootChannel {
  consoleToStderr()
  const out = new net.Socket({ fd: TO_ROOT_FD, readable: false, writable: true })
  const inp = new net.Socket({ fd: FROM_ROOT_FD, readable: true, writable: false })
  // The root went away: nothing more can be said; the root decides the run's end from how this process exits.
  out.on('error', (e) => process.stderr.write(`session: channel to the root failed: ${e.message}\n`))
  inp.on('error', (e) => process.stderr.write(`session: channel from the root failed: ${e.message}\n`))

  const reader = new LineReader(maxLineBytes)
  const queued: LineResult[] = []
  let handler: ((line: LineResult) => void) | null = null
  const deliver = (lines: LineResult[]) => {
    for (const l of lines) {
      if (handler) handler(l)
      else queued.push(l)
    }
  }
  inp.on('data', (chunk: Buffer) => deliver(reader.push(chunk)))
  inp.on('end', () => deliver(reader.end()))

  return {
    send: (m) => void out.write(encodeLine(m)),
    onMessage(h) {
      handler = h
      for (const l of queued.splice(0)) h(l)
    },
    close: () =>
      new Promise<void>((resolve) => {
        inp.destroy()
        out.end(() => resolve())
      }),
  }
}
