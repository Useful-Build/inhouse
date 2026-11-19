// A fake session process for the root's tests. It speaks the local channel by hand (no imports, so plain Node runs it)
// and does what the run's prompt says:
//   echo:<marker>:<n>  sends n sdk events carrying the marker, then finished
//   crash              exits with code 3 without a terminal event
//   garbage            sends a message that isn't in the local schema
//   bad-event          sends an event body that isn't a run event
//   dump               writes a file in its cwd, then sends its env, argv, run message and cwd files as one sdk event
//   hang               never answers; ends only when killed
//   obey-stop          waits for stop, then ends with failed/stopped
//   big                sends one sdk event larger than the cap
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

// IPC sends are async: disconnecting right after one can drop it, so `end` disconnects once the last send is out.
let last: Promise<void> = Promise.resolve()
const send = (m: unknown) => {
  last = new Promise((r) => process.send!(m, undefined, {}, () => r()))
}
const end = () => void last.then(() => process.disconnect!())
const event = (e: unknown) => send({ type: 'event', event: e })
const finished = () => event({ type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0, usage: {} })

process.on('message', (raw: any) => {
  if (raw?.type === 'stop' && mode === 'obey-stop') {
    event({ type: 'failed', reason: 'stopped', message: 'stopped' })
    end()
    return
  }
  if (raw?.type !== 'run') return
  runMessage = raw
  mode = raw.config.prompt.split(':')[0]
  const [, marker, n] = raw.config.prompt.split(':')
  switch (mode) {
    case 'echo': {
      let i = 0
      // Yield between events so concurrent sessions interleave at the root.
      const tick = () => {
        if (i < Number(n)) {
          event({ type: 'sdk', message: { type: 'assistant', marker, i: i++ }, truncated: false })
          setImmediate(tick)
        } else {
          finished()
          end()
        }
      }
      tick()
      break
    }
    case 'crash':
      process.exit(3)
    case 'garbage':
      send({ type: 'nonsense', payload: 1 })
      break
    case 'bad-event':
      event({ type: 'sdk', message: 'not an object', truncated: false })
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
    case 'hang':
    case 'obey-stop':
      break
  }
})
let mode = ''
let runMessage: unknown = null
send({ type: 'ready' })
