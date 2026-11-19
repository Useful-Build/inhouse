// The root's run lifecycle around the session process: start, stop, hang-up, shutdown, and what each leaves behind.
// Ways it could fail, written first:
// - a stop or interrupt that lands while the run is still starting (allocating, or spawned but not ready) is lost, and
//   the run carries on;
// - the Worker hangs up at some stage and the run keeps going, or keeps its chat, uid or token;
// - a spawn that throws leaves the run listed, the chat taken (409 forever) or the token mapped;
// - the chat frees before release() settles, so the next run's allocate races the last run's release;
// - a timeout racing the session's finish gives two ends;
// - SIGTERM (stopAll) misses a run that is still starting, or new runs are let in while stopping;
// - a tool the CLI starts can write into the channel; a process the session left behind outlives the run;
// - a uid maps to the wrong token, or to a token after its run's session has gone.
import type { ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import type { RunEvent } from '../../../shared/protocol/index.ts'
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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

  it('a stop between spawn and ready is applied once the session is ready', async () => {
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
      // The session's own stopped event: it got the run, then the stop.
      expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'stopped', message: 'stopped' })
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

describe('the Worker hangs up', () => {
  it('during allocate: nothing is spawned, the user is released and the chat frees', async () => {
    const allocating = gate()
    const spawned: ChildProcess[] = []
    const users = testSessionUsers({ onAllocate: () => allocating.promise })
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }), { users }), async (root) => {
      const start = runStart({ prompt: 'echo:m:3' })
      const run = openRun(root, start)
      await waitFor(() => users.allocated.length === 1)
      run.hangUp()
      await expect(run.done).rejects.toThrow()
      await waitFor(() => root.logs.some((l) => l.type === 'worker_hung_up'), 'the root saw the hang-up')
      allocating.open()
      await waitFor(() => root.liveCount() === 0)
      expect(spawned).toHaveLength(0)
      expect(users.released).toEqual([start.chatId])
      expect(root.logs).toContainEqual(expect.objectContaining({ type: 'run_abandoned', runId: start.runId }))
    })
  })

  it.each([
    ['before ready', 'hold-ready'],
    ['mid-run', null],
  ])('%s: the session is stopped and the run, chat and token are gone', async (_, marker) => {
    const spawned: ChildProcess[] = []
    const users = testSessionUsers({ onAllocate: (_k, dir) => (marker ? writeFileSync(join(dir, marker), '') : undefined) })
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts', { onSpawn: (c) => spawned.push(c) }), { users, stopGraceMs: 50 }), async (root) => {
      const start = runStart({ prompt: 'hang' })
      const run = openRun(root, start)
      await waitFor(() => spawned.length === 1 && run.events.length >= 1)
      run.hangUp()
      await expect(run.done).rejects.toThrow()
      await waitFor(() => root.liveCount() === 0)
      expect(spawned[0]!.exitCode !== null || spawned[0]!.signalCode !== null).toBe(true)
      expect(users.released).toEqual([start.chatId])
      expect(root.tokenForUid(users.uids.get(start.chatId)!)).toBeNull()
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
  it.prop([fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1, max: 15 })], { numRuns: 8 })(
    'a timeout racing the session finish gives one end, whichever wins',
    async (n, timeoutMs) => {
      await withRoot(await startTestRoot(spawnFixture('fake-session.ts'), { runTimeoutMs: timeoutMs, stopGraceMs: 50 }), async (root) => {
        const events = await postRun(root, runStart({ prompt: `echo:m:${n}` }))
        expectOneEnd(events)
        const last = events.at(-1)!
        expect(last.type === 'finished' || (last.type === 'failed' && last.reason === 'timeout')).toBe(true)
      })
    },
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
  it("a tool the CLI starts can't write into the channel, through its fds 0 to 4 or /proc", async () => {
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts')), async (root) => {
      const events = await postRun(root, runStart({ prompt: 'grandchild' }))
      expectOneEnd(events)
      // Had any write reached the session's stdout, "leaked" would have hit the root's parser and ended the run as
      // protocol.
      expect(events.at(-1)?.type).toBe('finished')
      const sdk = events.find((e) => e.type === 'sdk')
      expect(sdk).toMatchObject({ message: { type: 'grandchild', code: 0 } })
      const out = sdk?.type === 'sdk' ? String(sdk.message.out) : ''
      expect(out).toContain('shell-ran')
      // Neither of the session's stdio sockets opens through /proc (ENXIO on Linux; no /proc elsewhere).
      expect(out).toMatch(/^proc-stdout=[1-9]/m)
      expect(out).toMatch(/^proc-stdin=[1-9]/m)
    })
  })

  it("a process left in the session's group is killed before the user is released", async () => {
    let leftover: number | undefined
    const users = testSessionUsers()
    await withRoot(await startTestRoot(spawnFixture('fake-session.ts'), { users }), async (root) => {
      const run = openRun(root, runStart({ prompt: 'leftover' }))
      await waitFor(() => run.events.some((e) => e.type === 'sdk'))
      const sdk = run.events.find((e) => e.type === 'sdk')
      leftover = sdk?.type === 'sdk' ? (sdk.message.pid as number) : undefined
      expect(leftover).toBeTypeOf('number')
      const events = await run.done
      expect(events.at(-1)?.type).toBe('finished')
      await waitFor(() => users.released.length === 1)
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
      await run.done
      await waitFor(() => root.liveCount() === 1 && root.tokenForUid(users.uids.get(first.chatId)!) === null)
      const res = await fetch(`${root.url}/runs`, { method: 'POST', headers: protocolHeaders, body: JSON.stringify(runStart({ chatId: first.chatId })) })
      expect(res.status).toBe(409)
      releasing.open()
      await waitFor(() => root.liveCount() === 0)
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
