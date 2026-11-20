// The session's end of the local channel: NDJSON on two sockets, one per direction. The session writes to the root on
// its fd 3 and reads the root on its fd 4 (the root spawns it with `stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']`).
// One socket per direction because Node destroys a socket on any write error, read side included: on one socket both
// ways, a root write that failed once the session had gone took the session's unread last events with it. No Node IPC
// channel, so nothing the session sends is parsed by Node's own channel code in the root.
//
// Not fds 0 and 1: Node builds `process.stdin` and `process.stdout` on those, and the SDK touches them when it loads, so
// a channel socket of our own on fd 0 made Node's fail (`open EEXIST ... process.getStdin`). fds 0 to 2 are Node's as
// usual: stdin is /dev/null, and what the session prints on stdout or stderr is never read as the channel (the root
// drains stdout and keeps stderr's tail for its crash log). `openRootChannel` still points `console` at stderr, so logs
// stay in one place.
//
// Children of the session (the CLI and its tools) don't inherit fds 3 and 4: the SDK spawns the CLI with its own stdio
// pipes (`stdio: ['pipe', 'pipe', 'pipe']`), and the fds are close-on-exec there (the grandchild test checks fds 3 to
// 5). Nor can they open them through /proc/<session pid>/fd/3 or 4: the root's pipes are socketpairs (libuv), and the
// kernel refuses to open a socket through /proc (ENXIO; tested on Linux). Known gap: a tool running as the session's
// uid can still ptrace the session or take its fds with pidfd_getfd. Closing that (PR_SET_DUMPABLE 0, or a seccomp rule)
// is P3 security work. No zod here, so a plain-Node fixture can import it.
import { Console } from 'node:console'
import net from 'node:net'
import { LineReader, ROOT_TO_SESSION_MAX_BYTES, encodeLine, type LineResult } from '../protocol/ndjson.ts'

/** Session -> root: the session only writes it. The root's spawn puts a pipe at this index of `stdio`. */
export const TO_ROOT_FD = 3
/** Root -> session: the session only reads it. The root's spawn puts a pipe at this index of `stdio`. */
export const FROM_ROOT_FD = 4

export type RootChannel = {
  /** Writes one message. Returns a promise when the socket's buffer is full, settled once it drains (or closes). */
  send(message: unknown): void | Promise<void>
  /** Writes text as it is (tests send lines `send` never would). Same backpressure as `send`. */
  writeRaw(text: string | Buffer): void | Promise<void>
  /** Every line from the root, parsed, or the one error that ends the channel. Lines that came early are queued. */
  onMessage(handler: (line: LineResult) => void): void
  /** The root's side closed (either socket ended or broke): nothing more will come or get through. Called once. */
  onClose(handler: () => void): void
  /** Flushes what was sent, then closes both sockets. */
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
  const inn = new net.Socket({ fd: FROM_ROOT_FD, readable: true, writable: false })
  // The root went away: nothing more can be said; the root decides the run's end from how this process exits.
  out.on('error', (e) => process.stderr.write(`session: channel to the root failed: ${e.message}\n`))
  inn.on('error', (e) => process.stderr.write(`session: channel from the root failed: ${e.message}\n`))

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
  inn.on('data', (chunk: Buffer) => deliver(reader.push(chunk)))
  inn.on('end', () => {
    deliver(reader.end())
    closedNow()
  })
  inn.on('close', closedNow)
  out.on('close', closedNow)

  const writeRaw = (text: string | Buffer): void | Promise<void> => {
    // A closed channel takes nothing more (write would only raise an error); the root decides the run's end.
    if (out.destroyed || out.writableEnded || out.write(text)) return
    return new Promise<void>((resolve) => {
      const done = () => {
        out.off('drain', done)
        out.off('close', done)
        resolve()
      }
      out.on('drain', done)
      out.on('close', done)
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
        inn.destroy()
        if (out.destroyed) return resolve()
        // Everything written reaches the kernel first, then the descriptor closes.
        out.end(() => {
          out.destroy()
          resolve()
        })
      }),
  }
}
