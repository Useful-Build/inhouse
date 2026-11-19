// The root runner against real session processes (fixtures speaking the local channel), through its HTTP API.
// Ways it could fail, written first:
// - a session that crashes, or sends garbage, takes the root down or leaves its run without an end (or with two ends);
// - two sessions' events cross into each other's streams, or a stream's seq has a gap or a repeat;
// - the run token reaches the session: its env, argv, the run message, or a file it writes; or a log line;
// - a request with an unaccepted protocol version is served; the previous version is refused;
// - an oversized SDK message is passed through whole;
// - a stop never ends a session that ignores it;
// - a run raced by a stop or a crash ends twice, or with a seq gap.
import type { ChildProcess } from 'node:child_process'
import http from 'node:http'
import { fc, it } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect } from 'vitest'
import { ACCEPTED_VERSIONS, PROMPT_MAX_CHARS, PROTOCOL_HEADER, PROTOCOL_VERSION, ProtocolInfo, parseRunEventLine, type RunEvent } from '../../../shared/protocol/index.ts'
import { openRun, post, postRun, protocolHeaders, runStart, startTestRoot, waitFor, type TestRoot } from './support/root-client.ts'
import { spawnFixture } from './support/test-seams.ts'
import { LOCAL_LINE_MAX_BYTES } from '../../src/protocol/ndjson.ts'
import { API_MAX_CONNECTIONS } from '../../src/server/app.ts'

let root: TestRoot
beforeEach(async () => {
  root = await startTestRoot(spawnFixture('fake-session.ts'))
})
afterEach(async () => {
  await root.close()
})

function expectOneEnd(events: RunEvent[]) {
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
  expect(events[0]?.type).toBe('started')
  const ends = events.filter((e) => e.type === 'finished' || e.type === 'failed')
  expect(ends).toHaveLength(1)
  expect(events.at(-1)).toBe(ends[0])
}

async function stillServes() {
  const res = await fetch(`${root.url}/health`)
  expect(res.status).toBe(200)
  expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
}

describe('a session that misbehaves', () => {
  it.each([
    ['crash', 'session_crashed'],
    ['garbage', 'protocol'],
    ['bad-event', 'protocol'],
    ['raw-garbage', 'protocol'],
    ['stray-stdout', 'protocol'],
    ['oversized', 'protocol'],
    ['deep', 'protocol'],
  ])('%s: one failed event (%s) and the root stays up', async (prompt, reason) => {
    const events = await postRun(root, runStart({ prompt }))
    expectOneEnd(events)
    expect(events.at(-1)).toMatchObject({ type: 'failed', reason })
    await stillServes()
    expect(root.liveCount()).toBe(0)
  })

  it('a stray write to stdout ends only that session (protocol); a concurrent session finishes', async () => {
    const [stray, other] = await Promise.all([postRun(root, runStart({ prompt: 'stray-stdout' })), postRun(root, runStart({ prompt: 'echo:m:3' }))])
    expectOneEnd(stray!)
    expect(stray!.at(-1)).toMatchObject({ type: 'failed', reason: 'protocol' })
    expectOneEnd(other!)
    expect(other!.at(-1)?.type).toBe('finished')
    await stillServes()
  })

  it('console output in the session goes to stderr, never the channel', async () => {
    const events = await postRun(root, runStart({ prompt: 'console-log' }))
    expectOneEnd(events)
    expect(events.at(-1)?.type).toBe('finished')
  })

  it('a session that ignores stop is killed after the grace and ends as stopped', async () => {
    const short = await startTestRoot(spawnFixture('fake-session.ts'), { stopGraceMs: 50 })
    try {
      const start = runStart({ prompt: 'hang' })
      const pending = postRun(short, start)
      await waitFor(() => short.liveCount() === 1)
      const res = await fetch(`${short.url}/runs/${start.runId}/stop`, { method: 'POST', headers: protocolHeaders })
      expect(res.status).toBe(202)
      const events = await pending
      expectOneEnd(events)
      expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'stopped' })
    } finally {
      await short.close()
    }
  })

  it('a session that obeys stop ends with its own stopped event', async () => {
    const start = runStart({ prompt: 'obey-stop' })
    const pending = postRun(root, start)
    await waitFor(() => root.liveCount() === 1)
    await fetch(`${root.url}/runs/${start.runId}/stop`, { method: 'POST', headers: protocolHeaders })
    const events = await pending
    expectOneEnd(events)
    expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'stopped' })
  })

  it('a run over its time limit ends with timeout', async () => {
    const short = await startTestRoot(spawnFixture('fake-session.ts'), { runTimeoutMs: 30, stopGraceMs: 50 })
    try {
      const events = await postRun(short, runStart({ prompt: 'hang' }))
      expectOneEnd(events)
      expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'timeout' })
    } finally {
      await short.close()
    }
  })
})

describe('streams', () => {
  it('an oversized SDK message arrives as a truncated stub', async () => {
    const events = await postRun(root, runStart({ prompt: 'big' }))
    const sdk = events.find((e) => e.type === 'sdk')
    expect(sdk).toMatchObject({ truncated: true, message: { type: 'assistant', subtype: 'x' } })
    expect(JSON.stringify(sdk).length).toBeLessThan(1000)
  })

  it.prop([fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 2, maxLength: 5 })], { numRuns: 8 })(
    'concurrent sessions: each stream holds only its own events, seq from 0 with no gaps',
    async (counts) => {
      const starts = counts.map((n, i) => runStart({ prompt: `echo:marker${i}:${n}` }))
      const streams = await Promise.all(starts.map((s) => postRun(root, s)))
      streams.forEach((events, i) => {
        expectOneEnd(events)
        expect(events.every((e) => e.runId === starts[i]!.runId)).toBe(true)
        const sdk = events.filter((e) => e.type === 'sdk')
        expect(sdk).toHaveLength(counts[i]!)
        expect(sdk.every((e) => e.type === 'sdk' && e.message.marker === `marker${i}`)).toBe(true)
        expect(events.at(-1)?.type).toBe('finished')
      })
    },
  )

  // Runs whose end is decided by a race: a stop sent after some events against the session's own finish, a crash
  // part-way, a timeout that lands mid-run and races the session's finish, a plain finish; all at once. Whatever wins,
  // each run has one end and no seq gaps, and only its own events.
  const racer = fc.record({
    n: fc.integer({ min: 0, max: 8 }),
    end: fc.constantFrom('finish', 'stop', 'crash', 'timeout'),
    stopAfter: fc.integer({ min: 0, max: 8 }),
  })
  it.prop([fc.array(racer, { minLength: 2, maxLength: 5 })], { numRuns: 10 })(
    'concurrent sessions ending by races (stop, crash, timeout, finish): one end each, no seq gaps',
    async (runs) => {
      // Only the timeout racers run on a root with a short time limit; the rest stay on the default root's long one, so
      // a finish or stop racer on a loaded machine can't be cut off by the timeout meant for the held runs.
      const timed = await startTestRoot(spawnFixture('fake-session.ts'), { runTimeoutMs: 1500, stopGraceMs: 50 })
      try {
        await raceRuns((r) => (r.end === 'timeout' ? timed : root), runs)
        await waitFor(() => timed.liveCount() === 0)
      } finally {
        await timed.close()
      }
    },
    60_000,
  )

  type Racer = { n: number; end: string; stopAfter: number }
  async function raceRuns(rootFor: (r: Racer) => TestRoot, runs: Racer[]) {
    {
      const prompt = (r: { n: number; end: string }) =>
        r.end === 'crash' ? `crash-after:${r.n}` : r.end === 'timeout' ? `finish-on-stop:${r.n}` : `race:${r.n}`
      const opened = runs.map((r) => {
        const start = runStart({ prompt: prompt(r) })
        return { r, start, run: openRun(rootFor(r), start) }
      })
      await Promise.all(
        opened.map(async ({ r, start, run }) => {
          if (r.end !== 'stop') return
          await waitFor(() => run.events.length >= Math.min(r.stopAfter, r.n) + 1 || run.events.some((e) => e.type === 'finished' || e.type === 'failed'))
          expect([202, 404]).toContain(await post(rootFor(r), `/runs/${start.runId}/stop`))
        }),
      )
      const streams = await Promise.all(opened.map((o) => o.run.done))
      streams.forEach((events, i) => {
        const { r, start } = opened[i]!
        expectOneEnd(events)
        expect(events.every((e) => e.runId === start.runId)).toBe(true)
        const last = events.at(-1)!
        if (r.end === 'finish') expect(last.type).toBe('finished')
        if (r.end === 'crash') expect(last).toMatchObject({ type: 'failed', reason: 'session_crashed' })
        if (r.end === 'stop') expect(last.type === 'finished' || (last.type === 'failed' && last.reason === 'stopped')).toBe(true)
        // Held mid-run until the timeout's stop, which makes it send finished: the root's timeout came first and stands.
        if (r.end === 'timeout') {
          expect(last).toMatchObject({ type: 'failed', reason: 'timeout' })
          expect(events.filter((e) => e.type === 'sdk')).toHaveLength(r.n)
        }
      })
      await waitFor(() => root.liveCount() === 0)
    }
  }

  it("a slow Worker pauses reading the session's stdout: memory stays bounded, nothing is lost or reordered", async () => {
    const spawned: ChildProcess[] = []
    const slow = await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }))
    try {
      // About 32 MB of events: far more than the pipes, the sockets and the kernel's buffers on the way can hold.
      const n = 160
      const start = runStart({ prompt: `flood:${n}:${200 * 1024}` })
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(`${slow.url}/runs`, { method: 'POST', headers: protocolHeaders }, resolve)
        req.on('error', reject)
        req.end(JSON.stringify(start))
      })
      expect(res.statusCode).toBe(200)
      // The response isn't read yet: its socket fills, the root's write returns false and it stops reading the session.
      await waitFor(() => spawned.length === 1 && spawned[0]!.stdout!.isPaused(), 'the root paused the session')
      const out = spawned[0]!.stdout!
      // Then it stays stalled: paused, and holding no more than its buffers' worth, whatever the kernel takes first.
      let quiet = 0
      let last = -1
      await waitFor(() => {
        const buffered = slow.bufferedBytes(start.runId)
        expect(buffered).not.toBeNull()
        expect(buffered!).toBeLessThanOrEqual(LOCAL_LINE_MAX_BYTES)
        expect(out.readableLength).toBeLessThanOrEqual(out.readableHighWaterMark + LOCAL_LINE_MAX_BYTES)
        quiet = out.isPaused() && buffered === last ? quiet + 1 : 0
        last = buffered!
        return quiet >= 100
      }, 'the run stalled behind the slow Worker')
      // The session is held up writing, not done.
      expect(spawned[0]!.exitCode).toBeNull()

      // Now the Worker reads: every event arrives, once, in order.
      const events: RunEvent[] = []
      let buf = ''
      res.setEncoding('utf8')
      for await (const chunk of res as AsyncIterable<string>) {
        buf += chunk
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          events.push(parseRunEventLine(buf.slice(0, i)))
          buf = buf.slice(i + 1)
        }
      }
      expect(buf).toBe('')
      expectOneEnd(events)
      expect(events.at(-1)?.type).toBe('finished')
      const sdk = events.filter((e) => e.type === 'sdk')
      expect(sdk.map((e) => (e.type === 'sdk' ? e.message.i : null))).toEqual([...Array(n).keys()])
      expect(sdk.every((e) => e.type === 'sdk' && !e.truncated)).toBe(true)
    } finally {
      await slow.close()
    }
  })

  it("the session's channel says when it is full, and the session waits for it to drain", async () => {
    // When a write says "full" depends on the kernel's buffers (a socketpair holds far more on Linux than on macOS), so
    // the test makes the channel full by condition: the Worker doesn't read, the root pauses the session, and then the
    // session's channel can't take what it still has to send (about 32 MB, as in the slow-Worker test above).
    const spawned: ChildProcess[] = []
    let stderr = ''
    const onSpawn = (c: ChildProcess) => {
      spawned.push(c)
      c.stderr!.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    }
    const slow = await startTestRoot(spawnFixture('fake-session.ts', { onSpawn }))
    try {
      const n = 160
      const start = runStart({ prompt: `drain:${n}:${200 * 1024}` })
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(`${slow.url}/runs`, { method: 'POST', headers: protocolHeaders }, resolve)
        req.on('error', reject)
        req.end(JSON.stringify(start))
      })
      expect(res.statusCode).toBe(200)
      await waitFor(() => spawned.length === 1 && spawned[0]!.stdout!.isPaused(), 'the root paused the session')
      // Stalled: the root holds the same bytes, poll after poll. A session that didn't wait would have run its loop to
      // the end by now (its sends only queue in its own memory); one that waits is held at a full channel.
      let quiet = 0
      let last = -1
      await waitFor(() => {
        const buffered = slow.bufferedBytes(start.runId)!
        quiet = spawned[0]!.stdout!.isPaused() && buffered === last ? quiet + 1 : 0
        last = buffered
        return quiet >= 100
      }, 'the run stalled behind the slow Worker')
      expect(stderr).not.toContain('drain: sent all')
      const events: RunEvent[] = []
      let buf = ''
      res.setEncoding('utf8')
      for await (const chunk of res as AsyncIterable<string>) {
        buf += chunk
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          events.push(parseRunEventLine(buf.slice(0, i)))
          buf = buf.slice(i + 1)
        }
      }
      expect(buf).toBe('')
      expectOneEnd(events)
      expect(events.at(-1)?.type).toBe('finished')
      const sdk = events.filter((e) => e.type === 'sdk')
      expect(sdk.slice(0, n).map((e) => (e.type === 'sdk' ? e.message.i : null))).toEqual([...Array(n).keys()])
      // The channel said "full" at least once, and the session waited out each of those before its next send.
      expect(sdk).toHaveLength(n + 1)
      const drained = sdk.at(-1)
      expect(drained).toMatchObject({ message: { type: 'drained' } })
      const waits = drained?.type === 'sdk' ? (drained.message as { waits: number }).waits : 0
      expect(waits).toBeGreaterThanOrEqual(1)
      expect(waits).toBeLessThanOrEqual(n)
    } finally {
      await slow.close()
    }
  })

  // Paused behind a slow Worker, then the Worker hangs up or the run times out: no drain will come, so the root must
  // read on (and drop) what the session still sends, letting it flush and exit by itself rather than be killed.
  it.each(['hang-up', 'timeout'])("paused for backpressure, then %s: the session is read to its end and exits cleanly", async (how) => {
    const spawned: ChildProcess[] = []
    const runTimeoutMs = how === 'timeout' ? 4000 : 60_000
    const slow = await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }), { stopGraceMs: 5000, runTimeoutMs })
    try {
      const t0 = Date.now()
      const start = runStart({ prompt: `flood:160:${200 * 1024}` })
      const req = http.request(`${slow.url}/runs`, { method: 'POST', headers: protocolHeaders })
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        req.on('response', resolve).on('error', reject)
        req.end(JSON.stringify(start))
      })
      // Paused before the timeout fires: once the run has ended, the root never pauses again, so this would fail.
      await waitFor(() => spawned.length === 1 && spawned[0]!.stdout!.isPaused(), 'the root paused the session')
      const child = spawned[0]!
      // And stalled for good: every buffer on the way to the test is full (32 MB is far more than they hold), so no
      // drain can come from the Worker's side any more. Only the timer's own resume can let the session go on.
      let quiet = 0
      let last = -1
      await waitFor(() => {
        const buffered = slow.bufferedBytes(start.runId)!
        quiet = child.stdout!.isPaused() && buffered === last ? quiet + 1 : 0
        last = buffered
        return quiet >= 100
      }, 'the run stalled behind the slow Worker')
      // The stall came before the timer: otherwise this case proves nothing.
      if (how === 'timeout') expect(Date.now() - t0).toBeLessThan(runTimeoutMs)
      const exited = new Promise<[number | null, NodeJS.Signals | null]>((r) => child.once('exit', (code, signal) => r([code, signal])))
      if (how === 'hang-up') {
        res.destroy()
        req.destroy()
      } else await waitFor(() => !child.stdout!.isPaused(), 'the timeout resumed the session')
      // The flood ignores stop: it ends by itself once every line is read. Killed after the grace, it'd be SIGKILL.
      expect(await exited).toEqual([0, null])
      await waitFor(() => slow.liveCount() === 0)
      if (how === 'timeout') {
        const events: RunEvent[] = []
        let buf = ''
        res.setEncoding('utf8')
        for await (const chunk of res as AsyncIterable<string>) buf += chunk
        for (const l of buf.split('\n').filter(Boolean)) events.push(parseRunEventLine(l))
        expectOneEnd(events)
        expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'timeout' })
      }
    } finally {
      await slow.close()
    }
  }, 30_000)

  // Paused behind a slow Worker, then stopped: the session's answer to the stop (its finished, with cost and usage)
  // must get out within the grace, so the root reads it on rather than leaving it stuck behind the pause until killed.
  it.each(['stop', 'stopAll'])('paused for backpressure, then %s: the session flushes its finished and exits cleanly', async (how) => {
    const spawned: ChildProcess[] = []
    const slow = await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }), { stopGraceMs: 2000 })
    try {
      const n = 40
      const start = runStart({ prompt: `flood-on-stop:${n}:${200 * 1024}` })
      const req = http.request(`${slow.url}/runs`, { method: 'POST', headers: protocolHeaders })
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        req.on('response', resolve).on('error', reject)
        req.end(JSON.stringify(start))
      })
      await waitFor(() => spawned.length === 1 && spawned[0]!.stdout!.isPaused(), 'the root paused the session')
      const child = spawned[0]!
      const exited = new Promise<[number | null, NodeJS.Signals | null]>((r) => child.once('exit', (code, signal) => r([code, signal])))
      const stopped = how === 'stop' ? post(slow, `/runs/${start.runId}/stop`) : slow.stopAll()
      // Killed after the grace, it'd be SIGKILL; the Worker still isn't reading.
      expect(await exited).toEqual([0, null])
      let buf = ''
      res.setEncoding('utf8')
      for await (const chunk of res as AsyncIterable<string>) buf += chunk
      await stopped
      const events = buf.split('\n').filter(Boolean).map(parseRunEventLine)
      expectOneEnd(events)
      expect(events.filter((e) => e.type === 'sdk')).toHaveLength(n)
      expect(events.at(-1)).toMatchObject({ type: 'finished', costUsd: 0.25, usage: { output_tokens: 7 } })
    } finally {
      await slow.close()
    }
  }, 30_000)

  it("a valid RunStart at its largest (a prompt of control characters, 1.2 MB as JSON) reaches the session whole", async () => {
    const prompt = `len:${'\u0001'.repeat(PROMPT_MAX_CHARS - 4)}`
    const events = await postRun(root, runStart({ prompt }))
    expectOneEnd(events)
    expect(events.find((e) => e.type === 'sdk')).toMatchObject({ message: { type: 'len', length: PROMPT_MAX_CHARS } })
    expect(events.at(-1)?.type).toBe('finished')
  })

  it('one live run per chat', async () => {
    const first = runStart({ prompt: 'obey-stop' })
    const pending = postRun(root, first)
    await waitFor(() => root.liveCount() === 1)
    const res = await fetch(`${root.url}/runs`, { method: 'POST', headers: protocolHeaders, body: JSON.stringify(runStart({ chatId: first.chatId })) })
    expect(res.status).toBe(409)
    await fetch(`${root.url}/runs/${first.runId}/stop`, { method: 'POST', headers: protocolHeaders })
    await pending
  })
})

describe('the run token stays in the root', () => {
  // Printable, no spaces, as RunStart allows; long enough that a chance match in the env or a path is impossible.
  const token = fc.stringMatching(/^[\x21-\x7e]{24,80}$/).filter((t) => !t.includes('\\') && !t.includes('"'))

  it.prop([token], { numRuns: 6 })('absent from the session env, argv, run message, written files and the logs', async (runToken) => {
    const events = await postRun(root, runStart({ prompt: 'dump', runToken }))
    expectOneEnd(events)
    const dump = events.find((e) => e.type === 'sdk')
    expect(dump).toBeDefined()
    const seen = JSON.stringify(dump)
    expect(seen).toContain('written-by-session.txt')
    expect(seen).not.toContain(runToken)
    expect(JSON.stringify(root.logs)).not.toContain(runToken)
    if (dump?.type !== 'sdk') throw new Error('no dump')
    expect((dump.message.run as { config: Record<string, unknown> }).config).not.toHaveProperty('runToken')
  })

  it('the token is held, by uid, only while its run is live', async () => {
    const start = runStart({ prompt: 'obey-stop', runToken: 'tok_held_while_live_0001' })
    const pending = postRun(root, start)
    await waitFor(() => root.users.uids.has(start.chatId) && root.tokenForUid(root.users.uids.get(start.chatId)!) !== null)
    const uid = root.users.uids.get(start.chatId)!
    expect(root.tokenForUid(uid)).toBe('tok_held_while_live_0001')
    await fetch(`${root.url}/runs/${start.runId}/stop`, { method: 'POST', headers: protocolHeaders })
    await pending
    expect(root.tokenForUid(uid)).toBeNull()
  })

  it('a bad RunStart is refused without echoing the token', async () => {
    const runToken = 'tok_must_not_echo_00000000'
    const res = await fetch(`${root.url}/runs`, { method: 'POST', headers: protocolHeaders, body: JSON.stringify({ ...runStart({ runToken }), maxTurns: -1 }) })
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain(runToken)
  })
})

describe('protocol version', () => {
  it('GET /protocol answers the version and the accepted list without a header', async () => {
    const res = await fetch(`${root.url}/protocol`)
    expect(ProtocolInfo.parse(await res.json())).toEqual({ version: PROTOCOL_VERSION, accepted: [...ACCEPTED_VERSIONS] })
  })

  it.prop([fc.integer({ min: -5, max: 50 })])('a version outside ACCEPTED_VERSIONS gets 426 with the runner version', async (v) => {
    const res = await fetch(`${root.url}/runs/none/interrupt`, { method: 'POST', headers: { [PROTOCOL_HEADER]: String(v) } })
    if (ACCEPTED_VERSIONS.includes(v)) expect(res.status).toBe(404)
    else {
      expect(res.status).toBe(426)
      expect(await res.json()).toMatchObject({ version: PROTOCOL_VERSION })
    }
  })

  it('the API caps how many connections it holds at once', () => {
    expect(root.server.maxConnections).toBe(API_MAX_CONNECTIONS)
  })

  it('no header gets 426', async () => {
    const res = await fetch(`${root.url}/runs`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(426)
  })

  it('a non-canonical spelling of the current version gets 426', async () => {
    for (const v of [`0${PROTOCOL_VERSION}`, `+${PROTOCOL_VERSION}`, `${PROTOCOL_VERSION}.0`, `${PROTOCOL_VERSION}e0`]) {
      const res = await fetch(`${root.url}/runs/none/stop`, { method: 'POST', headers: { [PROTOCOL_HEADER]: v } })
      expect(res.status, v).toBe(426)
    }
  })
})
