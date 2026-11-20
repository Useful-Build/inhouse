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
import { LineReader, ROOT_TO_SESSION_MAX_BYTES, encodeLine, type LineResult } from '../protocol/ndjson.ts'

export const FROM_ROOT_FD = 0
export const TO_ROOT_FD = 1

export type RootChannel = {
  /** Writes one message. Returns a promise when the socket's buffer is full, settled once it drains (or closes). */
  send(message: unknown): void | Promise<void>
  /** Every line from the root, parsed, or the one error that ends the channel. Lines that came early are queued. */
  onMessage(handler: (line: LineResult) => void): void
  /** The root's side closed (stdin ended or broke): nothing more will come. Called once. */
  onClose(handler: () => void): void
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

export function openRootChannel(maxLineBytes: number = ROOT_TO_SESSION_MAX_BYTES): RootChannel {
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
  let closed = false
  const closeHandlers: (() => void)[] = []
  const closedNow = () => {
    if (closed) return
    closed = true
    for (const h of closeHandlers.splice(0)) h()
  }
  inp.on('data', (chunk: Buffer) => deliver(reader.push(chunk)))
  inp.on('end', () => {
    deliver(reader.end())
    closedNow()
  })
  inp.on('close', closedNow)

  return {
    send(m) {
      // A closed channel takes nothing more (write would only raise an error); the root decides the run's end.
      if (out.destroyed || out.write(encodeLine(m))) return
      return new Promise<void>((resolve) => {
        const done = () => {
          out.off('drain', done)
          out.off('close', done)
          resolve()
        }
        out.on('drain', done)
        out.on('close', done)
      })
    },
    onMessage(h) {
      handler = h
      for (const l of queued.splice(0)) h(l)
    },
    onClose(h) {
      if (closed) h()
      else closeHandlers.push(h)
    },
    close: () =>
      new Promise<void>((resolve) => {
        inp.destroy()
        out.end(() => resolve())
      }),
  }
}
