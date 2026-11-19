// The root runner against real session processes (fixtures speaking the local channel), through its HTTP API.
// Ways it could fail, written first:
// - a session that crashes, or sends garbage, takes the root down or leaves its run without an end (or with two ends);
// - two sessions' events cross into each other's streams, or a stream's seq has a gap or a repeat;
// - the run token reaches the session: its env, argv, the run message, or a file it writes; or a log line;
// - a request with an unaccepted protocol version is served; the previous version is refused;
// - an oversized SDK message is passed through whole;
// - a stop never ends a session that ignores it.
import { fc, it } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect } from 'vitest'
import { ACCEPTED_VERSIONS, PROTOCOL_HEADER, PROTOCOL_VERSION, ProtocolInfo, type RunEvent } from '../../../shared/protocol/index.ts'
import { postRun, protocolHeaders, runStart, startTestRoot, type TestRoot } from './support/root-client.ts'
import { spawnFixture } from './support/test-seams.ts'

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
  ])('%s: one failed event (%s) and the root stays up', async (prompt, reason) => {
    const events = await postRun(root, runStart({ prompt }))
    expectOneEnd(events)
    expect(events.at(-1)).toMatchObject({ type: 'failed', reason })
    await stillServes()
    expect(root.liveCount()).toBe(0)
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
    await waitFor(() => root.tokenForUid(process.getuid!()) !== null)
    expect(root.tokenForUid(process.getuid!())).toBe('tok_held_while_live_0001')
    await fetch(`${root.url}/runs/${start.runId}/stop`, { method: 'POST', headers: protocolHeaders })
    await pending
    expect(root.tokenForUid(process.getuid!())).toBeNull()
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

  it('no header gets 426', async () => {
    const res = await fetch(`${root.url}/runs`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(426)
  })

  it('the previous version is accepted', async () => {
    const events = await postRun(root, runStart())
    expect(events.at(-1)?.type).toBe('finished')
    const res = await fetch(`${root.url}/runs/none/stop`, { method: 'POST', headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION - 1) } })
    expect(res.status).toBe(404)
  })
})

/** Polls a condition on the event loop (no fixed sleep): resolves as soon as it holds, fails after 5 s. */
async function waitFor(cond: () => boolean) {
  const deadline = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met')
    await new Promise((r) => setImmediate(r))
  }
}
