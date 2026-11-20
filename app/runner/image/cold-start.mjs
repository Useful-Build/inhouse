#!/usr/bin/env node
// Cold start after a long idle (P3 R2): how long a deployed runner container takes to answer its first /health, and to
// start its first session, once it has been idle long enough to be stopped.
//
// Usage (the orchestrator runs it; nothing here names a host):
//   node app/runner/image/cold-start.mjs <base-url> [run-body.json]
//     <base-url>     the Worker route in front of the container, e.g. the harness's (`/health`, `POST /runs`).
//     run-body.json  the POST /runs body; default `{"scenario":"hello","chatId":"cold-start","prompt":"Say hello."}`,
//                    the harness's shape (scripted model, no real model call).
//   COLD_START_HEADER="name: value"  one extra request header (an access header the route needs), from the environment.
//   COLD_START_TIMEOUT_MS            the most each request may take (default 300000).
// Leave the container idle past its inactivity timeout first (the harness: 10 minutes), then run it once. Each step is
// one request (no retries): a failure is part of the measurement and is printed as such.
//
// Output: one JSON line, times in ms from the script's start:
//   { health: { ms, status, body }, run: { status, startedMs, initMs, endMs, end }, error? }
// `startedMs` is the run's `started` event (the session user allocated), `initMs` the SDK's init message (the CLI is up:
// the session start), `endMs` its terminal event.
import { readFileSync } from 'node:fs'

const [base, bodyFile] = process.argv.slice(2)
if (!base) {
  console.error('usage: node cold-start.mjs <base-url> [run-body.json]')
  process.exit(2)
}
const timeoutMs = Number(process.env.COLD_START_TIMEOUT_MS ?? 300_000)
const headers = {}
if (process.env.COLD_START_HEADER) {
  const at = process.env.COLD_START_HEADER.indexOf(':')
  headers[process.env.COLD_START_HEADER.slice(0, at).trim()] = process.env.COLD_START_HEADER.slice(at + 1).trim()
}
const body = bodyFile ? readFileSync(bodyFile, 'utf8') : JSON.stringify({ scenario: 'hello', chatId: 'cold-start', prompt: 'Say hello.' })
const t0 = performance.now()
const since = () => Math.round(performance.now() - t0)
const out = { health: null, run: null }

try {
  const h = await fetch(new URL('/health', base), { headers, signal: AbortSignal.timeout(timeoutMs) })
  out.health = { ms: since(), status: h.status, body: (await h.text()).slice(0, 500) }

  const res = await fetch(new URL('/runs', base), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) })
  const run = { status: res.status, startedMs: null, initMs: null, endMs: null, end: null }
  out.run = run
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of res.body ?? []) {
    buffered += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim()
      buffered = buffered.slice(nl + 1)
      if (line === '') continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        run.end = { unreadable: line.slice(0, 200) }
        continue
      }
      if (e.type === 'started') run.startedMs ??= since()
      if (e.type === 'sdk' && e.message?.type === 'system' && e.message?.subtype === 'init') run.initMs ??= since()
      if (e.type === 'finished' || e.type === 'failed') {
        run.endMs = since()
        run.end = e.type === 'failed' ? { type: e.type, reason: e.reason, message: e.message } : { type: e.type, subtype: e.subtype }
      }
    }
  }
  if (res.status !== 200) run.end = { body: buffered.slice(0, 500) }
} catch (e) {
  out.error = { atMs: since(), message: String(e instanceof Error ? e.message : e) }
}
console.log(JSON.stringify(out))
process.exit(out.error || out.run?.end?.type !== 'finished' ? 1 : 0)
