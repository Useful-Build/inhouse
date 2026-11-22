// The root's side of one session process: spawn it as the session's OS user, speak the local channel, and turn what
// it says (or how it dies) into run events. Whatever the session does, the run gets exactly one terminal event and the
// root keeps running: a line that is unreadable, oversized or fails the schema ends the session (`protocol`), and an
// end without a terminal event is `session_crashed` (or `stopped` after a stop).
//
// The local channel is two sockets, one per direction, NDJSON on each, parsed by the root itself
// (src/protocol/ndjson.ts), not Node's IPC channel: the session's fd 3 (`stdio[3]`) carries session -> root (the session
// only writes it, the root only reads it), and its fd 4 (`stdio[4]`) carries root -> session (the root only writes, the
// session only reads). Node destroys a socket on any write error, read side included; with one socket both ways, a
// root write that failed once the session had gone (an ack, an interrupt, a stop) dropped the session's unread last
// events. Now a failed write breaks fd 4 only, and fd 3 is read to its end once the session has exited, even behind a
// slow Worker: from the exit on, fd 3 is no longer paused.
// fds 0 to 2 are left to Node in the session (the SDK builds process.stdin on fd 0): stdin is /dev/null (the root has
// nothing to say there), stdout is drained and counted, never kept, and stderr is the session's log (the root keeps its
// tail). Neither is parsed. A session whose fd 3 closes (an end or an error) before its terminal event can't be heard
// any more: its group is killed and the run ends as `session_crashed` (or `stopped` after a stop).
//
// Leftover processes: the session leads its own process group (`detached`). On stop or timeout the whole group is
// killed after the grace period, and once the session has exited the group is killed at once, so nothing it started
// outlives it inside that group. A process that left the group (setsid) is `SessionUsers.release()`'s to end (seam.ts).
import { spawn, type ChildProcess } from 'node:child_process'
import type { Duplex, Readable } from 'node:stream'
import { SDK_MESSAGE_MAX_BYTES, type AuditEntry } from '../../../shared/protocol/index.ts'
import { LOCAL_LINE_MAX_BYTES, LineReader, encodeLine, type LineResult } from '../protocol/ndjson.ts'
import { capSdkMessage, monotonicMs, parseSessionMessage, type RootMessage, type RunConfig, type SessionEvent } from '../protocol/local.ts'
import type { SessionUser } from '../session/seam.ts'
import type { RunStream } from './run-stream.ts'
import { safeError } from '../safe-error.ts'

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
      // fd 3: session -> root, fd 4: root -> session (TO_ROOT_FD and FROM_ROOT_FD in src/session/channel.ts). stdin:
      // nothing to send. stdout: a pipe the root drains (and counts), so a stray print never blocks the session.
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    })
}

export type SessionHandle = {
  /** Before the session is ready it's recorded and sent after the run. */
  interrupt(): void
  /** The SIGTERM path: ask the session to interrupt, flush and end; kill its group if it hasn't exited after the grace. */
  stop(): void
  /** Backpressure from the push buffer: stop reading the session's events until `resume()`. A no-op once it has exited. */
  pause(): void
  resume(): void
  /** Resolves once the process has exited, its pipes have closed, its group has been killed and the run has ended. */
  readonly done: Promise<void>
}

const STDERR_TAIL = 4096
/** The most stack-frame lines (`    at ...`) from stderr's tail the root logs when a session ends without a terminal event. */
const STACK_LOG_FRAMES = 8
/**
 * A V8 stack frame that ends in a code location: `at <fn> (<location>)` or `at <location>`, the location with no space or
 * parenthesis, then `:line:col`. An indented chat line that merely starts with `at` ("at the meeting at 10:30:45") isn't one.
 */
const STACK_FRAME = /^\s+at (?:[^()]+ \([^()\s]+:\d+:\d+\)|[^()\s]+:\d+:\d+)$/
/**
 * What the root lets wait unsent for a session on fd 4, beyond the run message: the rest is small (interrupt, stop, one
 * answer per audit entry the session sent). A session past it isn't reading: the root ends it as `protocol`.
 */
export const ROOT_TO_SESSION_BACKLOG_BYTES = 64 * 1024

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
  /**
   * Records a blocking audit entry durably (the egress's `/audit/`); true only once the Worker answered 204 before
   * `expiresAt` (`monotonicMs()`). The session's hook is acked only on true; anything else denies its call.
   */
  recordAudit: (entry: AuditEntry, expiresAt: number) => Promise<boolean>
  /** The session is about to call `query()` (it may change the transcript from here). */
  onQueryStarted: () => void
  /**
   * The run's store result, whenever it comes, even after the run's terminal event (a root-emitted timeout, say):
   * a `checkpoint`'s state, or null for a `mirror_error`. The root carries it in `released`.
   */
  onStoreResult: (checkpoint: { mainEntries: number; lastUuid: string | null; lastUuidIndex: number | null } | null) => void
  maxLineBytes?: number
}): SessionHandle {
  const { child, stream, config, log } = opts
  const runId = stream.runId
  const fromSession = (child.stdio[3] ?? null) as Readable | null
  const toSession = (child.stdio[4] ?? null) as Duplex | null
  let sentRun = false
  let stopping = false
  let interruptPending = false
  let exited = false
  let closed = false
  let killTimer: NodeJS.Timeout | undefined
  let closeTimer: NodeJS.Timeout | undefined
  let stderrTail = ''
  let stderrBytes = 0
  let stdoutBytes = 0
  /** What may wait unsent on fd 4: the backlog cap, plus the run message once it is sent. */
  let backlogAllowed = ROOT_TO_SESSION_BACKLOG_BYTES
  let backlogFailed = false
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))

  const killGroup = () => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (e) {
      // ESRCH: the group is already empty.
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') log({ type: 'session_kill_failed', runId, error: safeError(e) })
    }
  }
  const killAfterGrace = () => {
    if (killTimer === undefined && !exited) killTimer = setTimeout(killGroup, opts.stopGraceMs)
  }
  const send = (m: RootMessage) => {
    if (closed || backlogFailed || !toSession || toSession.destroyed || toSession.writableEnded) return
    const line = encodeLine(m)
    if (m.type === 'run') backlogAllowed += Buffer.byteLength(line)
    toSession.write(line)
    if (toSession.writableLength > backlogAllowed) {
      backlogFailed = true
      log({ type: 'session_protocol_error', runId, error: `the session is not reading the channel: ${toSession.writableLength} bytes wait unsent` })
      if (!stream.ended) stream.emit({ type: 'failed', reason: 'protocol', message: 'the session stopped reading the runner' })
      killGroup()
    }
  }
  const failProtocol = (error: string) => {
    log({ type: 'session_protocol_error', runId, error: error.slice(0, 500) })
    stream.emit({ type: 'failed', reason: 'protocol', message: 'the session sent a message the runner could not read' })
    killGroup()
  }

  const nack = (id: number, error: string) => send({ type: 'audit_nack', id, error })
  const storeResult = (event: SessionEvent) => {
    if (event.type === 'checkpoint') opts.onStoreResult({ mainEntries: event.mainEntries, lastUuid: event.lastUuid, lastUuidIndex: event.lastUuidIndex })
    else if (event.type === 'mirror_error') opts.onStoreResult(null)
  }
  const onLine = (line: LineResult) => {
    if (stream.ended) {
      // The run is over, but the session may still be running: an audit entry gets its nack at once, so the hook
      // refuses its call now rather than wait out its timeout (and the session can end in time). Its store result is
      // kept for `released`, and so is a query_started; nothing else is read.
      if (!line.ok) return
      const late = parseSessionMessage(line.value)
      if (!late.ok) return
      if (late.message.type === 'audit') nack(late.message.id, 'the run has ended')
      else if (late.message.type === 'event') storeResult(late.message.event)
      // A root timeout can race the first append: the transcript may change, so released must say the query ran.
      else if (late.message.type === 'query_started') opts.onQueryStarted()
      return
    }
    if (!line.ok) return failProtocol(line.error)
    const parsed = parseSessionMessage(line.value)
    // The schema's report quotes what the session sent (an event, a tool input, a file name): the log gets fixed text.
    if (!parsed.ok) return failProtocol('a message that fails its schema')
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
    if (m.type === 'query_started') return opts.onQueryStarted()
    if (m.type === 'audit') {
      // It sat in the pipe past the time the hook waits (the root wasn't reading): the call was refused already.
      if (monotonicMs() >= m.expiresAt) return nack(m.id, 'the entry expired before the root read it')
      // Acked only once the Worker holds the entry (its 204); otherwise the session's hook must not let the call run.
      const { id, entry, expiresAt } = m
      void opts.recordAudit(entry, expiresAt).then(
        (ok) => {
          if (!ok) return nack(id, 'the Worker did not record the entry')
          if (stream.ended || monotonicMs() >= expiresAt) return nack(id, stream.ended ? 'the run has ended' : 'the entry expired before the Worker recorded it')
          // The trace copy; the durable one is the Worker's.
          stream.emit({ type: 'audit', entry })
          send({ type: 'audit_ack', id })
        },
        () => nack(id, 'the Worker did not record the entry'),
      )
      return
    }
    let event = m.event
    storeResult(event)
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
      if (stream.ended) return void log({ type: 'session_listener_failed', runId, what, error: safeError(e) })
      failProtocol(`${what}: ${safeError(e)}`)
    }
  }

  const reader = new LineReader(opts.maxLineBytes ?? LOCAL_LINE_MAX_BYTES)
  fromSession?.on('data', (chunk: Buffer) =>
    guarded('read', () => {
      for (const line of reader.push(chunk)) onLine(line)
    }),
  )
  fromSession?.on('end', () =>
    guarded('read', () => {
      for (const line of reader.end()) onLine(line)
    }),
  )
  // fd 3 closed (a clean end, every line read; or an error, ECONNRESET say) with no terminal event: the session can't
  // be heard any more. Its group is killed; the child's `close` then ends the run. Diagnostic only: a session that
  // closes fd 3 and then exits on its own races this kill, so the crash log's `how` may read SIGKILL for it.
  fromSession?.on('close', () => {
    if (!stream.ended) killGroup()
  })
  // Pipe errors are logged, one listener per socket; the run's end comes from `close`. A write that fails on fd 4
  // (EPIPE once the session is gone) breaks fd 4 only: fd 3 is still read to its end.
  fromSession?.on('error', (e) => log({ type: 'session_pipe_error', runId, fd: 3, error: safeError(e) }))
  toSession?.on('error', (e) => log({ type: 'session_pipe_error', runId, fd: 4, error: safeError(e) }))
  // Nothing comes to the root on fd 4; read it anyway, so its end is seen and it closes with the session.
  toSession?.resume()
  // Only stderr's tail is kept, for the crash log's stack frames: the session's stdout can hold anything it printed (chat content, a
  // tool's output), and Node's crash trace goes to stderr. stdout is drained, so it never blocks the session, and
  // counted.
  child.stdout?.on('data', (d: Buffer) => (stdoutBytes += d.length))
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
      // No text from the session reaches the log: stderr can hold chat content (an error that quotes a message or a
      // tool's output). It gives its byte count and the first stack-frame lines of its tail (code locations, each cut
      // to 200 chars); stdout gives its byte count only. `how` is the exit code or signal.
      const stack = stderrTail
        .split('\n')
        .filter((l) => STACK_FRAME.test(l))
        .slice(0, STACK_LOG_FRAMES)
        .map((l) => l.slice(0, 200))
      log({ type: 'session_exit', runId, how, stderrBytes, stack, stdoutBytes })
      if (stopping) stream.emit({ type: 'failed', reason: 'stopped', message: 'stopped' })
      else stream.emit({ type: 'failed', reason: 'session_crashed', message: `the session process ended (${how})` })
    }
    killGroup()
    resolveDone()
  }

  child.on('error', (e) => {
    log({ type: 'session_error', runId, error: safeError(e) })
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
    // What the session sent is read now, whatever the Worker's pace (pause is a no-op from here on): it is bounded by
    // the kernel's buffer (fds 3 and 4 aren't inherited, so no one else adds to it), and the grace below must never cut
    // off unread events.
    fromSession?.resume()
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
    pause: () => {
      if (!exited) fromSession?.pause()
    },
    resume: () => fromSession?.resume(),
  }
}
