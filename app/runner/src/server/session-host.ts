// The root's side of one session process: spawn it as the session's OS user, speak the local channel, and turn what
// it says (or how it dies) into run events. Whatever the session does, the run gets exactly one terminal event and the
// root keeps running: a message that fails to parse ends the session (`protocol`), an exit without a terminal event
// ends it as `session_crashed`.
import { fork, type ChildProcess } from 'node:child_process'
import { SDK_MESSAGE_MAX_BYTES } from '../../../shared/protocol/index.ts'
import { capSdkMessage, parseSessionMessage, type RootMessage, type RunConfig } from '../protocol/local.ts'
import type { SessionUser } from '../session/seam.ts'
import type { RunStream } from './run-stream.ts'

export type SpawnSession = (user: SessionUser, env: Record<string, string>) => ChildProcess

/** Production spawn: the session entry, forked as the session's user, in its work folder, with only `env`. */
export function forkSession(entry: string): SpawnSession {
  return (user, env) =>
    fork(entry, [], {
      uid: user.uid,
      gid: user.gid,
      cwd: user.workDir,
      env,
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    })
}

export type SessionHandle = {
  interrupt(): void
  /** The SIGTERM path: ask the session to interrupt, flush and end; kill it if it hasn't exited after the grace. */
  stop(): void
  /** Resolves once the process has exited and the run has ended. */
  readonly done: Promise<void>
}

const STDERR_TAIL = 4096

export function hostSession(opts: {
  child: ChildProcess
  stream: RunStream
  config: RunConfig
  stopGraceMs: number
  log: (entry: Record<string, unknown>) => void
}): SessionHandle {
  const { child, stream, config, log } = opts
  const runId = stream.runId
  let sentRun = false
  let stopping = false
  let exited = false
  let killTimer: NodeJS.Timeout | undefined
  let stderrTail = ''
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))

  const kill = () => {
    if (!exited) child.kill('SIGKILL')
  }
  const killAfterGrace = () => {
    if (killTimer === undefined && !exited) killTimer = setTimeout(kill, opts.stopGraceMs)
  }
  const send = (m: RootMessage) => {
    if (exited || !child.connected) return
    child.send(m, (e) => {
      if (e) log({ type: 'session_send_failed', runId, error: e.message })
    })
  }
  const failProtocol = (error: string) => {
    log({ type: 'session_protocol_error', runId, error: error.slice(0, 500) })
    stream.emit({ type: 'failed', reason: 'protocol', message: 'the session sent a message the runner could not read' })
    kill()
  }

  child.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-STDERR_TAIL)
  })
  child.stdout?.resume()

  child.on('message', (raw) => {
    if (stream.ended) return
    const parsed = parseSessionMessage(raw)
    if (!parsed.ok) return failProtocol(parsed.error)
    const m = parsed.message
    if (m.type === 'ready') {
      if (sentRun) return failProtocol('ready sent twice')
      sentRun = true
      send({ type: 'run', config })
      if (stopping) send({ type: 'stop' })
      return
    }
    if (!sentRun) return failProtocol('an event before ready')
    const event = m.event.type === 'sdk' ? { ...m.event, ...capSdkMessage(m.event.message, SDK_MESSAGE_MAX_BYTES) } : m.event
    stream.emit(event)
    if (stream.ended) killAfterGrace()
  })

  child.on('error', (e) => {
    log({ type: 'session_error', runId, error: e.message })
    stream.emit({ type: 'failed', reason: 'session_crashed', message: 'the session process failed' })
    if (child.pid === undefined) {
      // It never started, so no exit event follows.
      exited = true
      resolveDone()
    } else kill()
  })

  child.on('exit', (code, signal) => {
    exited = true
    clearTimeout(killTimer)
    if (!stream.ended) {
      log({ type: 'session_exit', runId, code, signal, stderr: stderrTail })
      if (stopping) stream.emit({ type: 'failed', reason: 'stopped', message: 'stopped' })
      else stream.emit({ type: 'failed', reason: 'session_crashed', message: `the session process ended (${signal ?? `code ${code}`})` })
    }
    resolveDone()
  })

  return {
    done,
    interrupt() {
      if (!stream.ended) send({ type: 'interrupt' })
    },
    stop() {
      if (exited) return
      stopping = true
      if (sentRun) send({ type: 'stop' })
      killAfterGrace()
    },
  }
}
