// The steps before the query, when one fails. Ways it could fail:
// - a guard that refuses the run (a misconfig) throws out of runSession: the session process crashes, and the Worker
//   sees `session_crashed` instead of a typed failure;
// - the guards run after the files are restored, so a run they refuse has already written the chat's files;
// - a failing outputs snapshot does the same, or hangs the run with no terminal event;
// - either failure calls query() anyway.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { GuardConfigError } from '../../src/guards/options.ts'
import { runSession, type QueryFn } from '../../src/session/core.ts'
import type { QueryGuards } from '../../src/session/seam.ts'
import { runStart } from './support/root-client.ts'
import { PROXY_URL, fakeEgress } from './support/fake-egress.ts'
import { testQueryGuards } from './support/test-seams.ts'

const snapshot = vi.hoisted(() => ({ fail: false }))
vi.mock('../../src/files/files.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/files/files.ts')>()
  return {
    ...real,
    snapshotOutputs: (...args: Parameters<typeof real.snapshotOutputs>) => (snapshot.fail ? Promise.reject(new Error('EIO: the outputs folder')) : real.snapshotOutputs(...args)),
  }
})

const result = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0, usage: {} } as unknown as SDKMessage

const cwds: string[] = []
afterAll(() => {
  for (const d of cwds) rmSync(d, { recursive: true, force: true })
})

async function run(guards: QueryGuards) {
  const cwd = mkdtempSync(join(tmpdir(), 'runner-setup-'))
  cwds.push(cwd)
  const egress = fakeEgress()
  const sent: { type: string; event?: unknown }[] = []
  const logs: Record<string, unknown>[] = []
  let deliver: (m: unknown) => void = () => {}
  let queries = 0
  const query: QueryFn = () => {
    queries++
    return Object.assign(
      (async function* () {
        yield result
      })(),
      { interrupt: async () => undefined },
    )
  }
  const done = runSession({
    channel: { send: (m) => void sent.push(m as { type: string }), onMessage: (h) => (deliver = (v) => h({ ok: true, value: v })) },
    query,
    guards,
    cwd,
    env: { PATH: '/bin' },
    io: { fetch: egress.fetch, proxyUrl: PROXY_URL },
    log: (e) => logs.push(e),
  })
  const { runToken: _, ...config } = runStart()
  deliver({ type: 'run', config })
  await done
  return { events: sent.filter((m) => m.type === 'event').map((m) => m.event), logs, queries: () => queries, egress }
}

const typed = { type: 'failed', reason: 'sdk_error', message: 'the session could not be set up' }

describe('a step before the query fails', () => {
  it('guards that refuse the run: one typed failure, logged, before the files are restored and with no query', async () => {
    const refusing: QueryGuards = {
      kind: 'test',
      apply: () => {
        throw new GuardConfigError('the base options set "sandbox", which only the guards set')
      },
    }
    const r = await run(refusing)
    expect(r.events).toEqual([typed])
    expect(r.queries()).toBe(0)
    expect(r.egress.calls.filter((c) => c.includes('/files/'))).toEqual([])
    expect(r.logs).toContainEqual(expect.objectContaining({ type: 'session_setup_failed', step: 'guards', error: expect.stringContaining('only the guards set') }))
  })

  it('an outputs snapshot that throws: one typed failure, logged, with no query', async () => {
    snapshot.fail = true
    try {
      const r = await run(testQueryGuards)
      expect(r.events).toEqual([typed])
      expect(r.queries()).toBe(0)
      expect(r.logs).toContainEqual(expect.objectContaining({ type: 'session_setup_failed', step: 'outputs_snapshot', error: expect.stringContaining('EIO') }))
    } finally {
      snapshot.fail = false
    }
  })

  it('with both working, the run goes on to the query (the mock passes through)', async () => {
    const r = await run(testQueryGuards)
    expect(r.queries()).toBe(1)
    expect(r.events.at(-1)).toMatchObject({ type: 'finished' })
    // The control for "refused before the files are restored": a run that goes on does restore them.
    expect(r.egress.calls.filter((c) => c.startsWith('GET /files/'))).not.toEqual([])
  })
})
