// The root's side of one session process: spawn it as the session's OS user, speak the local channel, and turn what
// it says (or how it dies) into run events. Whatever the session does, the run gets exactly one terminal event and the
// root keeps running: a line that is unreadable, oversized or fails the schema ends the session (`protocol`), and an
// end without a terminal event is `session_crashed` (or `stopped` after a stop).
//
// The local channel is the session's own stdio, parsed by the root itself as NDJSON (src/protocol/ndjson.ts), not Node's
// IPC channel: the session's stdout carries its messages to the root, its stdin the root's to the session. Its stderr
// is for logs (the root keeps a tail).
//
// Leftover processes: the session leads its own process group (`detached`). On stop or timeout the whole group is
// killed after the grace period, and once the session has exited the group is killed at once, so nothing it started
// outlives it inside that group. A process that left the group (setsid) is `SessionUsers.release()`'s to end (seam.ts).
import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { SDK_MESSAGE_MAX_BYTES } from '../../../shared/protocol/index.ts'
import { LOCAL_LINE_MAX_BYTES, LineReader, encodeLine, type LineResult } from '../protocol/ndjson.ts'
import { capSdkMessage, parseSessionMessage, type RootMessage, type RunConfig } from '../protocol/local.ts'
import type { SessionUser } from '../session/seam.ts'
import type { RunStream } from './run-stream.ts'

/**
 * Starts a session process. It must lead its own process group (spawn it `detached`): the root kills the whole group.
 * May throw (a failed uid switch is a synchronous EPERM); the root ends the run with `session_crashed` if it does.
 */
export type SpawnSession = (user: SessionUser, env: Record<string, string>) => ChildProcess

/** No SIGUSR1 inspector activation and no inspector flags: nothing in the session can open a debugger on it. */
export const SESSION_EXEC_ARGV: readonly string[] = ['--disable-sigusr1']

/** Production spawn: the session entry, as the session's user, in its work folder, with only `env`, in its own group. */
export function spawnSessionProcess(entry: string): SpawnSession {
  return (user, env) =>
    spawn(process.execPath, [...SESSION_EXEC_ARGV, entry], {
      uid: user.uid,
      gid: user.gid,
      cwd: user.workDir,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
}

export type SessionHandle = {
  /** Before the session is ready it's recorded and sent after the run. */
  interrupt(): void
  /** The SIGTERM path: ask the session to interrupt, flush and end; kill its group if it hasn't exited after the grace. */
  stop(): void
  /** Backpressure from the Worker's response: stop reading the session's events until `resume()`. */
  pause(): void
  resume(): void
  /** Resolves once the process has exited, its pipes have closed, its group has been killed and the run has ended. */
  readonly done: Promise<void>
}

const STDERR_TAIL = 4096

export function hostSession(opts: {
  child: ChildProcess
  stream: RunStream
  config: RunConfig
  stopGraceMs: number
  log: (entry: Record<string, unknown>) => void
  maxLineBytes?: number
}): SessionHandle {
  const { child, stream, config, log } = opts
  const runId = stream.runId
  const fromSession: Readable | null = child.stdout
  const toSession: Writable | null = child.stdin
  let sentRun = false
  let stopping = false
  let interruptPending = false
  let exited = false
  let closed = false
  let killTimer: NodeJS.Timeout | undefined
  let closeTimer: NodeJS.Timeout | undefined
  let stderrTail = ''
  let stderrBytes = 0
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))

  const killGroup = () => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (e) {
      // ESRCH: the group is already empty.
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') log({ type: 'session_kill_failed', runId, error: String(e) })
    }
  }
  const killAfterGrace = () => {
    if (killTimer === undefined && !exited) killTimer = setTimeout(killGroup, opts.stopGraceMs)
  }
  const send = (m: RootMessage) => {
    if (closed || !toSession || toSession.destroyed || toSession.writableEnded) return
    toSession.write(encodeLine(m))
  }
  const failProtocol = (error: string) => {
    log({ type: 'session_protocol_error', runId, error: error.slice(0, 500) })
    stream.emit({ type: 'failed', reason: 'protocol', message: 'the session sent a message the runner could not read' })
    killGroup()
  }

  const onLine = (line: LineResult) => {
    if (stream.ended) return
    if (!line.ok) return failProtocol(line.error)
    const parsed = parseSessionMessage(line.value)
    if (!parsed.ok) return failProtocol(parsed.error)
    const m = parsed.message
    if (m.type === 'ready') {
      if (sentRun) return failProtocol('ready sent twice')
      sentRun = true
      send({ type: 'run', config })
      if (stopping) send({ type: 'stop' })
      else if (interruptPending) send({ type: 'interrupt' })
      return
    }
    if (!sentRun) return failProtocol('an event before ready')
    const event = m.event.type === 'sdk' ? { ...m.event, ...capSdkMessage(m.event.message, SDK_MESSAGE_MAX_BYTES) } : m.event
    stream.emit(event)
    if (stream.ended) killAfterGrace()
  }

  const reader = new LineReader(opts.maxLineBytes ?? LOCAL_LINE_MAX_BYTES)
  fromSession?.on('data', (chunk: Buffer) => {
    for (const line of reader.push(chunk)) onLine(line)
  })
  fromSession?.on('end', () => {
    for (const line of reader.end()) onLine(line)
  })
  // Pipe errors (EPIPE once the session is gone) are logged; the run's end comes from `close`.
  fromSession?.on('error', (e) => log({ type: 'session_pipe_error', runId, error: e.message }))
  toSession?.on('error', (e) => log({ type: 'session_pipe_error', runId, error: e.message }))
  child.stderr?.on('data', (d: Buffer) => {
    stderrBytes += d.length
    stderrTail = (stderrTail + d.toString('utf8')).slice(-STDERR_TAIL)
  })

  const finish = (how: string) => {
    if (closed) return
    closed = true
    clearTimeout(killTimer)
    clearTimeout(closeTimer)
    if (!stream.ended) {
      // Length and first line only: the tail can hold anything the session printed.
      log({ type: 'session_exit', runId, how, stderrBytes, stderrFirstLine: stderrTail.split('\n', 1)[0]!.slice(0, 200) })
      if (stopping) stream.emit({ type: 'failed', reason: 'stopped', message: 'stopped' })
      else stream.emit({ type: 'failed', reason: 'session_crashed', message: `the session process ended (${how})` })
    }
    killGroup()
    resolveDone()
  }

  child.on('error', (e) => {
    log({ type: 'session_error', runId, error: e.message })
    if (child.pid === undefined) {
      // It never started: no exit follows, and the pipes may never close.
      for (const s of child.stdio) s?.destroy()
      finish('never started')
    } else killGroup()
  })

  child.on('exit', () => {
    exited = true
    clearTimeout(killTimer)
    // Leftovers in the session's group die now; their copies of its pipes close with them.
    killGroup()
    // A process outside the group can still hold a pipe open; don't wait on it past the grace.
    closeTimer = setTimeout(() => {
      for (const s of child.stdio) s?.destroy()
    }, opts.stopGraceMs)
  })

  // `close` comes after the exit and once every pipe has closed, so every line the session sent has been read: the
  // terminal event is decided here, not on `exit`.
  child.on('close', (code, signal) => finish(signal ?? `code ${code}`))

  return {
    done,
    interrupt() {
      if (closed || stream.ended) return
      if (sentRun) send({ type: 'interrupt' })
      else interruptPending = true
    },
    stop() {
      if (closed) return
      stopping = true
      if (sentRun) send({ type: 'stop' })
      killAfterGrace()
    },
    pause: () => fromSession?.pause(),
    resume: () => fromSession?.resume(),
  }
}
