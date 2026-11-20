// The root's side of one session process: spawn it as the session's OS user, speak the local channel, and turn what
// it says (or how it dies) into run events. Whatever the session does, the run gets exactly one terminal event and the
// root keeps running: a line that is unreadable, oversized or fails the schema ends the session (`protocol`), and an
// end without a terminal event is `session_crashed` (or `stopped` after a stop).
//
// The local channel is one socket at the session's fd 3 (`stdio[3]`), NDJSON both ways, parsed by the root itself
// (src/protocol/ndjson.ts), not Node's IPC channel. fds 0 to 2 are left to Node in the session (the SDK builds
// process.stdin on fd 0): stdin is /dev/null (the root has nothing to say there), and stdout and stderr are log only
// (the root keeps a tail of both and never parses them). A session that closes fd 3 before its terminal event can't be
// told anything more: its group is killed and the run ends as `session_crashed` (or `stopped` after a stop).
//
// Leftover processes: the session leads its own process group (`detached`). On stop or timeout the whole group is
// killed after the grace period, and once the session has exited the group is killed at once, so nothing it started
// outlives it inside that group. A process that left the group (setsid) is `SessionUsers.release()`'s to end (seam.ts).
import { spawn, type ChildProcess } from 'node:child_process'
import type { Duplex, Readable, Writable } from 'node:stream'
import { SDK_MESSAGE_MAX_BYTES } from '../../../shared/protocol/index.ts'
import { LOCAL_LINE_MAX_BYTES, LineReader, encodeLine, type LineResult } from '../protocol/ndjson.ts'
import { capSdkMessage, monotonicMs, parseSessionMessage, type RootMessage, type RunConfig } from '../protocol/local.ts'
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
      // fd 3 is the channel (CHANNEL_FD in src/session/channel.ts). stdin: nothing to send. stdout: a pipe the root
      // drains into the log tail, so a stray print is kept for diagnosis and never blocks the session.
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
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
/** How much of the tail of a session's output (stdout and stderr) the root logs when it ends without a terminal event. */
export const STDERR_LOG_CHARS = 2000

/**
 * The session's deadline for its end phase after a stop, below the grace after which the root kills it: the grace less
 * a fifth (at least a millisecond, at most a second), so the checkpoint and the terminal event have time to reach the root.
 */
export const stopEndWithinMs = (stopGraceMs: number) => Math.max(1, stopGraceMs - Math.max(1, Math.min(1000, Math.floor(stopGraceMs / 5))))

export function hostSession(opts: {
  child: ChildProcess
  stream: RunStream
  config: RunConfig
  stopGraceMs: number
  log: (entry: Record<string, unknown>) => void
  /** Whether an event written now reaches the Worker (its response is open). An audit entry is acked only then. */
  canWrite: () => boolean
  maxLineBytes?: number
}): SessionHandle {
  const { child, stream, config, log } = opts
  const runId = stream.runId
  const channel = (child.stdio[3] ?? null) as Duplex | null
  const fromSession: Readable | null = channel
  const toSession: Writable | null = channel
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

  const nack = (id: number, error: string) => send({ type: 'audit_nack', id, error })
  const onLine = (line: LineResult) => {
    if (stream.ended) {
      // The run is over, but the session may still be running: an audit entry gets its nack at once, so the hook
      // refuses its call now rather than wait out its timeout (and the session can end in time). Nothing else is read.
      if (!line.ok) return
      const late = parseSessionMessage(line.value)
      if (late.ok && late.message.type === 'audit') nack(late.message.id, 'the run has ended')
      return
    }
    if (!line.ok) return failProtocol(line.error)
    const parsed = parseSessionMessage(line.value)
    if (!parsed.ok) return failProtocol(parsed.error)
    const m = parsed.message
    if (m.type === 'ready') {
      if (sentRun) return failProtocol('ready sent twice')
      sentRun = true
      // A stop that came first: the session gets the stop only, never the run, and ends without starting a query.
      if (stopping) return send({ type: 'stop', endWithinMs: stopEndWithinMs(opts.stopGraceMs) })
      send({ type: 'run', config })
      if (interruptPending) send({ type: 'interrupt' })
      return
    }
    if (!sentRun) return failProtocol('an event before ready')
    if (m.type === 'audit') {
      // Acked only once the entry is on the Worker's stream; otherwise the session's hook must not let the call run.
      if (!opts.canWrite()) return nack(m.id, 'the run has ended or the Worker has gone')
      // It sat in the pipe past the time the hook waits (the root wasn't reading): the call was refused already.
      if (monotonicMs() >= m.expiresAt) return nack(m.id, 'the entry expired before the root read it')
      stream.emit({ type: 'audit', entry: m.entry })
      return send({ type: 'audit_ack', id: m.id })
    }
    let event = m.event
    if (event.type === 'sdk') {
      const capped = capSdkMessage(event.message, SDK_MESSAGE_MAX_BYTES)
      if (capped === null) return failProtocol('an sdk message JSON cannot encode')
      event = { ...event, ...capped }
    }
    stream.emit(event)
    if (stream.ended) killAfterGrace()
  }

  // The safety net: nothing a session sends may throw out of these listeners (an uncaught throw there would end the
  // root and every run on it). Whatever slips past the checks above ends this session only, as `protocol`.
  const guarded = (what: string, fn: () => void) => {
    try {
      fn()
    } catch (e) {
      if (stream.ended) return void log({ type: 'session_listener_failed', runId, what, error: String(e instanceof Error ? e.message : e).slice(0, 500) })
      failProtocol(`${what}: ${String(e instanceof Error ? e.message : e)}`)
    }
  }

  const reader = new LineReader(opts.maxLineBytes ?? LOCAL_LINE_MAX_BYTES)
  fromSession?.on('data', (chunk: Buffer) =>
    guarded('read', () => {
      for (const line of reader.push(chunk)) onLine(line)
    }),
  )
  fromSession?.on('end', () => {
    guarded('read', () => {
      for (const line of reader.end()) onLine(line)
    })
    // The session closed the channel (or died) with no terminal event: it can't be reached any more. Its group is
    // killed; `close` then ends the run once its output is read.
    if (!stream.ended) killGroup()
  })
  // Pipe errors (EPIPE once the session is gone) are logged; the run's end comes from `close`.
  fromSession?.on('error', (e) => log({ type: 'session_pipe_error', runId, error: e.message }))
  toSession?.on('error', (e) => log({ type: 'session_pipe_error', runId, error: e.message }))
  const keepOutput = (d: Buffer) => {
    stderrBytes += d.length
    stderrTail = (stderrTail + d.toString('utf8')).slice(-STDERR_TAIL)
  }
  child.stdout?.on('data', keepOutput)
  child.stderr?.on('data', keepOutput)

  const finish = (how: string) => {
    if (closed) return
    closed = true
    clearTimeout(killTimer)
    clearTimeout(closeTimer)
    if (!stream.ended) {
      // Length and the last STDERR_LOG_CHARS only: enough for a stack trace, bounded whatever the session printed.
      log({ type: 'session_exit', runId, how, stderrBytes, stderrTail: stderrTail.slice(-STDERR_LOG_CHARS) })
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
      if (sentRun) send({ type: 'stop', endWithinMs: stopEndWithinMs(opts.stopGraceMs) })
      killAfterGrace()
    },
    pause: () => fromSession?.pause(),
    resume: () => fromSession?.resume(),
  }
}
