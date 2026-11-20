// The root's run lifecycle around the session process: start, stop, the Worker's end, shutdown, and what each leaves behind.
// Ways it could fail, written first:
// - a stop or interrupt that lands while the run is still starting (allocating, or spawned but not ready) is lost, and
//   the run carries on;
// - the Worker ends the run (a 410, or an ack with stop) and the run keeps going, or keeps its chat, uid or token;
// - a spawn that throws leaves the run listed, the chat taken (409 forever) or the token mapped;
// - the chat frees before release() settles, so the next run's allocate races the last run's release;
// - a timeout racing the session's finish gives two ends;
// - SIGTERM (stopAll) misses a run that is still starting, or new runs are let in while stopping;
// - a tool the CLI starts can write into the channel (fds 3 and 4), inherits it, or opens it through /proc; a process
//   the session left behind outlives the run;
// - a uid maps to the wrong token, or to a token after its run's session has gone.
import { spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { RunStatus, type RunEvent } from '../../../shared/protocol/index.ts'
import { pickToken } from '../../src/server/app.ts'
import { openRun, post, postRun, protocolHeaders, runStart, startTestRoot, waitFor, type TestRoot } from './support/root-client.ts'
import { gate, spawnFixture, testSessionUsers } from './support/test-seams.ts'

function expectOneEnd(events: RunEvent[]) {
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
  expect(events[0]?.type).toBe('started')
  const ends = events.filter((e) => e.type === 'finished' || e.type === 'failed')
  expect(ends).toHaveLength(1)
  expect(events.at(-1)).toBe(ends[0])
}

async function withRoot<T>(root: TestRoot, fn: (root: TestRoot) => Promise<T>): Promise<T> {
  try {
    return await fn(root)
  } finally {
    await root.close()
  }
}

/** What the grandchild fixture's shell printed. */
const grandchildOut = (events: RunEvent[]) => {
  const sdk = events.find((e) => e.type === 'sdk')
  expect(sdk).toMatchObject({ message: { type: 'grandchild', code: 0 } })
  return sdk?.type === 'sdk' ? String(sdk.message.out) : ''
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether a process is running: it exists and isn't a zombie (killed, waiting for its parent to reap it). */
const running = (pid: number) => {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return stat !== '' && !stat.startsWith('Z')
}

describe('a stop or interrupt while the run is starting', () => {
  it('a stop during allocate is answered 202 and ends the run as stopped without spawning', async () => {
    const allocating = gate()
    const spawned: ChildProcess[] = []
    const users = testSessionUsers({ onAllocate: () => allocating.promise })
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }), { users }), async (root) => {
      const start = runStart({ prompt: 'echo:m:3' })
      const run = openRun(root, start)
      await waitFor(() => users.allocated.length === 1)
      expect(await post(root, `/runs/${start.runId}/stop`)).toBe(202)
      allocating.open()
      const events = await run.done
      expectOneEnd(events)
      expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'stopped' })
      expect(spawned).toHaveLength(0)
      expect(users.released).toEqual([start.chatId])
      expect(root.liveCount()).toBe(0)
    })
  })

  it('a stop between spawn and ready is applied at ready: the session gets the stop and never the run', async () => {
    const spawned: ChildProcess[] = []
    const users = testSessionUsers({ onAllocate: (_, dir) => writeFileSync(join(dir, 'hold-ready'), '') })
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }), { users }), async (root) => {
      const start = runStart({ prompt: 'obey-stop' })
      const run = openRun(root, start)
      await waitFor(() => spawned.length === 1 && existsSync(join(users.dirs.get(start.chatId)!, 'waiting-for-usr2')))
      expect(await post(root, `/runs/${start.runId}/stop`)).toBe(202)
      spawned[0]!.kill('SIGUSR2')
      const events = await run.done
      expectOneEnd(events)
      // The session's own stopped event, for a stop with no run before it (the fixture says which it got).
      expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'stopped', message: 'stopped before the run started' })
      expect(events.filter((e) => e.type === 'sdk')).toEqual([])
    })
  })

  it('an interrupt before ready is recorded and sent after the run', async () => {
    const spawned: ChildProcess[] = []
    const users = testSessionUsers({ onAllocate: (_, dir) => writeFileSync(join(dir, 'hold-ready'), '') })
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }), { users }), async (root) => {
      const start = runStart({ prompt: 'await-interrupt' })
      const run = openRun(root, start)
      await waitFor(() => spawned.length === 1 && existsSync(join(users.dirs.get(start.chatId)!, 'waiting-for-usr2')))
      expect(await post(root, `/runs/${start.runId}/interrupt`)).toBe(202)
      spawned[0]!.kill('SIGUSR2')
      const events = await run.done
      expectOneEnd(events)
      expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'interrupted' })
    })
  })
})

describe('the Worker ends the run (protocol v2: a hang-up no longer exists; a 410 or a fence does it)', () => {
  it.each([
    ['before ready', 'hold-ready'],
    ['mid-run', null],
  ])('a 410 %s: the session is stopped, nothing more is pushed, and the run, chat and token are gone', async (_, marker) => {
    const spawned: ChildProcess[] = []
    const users = testSessionUsers({ onAllocate: (_k, dir) => (marker ? writeFileSync(join(dir, marker), '') : undefined) })
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }), { users, stopGraceMs: 50 }), async (root) => {
      const start = runStart({ prompt: 'hang' })
      root.egress.onPush = (b) => (b.turnId === start.runId ? new Response('ended', { status: 410 }) : null)
      const run = openRun(root, start)
      await run.admitted
      await waitFor(() => spawned.length === 1 && root.logs.some((l) => l.type === 'push_gone'), 'the 410')
      await waitFor(() => root.liveCount() === 0, 'the run to end')
      expect(spawned[0]!.exitCode !== null || spawned[0]!.signalCode !== null).toBe(true)
      expect(users.released).toEqual([start.chatId])
      expect(root.tokenForUid(users.uids.get(start.chatId)!)).toBeNull()
      // One batch went, and nothing after its 410.
      expect(root.egress.pushes.filter((p) => p.runId === start.runId)).toHaveLength(1)
    })
  })

  it('an ack with stop: true stops the run; its terminal event and released still reach the Worker', async () => {
    const spawned: ChildProcess[] = []
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }), { stopGraceMs: 2000 }), async (root) => {
      const start = runStart({ prompt: 'hang' })
      root.egress.stopRuns.add(start.runId)
      const run = openRun(root, start)
      const events = await run.done
      // The first push (`started`, on the flush timer) is acked with stop: the run ends stopped, whatever stage it was at.
      expect(events[0]?.type).toBe('started')
      expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'stopped' })
      expect(await run.released).toMatchObject({ type: 'released', checkpoint: null, queryRan: false })
      expect(root.logs).toContainEqual({ type: 'worker_fenced', runId: start.runId })
      expect(root.egress.violations).toEqual([])
    })
  })
})

describe('a session user that is root', () => {
  it.each([
    ['uid', { uidFor: () => 0 }],
    ['gid', { gidFor: () => 0 }],
  ] as const)('a run allocated root %s is refused, nothing is spawned, and the user is still released', async (_, seam) => {
    const spawned: ChildProcess[] = []
    const users = testSessionUsers(seam)
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }), { users }), async (root) => {
      const start = runStart()
      const res = await fetch(`${root.url}/runs`, { method: 'POST', headers: protocolHeaders, body: JSON.stringify(start) })
      expect(res.status).toBe(500)
      await waitFor(() => root.liveCount() === 0)
      expect(spawned).toHaveLength(0)
      expect(users.released).toEqual([start.chatId])
      expect(root.logs).toContainEqual(expect.objectContaining({ type: 'session_user_refused', reason: 'root' }))
    })
  })
})

describe('a spawn that throws', () => {
  it('ends the run with one session_crashed, releases the user and frees the chat and the token', async () => {
    const users = testSessionUsers()
    const throwing = () => {
      throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })
    }
    await withRoot(await startTestRoot(throwing, { users }), async (root) => {
      const start = runStart()
      const events = await postRun(root, start)
      expectOneEnd(events)
      expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'session_crashed' })
      expect(users.released).toEqual([start.chatId])
      expect(root.liveCount()).toBe(0)
      expect(root.tokenForUid(users.uids.get(start.chatId)!)).toBeNull()
      // The chat is free again.
      const again = await postRun(root, runStart({ chatId: start.chatId }))
      expect(again.at(-1)).toMatchObject({ type: 'failed', reason: 'session_crashed' })
    })
  })
})

describe('timeouts', () => {
  // The fixture is held mid-run (after n events) until a stop, and answers the stop with its own finished: the timer
  // always lands mid-run, and the session's finish always races the timeout the root has just decided.
  it.prop([fc.integer({ min: 0, max: 6 })], { numRuns: 5 })(
    'a timeout landing mid-run, raced by the session finishing: one end, the timeout, and the session exits by itself',
    async (n) => {
      const spawned: ChildProcess[] = []
      await withRoot(await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }), { runTimeoutMs: 800, stopGraceMs: 5000 }), async (root) => {
        const events = await postRun(root, runStart({ prompt: `finish-on-stop:${n}` }))
        expectOneEnd(events)
        expect(events.filter((e) => e.type === 'sdk')).toHaveLength(n)
        expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'timeout' })
        await waitFor(() => root.liveCount() === 0)
        // It got the timeout's stop and sent its finished (dropped by the root), then exited: not killed after the grace.
        expect([spawned[0]!.exitCode, spawned[0]!.signalCode]).toEqual([0, null])
      })
    },
    30_000,
  )
})

describe('SIGTERM (stopAll)', () => {
  it('stops live and starting runs, waits for both, and refuses new runs with 503', async () => {
    const allocating = gate()
    const users = testSessionUsers({ onAllocate: (key) => (key.startsWith('chat-gated') ? allocating.promise : undefined) })
    const root = await startTestRoot(spawnFixture('fake-session.ts'), { users, stopGraceMs: 50 })
    try {
      const live = openRun(root, runStart({ prompt: 'hang' }))
      await waitFor(() => live.events.length >= 1)
      const starting = openRun(root, runStart({ chatId: 'chat-gated-1', prompt: 'echo:m:2' }))
      await waitFor(() => users.allocated.includes('chat-gated-1'))
      let stopped = false
      const all = root.stopAll().then(() => (stopped = true))
      const refused = await fetch(`${root.url}/runs`, { method: 'POST', headers: protocolHeaders, body: JSON.stringify(runStart()) })
      expect(refused.status).toBe(503)
      await live.done
      expect(stopped).toBe(false)
      allocating.open()
      await all
      for (const events of [await live.done, await starting.done]) {
        expectOneEnd(events)
        expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'stopped' })
      }
      expect(root.liveCount()).toBe(0)
    } finally {
      allocating.open()
      await root.close()
    }
  })
})

describe('what a run leaves behind', () => {
  it("a tool the CLI starts can't write into the channel through its fds 0 to 5, and doesn't inherit fds 3 to 5", async () => {
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts')), async (root) => {
      const events = await postRun(root, runStart({ prompt: 'grandchild' }))
      expectOneEnd(events)
      // Had any write reached the session's channel, "leaked" would have hit the root's parser and ended the run as
      // protocol.
      expect(events.at(-1)?.type).toBe('finished')
      const out = grandchildOut(events)
      expect(out).toContain('shell-ran')
      // The channel's fds 3 and 4 (and anything above) are not inherited by the CLI or its tools.
      expect(out).not.toMatch(/^open-fd=/m)
    })
  })

  // Only where there is a /proc (Linux, as in the image); vitest reports it skipped elsewhere.
  describe.skipIf(!existsSync('/proc/self'))('through /proc', () => {
    it("a tool can't open the session's channel (fds 3 and 4) or stdout through /proc (ENXIO), and its fd 0 is /dev/null", async () => {
      await withRoot(await startTestRoot(spawnFixture('fake-session.ts')), async (root) => {
        const events = await postRun(root, runStart({ prompt: 'grandchild' }))
        expect(events.at(-1)?.type).toBe('finished')
        const out = grandchildOut(events)
        // Sockets don't open through /proc: ENXIO, "No such device or address".
        for (const fd of [1, 3, 4]) expect(out).toMatch(new RegExp(`^proc-fd${fd}=[1-9][0-9]*:.*No such device or address$`, 'm'))
        // fd 0 is /dev/null (stdin 'ignore'): writing it through /proc succeeds, harmlessly.
        expect(out).toMatch(/^proc-fd0=\/dev\/null$/m)
      })
    })
  })

  it("a process left in the session's group is killed before the user is released", async () => {
    let leftover: number | undefined
    // Checked inside release(), when it is called: by then the leftover must be dead (gone, or a zombie not yet reaped).
    // The pid is read from the run's own events there, so a release() that came before the test saw the pid can't pass
    // as "not running" by default.
    const atRelease: { pid: unknown; running: boolean }[] = []
    let run: ReturnType<typeof openRun> | undefined
    const users = testSessionUsers({
      onRelease: () => {
        const sdk = run?.events.find((e) => e.type === 'sdk')
        const pid = sdk?.type === 'sdk' ? sdk.message.pid : undefined
        atRelease.push({ pid, running: typeof pid === 'number' && running(pid) })
      },
    })
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts'), { users }), async (root) => {
      run = openRun(root, runStart({ prompt: 'leftover' }))
      const events = await run.done
      expect(events.at(-1)?.type).toBe('finished')
      const sdk = events.find((e) => e.type === 'sdk')
      leftover = sdk?.type === 'sdk' ? (sdk.message.pid as number) : undefined
      expect(leftover).toBeTypeOf('number')
      await waitFor(() => users.released.length === 1)
      expect(atRelease).toEqual([{ pid: leftover, running: false }])
      // Killed with the group before release(); it's reaped by its new parent shortly after, hence the wait.
      await waitFor(() => !alive(leftover!), 'leftover gone')
    })
  })
})

describe('the chat slot and the token', () => {
  it('the chat stays taken until release() settles; the token goes when the session exits', async () => {
    const releasing = gate()
    const users = testSessionUsers({ onRelease: () => releasing.promise })
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts'), { users }), async (root) => {
      const first = runStart({ prompt: 'echo:m:1', runToken: 'tok_first_run_000000000001' })
      const run = openRun(root, first)
      await waitFor(() => run.events.some((e) => e.type === 'finished'), 'the terminal event')
      await waitFor(() => root.liveCount() === 1 && root.tokenForUid(users.uids.get(first.chatId)!) === null)
      const res = await fetch(`${root.url}/runs`, { method: 'POST', headers: protocolHeaders, body: JSON.stringify(runStart({ chatId: first.chatId })) })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'chat_live' })
      // `released` waits for release() too: the Worker starts the chat's next turn only after it.
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
      expect(run.events.some((e) => e.type === 'released')).toBe(false)
      releasing.open()
      await run.released
      expect(root.liveCount()).toBe(0)
      const again = await postRun(root, runStart({ chatId: first.chatId }))
      expect(again.at(-1)?.type).toBe('finished')
    })
  })

  it('two runs on two uids each map to their own token; a run on a busy uid is refused; the token goes before the next run on that uid', async () => {
    const uids: Record<string, number> = { 'chat-uid-a': 5001, 'chat-uid-b': 5002, 'chat-uid-c': 5001 }
    const users = testSessionUsers({ uidFor: (key) => uids[key]! })
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts'), { users }), async (root) => {
      const a = openRun(root, runStart({ chatId: 'chat-uid-a', prompt: 'obey-stop', runToken: 'tok_run_on_uid_5001_aaaa' }))
      const b = openRun(root, runStart({ chatId: 'chat-uid-b', prompt: 'obey-stop', runToken: 'tok_run_on_uid_5002_bbbb' }))
      await waitFor(() => a.events.length >= 1 && b.events.length >= 1)
      expect(root.tokenForUid(5001)).toBe('tok_run_on_uid_5001_aaaa')
      expect(root.tokenForUid(5002)).toBe('tok_run_on_uid_5002_bbbb')
      expect(root.tokenForUid(5003)).toBeNull()

      const busy = await fetch(`${root.url}/runs`, { method: 'POST', headers: protocolHeaders, body: JSON.stringify(runStart({ chatId: 'chat-uid-c' })) })
      expect(busy.status).toBe(500)
      expect(root.logs).toContainEqual(expect.objectContaining({ type: 'session_user_refused', reason: 'uid busy', uid: 5001 }))
      expect(root.tokenForUid(5001)).toBe('tok_run_on_uid_5001_aaaa')

      const runA = a.events[0]!.runId
      expect(await post(root, `/runs/${runA}/stop`)).toBe(202)
      await a.done
      await waitFor(() => root.tokenForUid(5001) === null && root.liveCount() === 1)
      const c = openRun(root, runStart({ chatId: 'chat-uid-c', prompt: 'obey-stop', runToken: 'tok_run_on_uid_5001_cccc' }))
      await waitFor(() => c.events.length >= 1)
      expect(root.tokenForUid(5001)).toBe('tok_run_on_uid_5001_cccc')
      await post(root, `/runs/${c.events[0]!.runId}/stop`)
      await post(root, `/runs/${b.events[0]!.runId}/stop`)
      await Promise.all([b.done, c.done])
    })
  })

  it.prop([fc.array(fc.record({ uid: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }), token: fc.option(fc.stringMatching(/^tok_[a-z]{8}$/), { nil: null }) })), fc.integer({ min: 0, max: 4 })])(
    'pickToken: the one run on a uid gives its token; none or two give null',
    (runs, uid) => {
      const on = runs.filter((r) => r.uid === uid)
      expect(pickToken(runs, uid)).toBe(on.length === 1 ? on[0]!.token : null)
    },
  )
})

describe('released (protocol v2): the last event of every run, with the checkpoint result on every exit path', () => {
  const CP = { mainEntries: 5, lastUuid: 'u-4', lastUuidIndex: 4 }
  const cases: [string, Partial<Parameters<typeof runStart>[0]>, (root: TestRoot, runId: string) => Promise<void>, Record<string, unknown>, string][] = [
    ['finish', { prompt: 'cp:finish' }, async () => {}, { checkpoint: CP, queryRan: true }, 'finished'],
    [
      'interrupt',
      { prompt: 'cp:wait' },
      async (root, runId) => {
        await waitFor(() => (root.egress.events.get(runId) ?? []).some((e) => e.type === 'sdk'), 'the query ran')
        expect(await post(root, `/runs/${runId}/interrupt`)).toBe(202)
      },
      { checkpoint: CP, queryRan: true },
      'failed',
    ],
    [
      'a stop before the query (the session never started it)',
      { prompt: 'obey-stop' },
      async (root, runId) => {
        await waitFor(() => (root.egress.events.get(runId) ?? []).length > 0, 'started')
        expect(await post(root, `/runs/${runId}/stop`)).toBe(202)
      },
      { checkpoint: null, queryRan: false },
      'failed',
    ],
  ]
  it.each(cases)('%s', async (_, over, act, expected, terminal) => {
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts'), { stopGraceMs: 2000 }), async (root) => {
      const start = runStart(over)
      const run = openRun(root, start)
      await run.admitted
      await act(root, start.runId)
      const events = await run.done
      expectOneEnd(events)
      expect(events.at(-1)?.type).toBe(terminal)
      const released = await run.released
      expect(released).toEqual({ runId: start.runId, seq: events.length, type: 'released', ...expected })
      expect(root.egress.violations).toEqual([])
    })
  })

  it("a root timeout: the session's later checkpoint still rides in released", async () => {
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts'), { stopGraceMs: 2000, runTimeoutMs: 300 }), async (root) => {
      const start = runStart({ prompt: 'cp:wait' })
      const run = openRun(root, start)
      const events = await run.done
      expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'timeout' })
      // The checkpoint came after the terminal event: not on the stream (one end), but in released.
      expect(events.some((e) => e.type === 'checkpoint')).toBe(false)
      expect(await run.released).toMatchObject({ type: 'released', checkpoint: CP, queryRan: true })
    })
  })

  it('a stop during allocate (before the session exists): released says no query and no checkpoint', async () => {
    const allocating = gate()
    const users = testSessionUsers({ onAllocate: () => allocating.promise })
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts'), { users }), async (root) => {
      const start = runStart({ prompt: 'cp:finish' })
      const run = openRun(root, start)
      await waitFor(() => users.allocated.length === 1)
      expect(await post(root, `/runs/${start.runId}/stop`)).toBe(202)
      allocating.open()
      const events = await run.done
      expect(events.map((e) => e.type)).toEqual(['started', 'failed'])
      expect(await run.released).toMatchObject({ checkpoint: null, queryRan: false })
    })
  })
})

describe('GET /runs/:id', () => {
  const status = async (root: TestRoot, runId: string) => {
    const res = await fetch(`${root.url}/runs/${runId}`, { headers: protocolHeaders })
    expect(res.status).toBe(200)
    return RunStatus.parse(await res.json())
  }

  it('admitted while allocating, running, ending, released; a run never seen is unknown', async () => {
    const allocating = gate()
    const releasing = gate()
    const users = testSessionUsers({ onAllocate: () => allocating.promise, onRelease: () => releasing.promise })
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts'), { users }), async (root) => {
      expect(await status(root, 'run-never-seen')).toEqual({ state: 'unknown', lastSeq: null, ackedSeq: null })
      const start = runStart({ prompt: 'cp:wait' })
      const run = openRun(root, start)
      await waitFor(() => users.allocated.length === 1)
      expect(await status(root, start.runId)).toEqual({ state: 'admitted', lastSeq: null, ackedSeq: null })
      allocating.open()
      await waitFor(() => (root.egress.events.get(start.runId) ?? []).some((e) => e.type === 'sdk'), 'the query ran')
      expect(await status(root, start.runId)).toMatchObject({ state: 'running' })
      await post(root, `/runs/${start.runId}/stop`)
      await waitFor(() => (root.egress.events.get(start.runId) ?? []).some((e) => e.type === 'failed'), 'the terminal event')
      expect(await status(root, start.runId)).toMatchObject({ state: 'ending' })
      releasing.open()
      const released = await run.released
      expect(await status(root, start.runId)).toEqual({ state: 'released', lastSeq: released.seq, ackedSeq: released.seq })
    })
  })

  it('a POST for a run id it already released is refused run_live (never run twice)', async () => {
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts')), async (root) => {
      const start = runStart({ prompt: 'cp:finish' })
      await postRun(root, start)
      const res = await fetch(`${root.url}/runs`, { method: 'POST', headers: protocolHeaders, body: JSON.stringify({ ...start, chatId: 'chat-other' }) })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'run_live' })
    })
  })
})
