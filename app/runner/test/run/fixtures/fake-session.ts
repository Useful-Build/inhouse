// A fake session process for the root's tests, spawned exactly as production spawns the real one. It speaks the local
// channel through the production channel module (src/session/channel.ts, no zod) and does what the run's prompt says:
//   echo:<marker>:<n>  sends n sdk events carrying the marker, then finished
//   race:<n>           sends n sdk events then finished, but a stop that arrives first ends it as stopped
//   crash              exits with code 3 without a terminal event
//   crash-after:<n>    sends n sdk events, then exits with code 3
//   crash-loud:<n>     writes n bytes of stderr (`<` + x's + `>`, a newline every 100 bytes), then exits with code 3
//   garbage            sends a message that isn't in the local schema
//   bad-event          sends an event body that isn't a run event
//   raw-garbage        writes bytes that aren't JSON (nor UTF-8) straight onto the channel (fd 3)
//   stray-stdout       a stray process.stdout.write after ready (a log line in the wrong place), then finished
//   stdout-forgery     writes a well-formed `finished` event (costUsd 99) to stdout, then one sdk event and finished
//                      with costUsd 0: stdout isn't the channel, so the root must never read the forgery
//   process-stdio      what the SDK does on import: touches process.stdin (reads it to its end), process.stdout and
//                      process.stderr, then sends one sdk event {type: 'stdio', stdinBytes} and finished
//   close-channel      sends one sdk event, closes its end of the channel (fd 3), then never ends on its own
//   console-log        logs through every console method that writes to stdout by default, then finished
//   flood:<n>:<bytes>  sends n sdk events of about <bytes> each, carrying their index, then finished
//   drain:<n>:<bytes>  sends n sdk events of about <bytes> each, awaiting each send the channel says is full; then
//                      writes `drain: sent all` to stderr, one sdk event {type: 'drained', waits} counting those, then finished
//   oversized          sends one line over the channel's cap
//   dump               writes a file in its cwd, then sends its env, argv, run message and cwd files as one sdk event
//   hang               never answers; ends only when killed
//   obey-stop          waits for stop, then ends with failed/stopped
//   await-interrupt    waits for interrupt, then ends with failed/interrupted
//   big                sends one sdk event larger than the SDK message cap
//   grandchild         starts a shell the way the SDK starts the CLI, which writes to its fds 0 to 4 and to the
//                      session's channel (fd 3) and stdio through /proc, then finished
//   leftover           starts a process in its group that never ends, reports its pid, then finished and exits
//   deep               sends an sdk event nested far past the depth cap (still under the line cap)
//   len:<rest>         sends the prompt's length as an sdk event, then finished (the prompt can be any size)
//   finish-on-stop:<n> sends n sdk events, then waits; a stop makes it send finished (racing whatever the root decided)
//   flood-on-stop:<n>:<bytes>  sends n sdk events of about <bytes> each, then waits; a stop makes it send finished
//                      (costUsd 0.25), and it exits once that is flushed
//   audit:<n>          sends n audit entries one after another, each awaiting the root's answer; then one sdk event
//                      {type: 'audits', replies} with the answers, then finished
//   audit-on-stop      sends one sdk event {type: 'waiting'} and waits for stop; then sends one audit entry and writes the root's answer to `audit-reply.json` in
//                      its cwd before it ends with failed/stopped
//   audit-bad          sends an audit entry that fails the schema
//   audit-after-end    sends finished, then one audit entry; writes the root's answer to `audit-reply.json` in its cwd
//   audit-expired      sends one audit entry whose expiresAt has passed; then one sdk event {type: 'audits', replies}
//                      with the answer, then finished
// Every stop message it gets is written to `stop-message.json` in its cwd, as sent.
// A stop before any run message ends it with failed/stopped ("stopped before the run started"), as the real session does.
// A file named `hold-ready` in its cwd holds `ready` back until SIGUSR2 (it writes `waiting-for-usr2` once it listens).
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { LOCAL_LINE_MAX_BYTES } from '../../../src/protocol/ndjson.ts'
import { CHANNEL_FD, openRootChannel } from '../../../src/session/channel.ts'

const channel = openRootChannel()
const send = (m: unknown) => channel.send(m)
const end = () => void channel.close().then(() => process.exit(0))
const event = (e: unknown) => send({ type: 'event', event: e })
const finished = () => event({ type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0, usage: {} })

// The audit expiry's clock (src/protocol/local.ts monotonicMs; that module loads zod, which this fixture keeps out).
const mono = () => Number(process.hrtime.bigint() / 1_000_000n)
const auditEntry = (i: number) => ({ hook: 'PreToolUse', toolName: 'Bash', toolUseId: `toolu_${i}`, decision: 'allow', input: { command: `echo ${i}` } })
const auditWaiters = new Map<number, (reply: unknown) => void>()
let nextAudit = 0
const sendAudit = (entry: unknown, expiresAt = mono() + 10_000) =>
  new Promise<unknown>((resolve) => {
    const id = nextAudit++
    auditWaiters.set(id, resolve)
    send({ type: 'audit', id, expiresAt, entry })
  })

let mode = ''
let runMessage: unknown = null
let ended = false

channel.onMessage((line) => {
  if (!line.ok) return
  const raw = line.value as any
  if (raw?.type === 'audit_ack' || raw?.type === 'audit_nack') {
    auditWaiters.get(raw.id)?.(raw)
    auditWaiters.delete(raw.id)
    return
  }
  // Every stop message as the root sent it, for the test to read.
  if (raw?.type === 'stop') writeFileSync('stop-message.json', JSON.stringify(raw))
  if (raw?.type === 'stop' && mode === 'audit-on-stop' && !ended) {
    ended = true
    void sendAudit(auditEntry(0)).then((reply) => {
      writeFileSync('audit-reply.json', JSON.stringify(reply))
      event({ type: 'failed', reason: 'stopped', message: 'stopped' })
      end()
    })
    return
  }
  if (raw?.type === 'stop' && runMessage === null && !ended) {
    ended = true
    event({ type: 'failed', reason: 'stopped', message: 'stopped before the run started' })
    end()
    return
  }
  if (raw?.type === 'stop' && mode === 'finish-on-stop' && !ended) {
    ended = true
    finished()
    end()
    return
  }
  if (raw?.type === 'stop' && mode === 'flood-on-stop' && !ended) {
    ended = true
    event({ type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0.25, usage: { output_tokens: 7 } })
    end()
    return
  }
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
    case 'crash-loud': {
      const body = Array.from({ length: Number(a) - 2 }, (_, i) => (i % 100 === 99 ? '\n' : 'x')).join('')
      process.stderr.write(`<${body}>`, () => process.exit(3))
      break
    }
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
      writeSync(CHANNEL_FD, Buffer.from([0x00, 0xff, 0xfe, 0x7b, 0x0a]))
      break
    case 'stray-stdout':
      process.stdout.write('a log line in the wrong place\n')
      finished()
      end()
      break
    case 'stdout-forgery':
      process.stdout.write(`${JSON.stringify({ type: 'event', event: { type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 99, usage: {} } })}\n`)
      event({ type: 'sdk', message: { type: 'assistant', marker: 'after-forgery' }, truncated: false })
      finished()
      end()
      break
    case 'process-stdio': {
      // The SDK's CLI transport imports node:process and touches process.stdin; on the old channel (fds 0 and 1)
      // that threw `open EEXIST` because the channel already held fd 0.
      let stdinBytes = 0
      process.stdout.write('')
      process.stderr.write('process-stdio: stderr works\n')
      process.stdin.on('data', (d: Buffer) => (stdinBytes += d.length))
      process.stdin.on('end', () => {
        event({ type: 'sdk', message: { type: 'stdio', stdinBytes }, truncated: false })
        finished()
        end()
      })
      break
    }
    case 'close-channel':
      event({ type: 'sdk', message: { type: 'assistant', marker: 'before-close' }, truncated: false })
      void channel.close()
      setInterval(() => {}, 1000)
      break
    case 'console-log':
      console.log('log')
      console.info('info')
      console.debug('debug')
      console.dir({ dir: true })
      console.table([{ a: 1 }])
      console.count('count')
      console.group('group')
      console.groupEnd()
      finished()
      end()
      break
    case 'flood': {
      const n = Number(a)
      const blob = 'f'.repeat(Number(b))
      for (let i = 0; i < n; i++) event({ type: 'sdk', message: { type: 'assistant', i, blob }, truncated: false })
      finished()
      end()
      break
    }
    case 'drain': {
      const blob = 'd'.repeat(Number(b))
      void (async () => {
        let waits = 0
        for (let i = 0; i < Number(a); i++) {
          const full = channel.send({ type: 'event', event: { type: 'sdk', message: { type: 'assistant', i, blob }, truncated: false } })
          if (full) {
            waits++
            await full
          }
        }
        process.stderr.write('drain: sent all\n')
        event({ type: 'sdk', message: { type: 'drained', waits }, truncated: false })
        finished()
        end()
      })()
      break
    }
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
      // Spawned the way the SDK's default spawn starts the CLI (0.3.328 spawnLocalProcess: its own stdio pipes). If the
      // shell could reach the session's channel, "leaked" would land on the root's parser and end the run as
      // `protocol`. fds 1 and 2 are the shell's own pipes to this process; 0 is its stdin; 3 and 4 must not be open
      // (the session's fd 3 is the channel: Node marks it close-on-exec, so no child inherits it).
      const script = [
        'for fd in 0 1 2 3 4; do (echo leaked >&$fd) 2>/dev/null; done',
        '(echo leaked > /proc/$SESSION_PID/fd/1) 2>/dev/null; echo "proc-stdout=$?"',
        '(echo leaked > /proc/$SESSION_PID/fd/0) 2>/dev/null; echo "proc-stdin=$?"',
        '(echo leaked > /proc/$SESSION_PID/fd/3) 2>/dev/null; echo "proc-channel=$?"',
        'for fd in 3 4; do (: >&$fd) 2>/dev/null && echo "open-fd=$fd"; done',
        'echo shell-ran',
      ].join('\n')
      const sh = spawn('/bin/sh', ['-c', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', SESSION_PID: String(process.pid) },
        windowsHide: true,
      })
      sh.stderr.resume()
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
    case 'deep': {
      // 300k levels in about 600 KB: parses, but JSON.stringify on it overflows the stack.
      const depth = 300_000
      const line = `{"type":"event","event":{"type":"sdk","message":{"type":"assistant","a":${'['.repeat(depth)}${']'.repeat(depth)}},"truncated":false}}\n`
      // Through the channel's socket, which writes it all; one writeSync on it could write only part of it.
      void channel.writeRaw(line)
      break
    }
    case 'len':
      event({ type: 'sdk', message: { type: 'len', length: raw.config.prompt.length }, truncated: false })
      finished()
      end()
      break
    case 'finish-on-stop':
      ticks(Number(a), undefined, () => {})
      break
    case 'flood-on-stop': {
      const blob = 'f'.repeat(Number(b))
      for (let i = 0; i < Number(a); i++) event({ type: 'sdk', message: { type: 'assistant', i, blob }, truncated: false })
      break
    }
    case 'audit':
      void (async () => {
        const replies: unknown[] = []
        for (let i = 0; i < Number(a); i++) replies.push(await sendAudit(auditEntry(i)))
        event({ type: 'sdk', message: { type: 'audits', replies }, truncated: false })
        finished()
        end()
      })()
      break
    case 'audit-bad':
      send({ type: 'audit', id: 0, expiresAt: mono() + 10_000, entry: { hook: 'PreToolUse', toolName: 'Bash', decision: 'allow', input: 'x'.repeat(20_000) } })
      break
    case 'audit-on-stop':
      event({ type: 'sdk', message: { type: 'waiting' }, truncated: false })
      break
    case 'audit-after-end':
      finished()
      void sendAudit(auditEntry(0)).then((reply) => {
        writeFileSync('audit-reply.json', JSON.stringify(reply))
        end()
      })
      break
    case 'audit-expired':
      void sendAudit(auditEntry(0), mono() - 1).then((reply) => {
        event({ type: 'sdk', message: { type: 'audits', replies: [reply] }, truncated: false })
        finished()
        end()
      })
      break
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
