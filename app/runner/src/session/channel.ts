// The session's end of the local channel: NDJSON both ways on one socket, the session process's fd 3 (the root spawns it
// with `stdio: ['ignore', 'pipe', 'pipe', 'pipe']`). No Node IPC channel, so nothing the session sends is parsed by
// Node's own channel code in the root.
//
// Not fds 0 and 1: Node builds `process.stdin` and `process.stdout` on those, and the SDK touches them when it loads, so
// a channel socket of our own on fd 0 made Node's fail (`open EEXIST ... process.getStdin`). fds 0 to 2 are Node's as
// usual: stdin is /dev/null, and what the session prints on stdout or stderr is only log (the root keeps a tail of both),
// never read as the channel. `openRootChannel` still points `console` at stderr, so logs stay in one place.
//
// Children of the session (the CLI and its tools) never get fd 3: the SDK spawns the CLI with its own stdio pipes
// (`stdio: ['pipe', 'pipe', 'pipe']`), and Node marks fd 3 close-on-exec. A tool can't reopen it through
// /proc/<session pid>/fd/3 either: the root's pipes are socketpairs (libuv), and the kernel refuses to open a socket
// through /proc (ENXIO). No zod here, so a plain-Node fixture can import it.
import { Console } from 'node:console'
import net from 'node:net'
import { LineReader, ROOT_TO_SESSION_MAX_BYTES, encodeLine, type LineResult } from '../protocol/ndjson.ts'

/** The session's end of the channel. The root's spawn must put the channel's pipe at this index of `stdio`. */
export const CHANNEL_FD = 3

export type RootChannel = {
  /** Writes one message. Returns a promise when the socket's buffer is full, settled once it drains (or closes). */
  send(message: unknown): void | Promise<void>
  /** Writes text as it is (tests send lines `send` never would). Same backpressure as `send`. */
  writeRaw(text: string | Buffer): void | Promise<void>
  /** Every line from the root, parsed, or the one error that ends the channel. Lines that came early are queued. */
  onMessage(handler: (line: LineResult) => void): void
  /** The root's side closed (the socket ended or broke): nothing more will come. Called once. */
  onClose(handler: () => void): void
  /** Flushes what was sent, then closes the socket. */
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
  const sock = new net.Socket({ fd: CHANNEL_FD, readable: true, writable: true })
  // The root went away: nothing more can be said; the root decides the run's end from how this process exits.
  sock.on('error', (e) => process.stderr.write(`session: channel to the root failed: ${e.message}\n`))

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
  sock.on('data', (chunk: Buffer) => deliver(reader.push(chunk)))
  sock.on('end', () => {
    deliver(reader.end())
    closedNow()
  })
  sock.on('close', closedNow)

  const writeRaw = (text: string | Buffer): void | Promise<void> => {
    // A closed channel takes nothing more (write would only raise an error); the root decides the run's end.
    if (sock.destroyed || sock.writableEnded || sock.write(text)) return
    return new Promise<void>((resolve) => {
      const done = () => {
        sock.off('drain', done)
        sock.off('close', done)
        resolve()
      }
      sock.on('drain', done)
      sock.on('close', done)
    })
  }

  return {
    send: (m) => writeRaw(encodeLine(m)),
    writeRaw,
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
        if (sock.destroyed) return resolve()
        // Everything written reaches the kernel first, then the descriptor closes.
        sock.end(() => {
          sock.destroy()
          resolve()
        })
      }),
  }
}
