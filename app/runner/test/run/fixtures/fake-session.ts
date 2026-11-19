// A fake session process for the root's tests, spawned exactly as production spawns the real one. It speaks the local
// channel through the production channel module (src/session/channel.ts, no zod) and does what the run's prompt says:
//   echo:<marker>:<n>  sends n sdk events carrying the marker, then finished
//   race:<n>           sends n sdk events then finished, but a stop that arrives first ends it as stopped
//   crash              exits with code 3 without a terminal event
//   crash-after:<n>    sends n sdk events, then exits with code 3
//   garbage            sends a message that isn't in the local schema
//   bad-event          sends an event body that isn't a run event
//   raw-garbage        writes bytes that aren't JSON (nor UTF-8) straight to fd 3
//   oversized          sends one line over the channel's cap
//   dump               writes a file in its cwd, then sends its env, argv, run message and cwd files as one sdk event
//   hang               never answers; ends only when killed
//   obey-stop          waits for stop, then ends with failed/stopped
//   await-interrupt    waits for interrupt, then ends with failed/interrupted
//   big                sends one sdk event larger than the SDK message cap
//   grandchild         starts a shell the way the CLI is started (spawnCli) that writes to fds 3 and 4, then finished
//   leftover           starts a process in its group that never ends, reports its pid, then finished and exits
// A file named `hold-ready` in its cwd holds `ready` back until SIGUSR2 (it writes `waiting-for-usr2` once it listens).
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { LOCAL_LINE_MAX_BYTES } from '../../../src/protocol/ndjson.ts'
import { TO_ROOT_FD, openRootChannel, spawnCli } from '../../../src/session/channel.ts'

const channel = openRootChannel()
const send = (m: unknown) => channel.send(m)
const end = () => void channel.close().then(() => process.exit(0))
const event = (e: unknown) => send({ type: 'event', event: e })
const finished = () => event({ type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0, usage: {} })

let mode = ''
let runMessage: unknown = null
let ended = false

channel.onMessage((line) => {
  if (!line.ok) return
  const raw = line.value as any
  if (raw?.type === 'stop' && (mode === 'obey-stop' || mode === 'race') && !ended) {
    ended = true
    event({ type: 'failed', reason: 'stopped', message: 'stopped' })
    end()
    return
  }
  if (raw?.type === 'interrupt' && mode === 'await-interrupt') {
    event({ type: 'failed', reason: 'interrupted', message: 'interrupted' })
    end()
    return
  }
  if (raw?.type !== 'run') return
  runMessage = raw
  mode = raw.config.prompt.split(':')[0]
  const [, a, b] = raw.config.prompt.split(':')
  const ticks = (n: number, marker: string | undefined, then: () => void) => {
    let i = 0
    // Yield between events so concurrent sessions interleave at the root, and a stop can land in between.
    const tick = () => {
      if (ended) return
      if (i < n) {
        event({ type: 'sdk', message: { type: 'assistant', marker, i: i++ }, truncated: false })
        setImmediate(tick)
      } else then()
    }
    tick()
  }
  switch (mode) {
    case 'echo':
      ticks(Number(b), a, () => {
        finished()
        end()
      })
      break
    case 'race':
      ticks(Number(a), undefined, () => {
        ended = true
        finished()
        end()
      })
      break
    case 'crash':
      process.exit(3)
    case 'crash-after':
      ticks(Number(a), undefined, () => void channel.close().then(() => process.exit(3)))
      break
    case 'garbage':
      send({ type: 'nonsense', payload: 1 })
      break
    case 'bad-event':
      event({ type: 'sdk', message: 'not an object', truncated: false })
      break
    case 'raw-garbage':
      writeSync(TO_ROOT_FD, Buffer.from([0x00, 0xff, 0xfe, 0x7b, 0x0a]))
      break
    case 'oversized':
      event({ type: 'sdk', message: { type: 'assistant', blob: 'a'.repeat(LOCAL_LINE_MAX_BYTES) }, truncated: false })
      break
    case 'dump': {
      writeFileSync('written-by-session.txt', JSON.stringify({ env: process.env, argv: process.argv }))
      const files = Object.fromEntries(readdirSync('.').map((f) => [f, readFileSync(f, 'utf8')]))
      event({ type: 'sdk', message: { type: 'dump', env: process.env, argv: process.argv, execArgv: process.execArgv, run: runMessage, files }, truncated: false })
      finished()
      end()
      break
    }
    case 'big':
      event({ type: 'sdk', message: { type: 'assistant', subtype: 'x', blob: 'a'.repeat(300 * 1024) }, truncated: false })
      finished()
      end()
      break
    case 'grandchild': {
      // If fds 3 or 4 reached the shell, "leaked" would land on the root's channel and end the run as `protocol`.
      const sh = spawnCli({ command: '/bin/sh', args: ['-c', 'echo leaked >&3; echo leaked >&4; echo shell-ran'], env: { PATH: '/usr/bin:/bin' }, signal: new AbortController().signal })
      let out = ''
      sh.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
      sh.on('exit', (code) => {
        event({ type: 'sdk', message: { type: 'grandchild', code, out }, truncated: false })
        finished()
        end()
      })
      sh.stdin.end()
      break
    }
    case 'leftover': {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      child.unref()
      event({ type: 'sdk', message: { type: 'leftover', pid: child.pid }, truncated: false })
      finished()
      end()
      break
    }
    case 'hang':
    case 'obey-stop':
    case 'await-interrupt':
      break
  }
})

if (existsSync('hold-ready')) {
  process.once('SIGUSR2', () => send({ type: 'ready' }))
  // Tells the test the handler is in place (a SIGUSR2 before it would kill the process).
  writeFileSync('waiting-for-usr2', '')
} else send({ type: 'ready' })
