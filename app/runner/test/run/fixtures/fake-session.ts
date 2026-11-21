// A fake session process for the root's tests, spawned exactly as production spawns the real one. It speaks the local
// channel through the production channel module (src/session/channel.ts, no zod) and does what the run's prompt says:
//   echo:<marker>:<n>  sends n sdk events carrying the marker, then finished
//   race:<n>           sends n sdk events then finished, but a stop that arrives first ends it as stopped
//   crash              exits with code 3 without a terminal event
//   crash-after:<n>    sends n sdk events, then exits with code 3
//   crash-loud:<n>     writes n bytes of stderr (`<` + x's + `>`, a newline every 100 bytes), then exits with code 3
//   crash-canary       writes a crash trace to stderr whose message, an extra line and an indented chat line that
//                      starts like a frame (`    at the CHAT-CANARY meeting at 10:30:45`) carry CHAT-CANARY, with 10
//                      stack frames (`    at f<i> (file:///s.js:<i>:1)`), then exits with code 3
//   crash-stdout:<n>   writes n bytes of stdout (`STDOUT-TEXT` repeated, cut to n), then exits with code 3
//   stdout-flood:<n>   writes n bytes to stdout (in 16 KB writes, each awaited), then finished
//   garbage            sends a message that isn't in the local schema
//   bad-event          sends an event body that isn't a run event
//   raw-garbage        writes bytes that aren't JSON (nor UTF-8) straight onto the channel (fd 3)
//   stray-stdout       a stray process.stdout.write after ready (a log line in the wrong place), then finished
//   stdout-forgery     writes a well-formed `finished` event (costUsd 99) to stdout, then one sdk event and finished
//                      with costUsd 0: stdout isn't the channel, so the root must never read the forgery
//   process-stdio      what the SDK does on import: touches process.stdin (reads it to its end), process.stdout and
//                      process.stderr, then sends one sdk event {type: 'stdio', stdinBytes} and finished
//   close-channel      sends one sdk event, closes its end of the channel (fds 3 and 4), then never ends on its own
//   close-on-stop      writes `got-run` in its cwd and waits for stop, then closes its channel with no terminal event
//                      and never ends on its own
//   last-words:<n>:<bytes>:<first>  writes `got-run` in its cwd and waits for SIGUSR2; then sends <first> (`audit`: an
//                      audit entry; `audit-expired`: an expired one; `none`: nothing) without awaiting the answer, n sdk
//                      events of about <bytes> each carrying their index, and finished; closes its channel: fd 4 at
//                      once (`fd4-closed` in its cwd once it has closed), fd 3 once all of that is flushed to it
//                      (`closed` in its cwd then); exits 0 at the next SIGUSR2
//   split-words:<n>:<bytes>  writes `got-run` in its cwd and waits for SIGUSR2; then sends the first half of n sdk events
//                      of about <bytes> each, carrying their index; at the next SIGUSR2 the rest and finished, closes its
//                      channel and exits 0 once all of it is flushed
//   audit-flood        never reads the root again: blocks its own event loop writing expired audit entries straight onto
//                      the channel (fd 3), one after another, until it is killed
//   console-log        logs through every console method that writes to stdout by default, then finished
//   flood:<n>:<bytes>  sends n sdk events of about <bytes> each, carrying their index, then finished
//   drain:<n>:<bytes>  sends n sdk events of about <bytes> each, awaiting each send the channel says is full; then
//                      writes `drain: sent all` to stderr, one sdk event {type: 'drained', waits} counting those, then finished
//   oversized          sends one line over the channel's cap
//   dump               writes a file in its cwd, then sends its env, argv, run message and cwd files as one sdk event
//   hang               never answers; ends only when killed (a timer keeps it alive whatever happens to its channel)
//   obey-stop          waits for stop, then ends with failed/stopped
//   await-interrupt    waits for interrupt, then ends with failed/interrupted
//   big                sends one sdk event larger than the SDK message cap
//   grandchild         starts a shell the way the SDK starts the CLI, which writes to its fds 0 to 5 and to the
//                      session's channel (fds 3 and 4) and stdout through /proc, then finished
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
import { TO_ROOT_FD, openRootChannel } from '../../../src/session/channel.ts'

const channel = openRootChannel()
const send = (m: unknown) => channel.send(m)
const end = () => void channel.close().then(() => process.exit(0))
const event = (e: unknown) => send({ type: 'event', event: e })
const finished = () => event({ type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0, usage: {} })
/** The checkpoint every `cp:*` run reports (a literal: the tests expect it back in `released`). */
const CP = { type: 'checkpoint', mainEntries: 5, lastUuid: 'u-4', lastUuidIndex: 4, runEntries: 3 }

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
/** The part after the mode (`cp:honour` → `honour`), for the handlers of later root messages. */
let variant = ''
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
  if (raw?.type === 'stop' && mode === 'close-on-stop' && !ended) {
    ended = true
    void channel.close()
    setInterval(() => {}, 1000)
    return
  }
  if (raw?.type === 'stop' && (mode === 'obey-stop' || mode === 'race') && !ended) {
    ended = true
    event({ type: 'failed', reason: 'stopped', message: 'stopped' })
    end()
    return
  }
  // `cp:*`: a run with a query and a checkpoint, as the real session ends one (its checkpoint before its terminal event).
  if ((raw?.type === 'interrupt' || raw?.type === 'stop') && mode === 'cp' && !ended) {
    ended = true
    event(CP)
    // `cp:honour`: an interrupt the SDK honoured, as the real session now ends it (the SDK's error_during_execution result
    // kept: session/core.ts); otherwise the abort fallback's `failed interrupted`.
    if (raw.type === 'interrupt' && variant === 'honour') event({ type: 'finished', subtype: 'error_during_execution', isError: true, numTurns: 1, costUsd: 0.00007, usage: { input_tokens: 10 } })
    else event(raw.type === 'interrupt' ? { type: 'failed', reason: 'interrupted', message: 'interrupted' } : { type: 'failed', reason: 'stopped', message: 'stopped' })
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
  variant = raw.config.prompt.split(':')[1] ?? ''
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
    case 'late-query-started':
      // A query_started after the run's terminal event: the root still counts it (released.queryRan true).
      finished()
      send({ type: 'query_started' })
      end()
      break
    case 'cp':
      send({ type: 'query_started' })
      event({ type: 'sdk', message: { type: 'assistant', i: 0 }, truncated: false })
      if (a === 'finish') {
        ended = true
        event(CP)
        finished()
        end()
      }
      break
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
    case 'crash-canary': {
      const frames = Array.from({ length: 10 }, (_, i) => `    at f${i} (file:///s.js:${i}:1)`).join('\n')
      process.stderr.write(`said: CHAT-CANARY\n    at the CHAT-CANARY meeting at 10:30:45\nError: CHAT-CANARY in the message\n${frames}\n`, () => process.exit(3))
      break
    }
    case 'crash-stdout': {
      const n = Number(a)
      process.stdout.write('STDOUT-TEXT'.repeat(Math.ceil(n / 11)).slice(0, n), () => process.exit(3))
      break
    }
    case 'stdout-flood':
      void (async () => {
        for (let left = Number(a); left > 0; left -= 16 * 1024) {
          await new Promise<void>((r) => process.stdout.write('o'.repeat(Math.min(left, 16 * 1024)), () => r()))
        }
        finished()
        end()
      })()
      break
    case 'last-words': {
      const [, , , first] = raw.config.prompt.split(':')
      process.once('SIGUSR2', () => {
        if (first === 'audit') void sendAudit(auditEntry(0))
        if (first === 'audit-expired') void sendAudit(auditEntry(0), 0)
        const blob = 'w'.repeat(Number(b))
        for (let i = 0; i < Number(a); i++) event({ type: 'sdk', message: { type: 'assistant', i, blob }, truncated: false })
        finished()
        // close() closes fd 4 at once; its `close` (the descriptor is gone) is the first the channel reports.
        channel.onClose(() => writeFileSync('fd4-closed', ''))
        void channel.close().then(() => {
          process.once('SIGUSR2', () => process.exit(0))
          setInterval(() => {}, 1000)
          writeFileSync('closed', '')
        })
      })
      writeFileSync('got-run', '')
      break
    }
    case 'split-words': {
      const n = Number(a)
      const blob = 'w'.repeat(Number(b))
      const words = (from: number, to: number) => {
        for (let i = from; i < to; i++) event({ type: 'sdk', message: { type: 'assistant', i, blob }, truncated: false })
      }
      process.once('SIGUSR2', () => {
        process.once('SIGUSR2', () => {
          words(Math.ceil(n / 2), n)
          finished()
          void channel.close().then(() => process.exit(0))
        })
        words(0, Math.ceil(n / 2))
      })
      writeFileSync('got-run', '')
      break
    }
    case 'audit-flood': {
      // Blocks the event loop, so nothing the root sends is read again. The channel's fd is non-blocking: a full socket
      // gives EAGAIN, and the loop sleeps a millisecond and goes on. The nap is an EAGAIN back-off inside a fixture (so
      // the loop doesn't spin a core while the root's side is full), not a wait for a condition: the root ends this
      // session by killing it, whenever that comes.
      const nap = new Int32Array(new SharedArrayBuffer(4))
      for (let id = 0; ; id++) {
        const line = Buffer.from(`${JSON.stringify({ type: 'audit', id, expiresAt: 0, entry: auditEntry(id) })}\n`)
        for (let off = 0; off < line.length; ) {
          try {
            off += writeSync(TO_ROOT_FD, line, off)
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e
            Atomics.wait(nap, 0, 0, 1)
          }
        }
      }
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
      writeSync(TO_ROOT_FD, Buffer.from([0x00, 0xff, 0xfe, 0x7b, 0x0a]))
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
      // `protocol`. fds 1 and 2 are the shell's own pipes to this process; 0 is its stdin; 3, 4 and 5 must not be open
      // (the session's channel fds 3 and 4 are close-on-exec, so no child inherits them). Through /proc: each write's
      // exit code and error text (`proc-fd<n>=<code>:<error>`), and where the session's fd 0 points (`proc-fd0=`).
      const script = [
        'for fd in 0 1 2 3 4 5; do (echo leaked >&$fd) 2>/dev/null; done',
        'for fd in 1 3 4; do err=$( (echo leaked > /proc/$SESSION_PID/fd/$fd) 2>&1 ); echo "proc-fd$fd=$?:$err"; done',
        'echo "proc-fd0=$(readlink /proc/$SESSION_PID/fd/0 2>&1)"',
        'for fd in 3 4 5; do (: >&$fd) 2>/dev/null && echo "open-fd=$fd"; done',
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
      setInterval(() => {}, 1000)
      break
    case 'close-on-stop':
      writeFileSync('got-run', '')
      break
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
