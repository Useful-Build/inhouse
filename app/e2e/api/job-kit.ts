import { expect, type APIRequestContext } from '@playwright/test'
import type { JobTimingName } from '../../server/ops/job-timings.ts'
import { createChat, send } from './chat-kit.ts'
import { actor, call, type Actor } from './kit.ts'

// BRAND-GLOBAL CONTROLS. `setJobTimings` and `killRunners` act on the whole test brand (its one BrandAgent and every
// runner in the pool), not on one spec's chat. A spec that uses either must run its describe block
// `test.describe.configure({ mode: 'serial' })`, as routines.spec.ts does, and undo the timings in a `finally` (or an
// `afterAll`) with `resetJobTimings`, so a failing case can't leave short timings for the next spec:
//
//   await setJobTimings(request, { JOB_CUT_MS: 5_000 })
//   try { ... } finally { await resetJobTimings(request) }

/** Seed the scripted job with a turn that saves a file and a checkpoint. */
export async function startJob(request: APIRequestContext, who: Actor, text = 'scenario:long-job Seed the job.') {
  const chatId = await createChat(request, who)
  return { chatId, ...(await send(request, who, chatId, text)) }
}

export async function jobControl(request: APIRequestContext, json: object): Promise<unknown> {
  const r = await call(request, actor('release'), 'POST', '/api/ops/alarm', { json })
  expect(r.status, r.text).toBe(200)
  return r.json as unknown
}

/** Replace the overrides (names: server/ops/job-timings.ts; any other is a 400). Brand-global: see the top. */
export async function setJobTimings(request: APIRequestContext, overrides: Partial<Record<JobTimingName, number>>): Promise<void> {
  expect(await jobControl(request, { action: 'setTimings', overrides })).toEqual({ set: true })
}

/** Clear every override, back to the defaults. Call it in the `finally` of any spec that set timings. */
export async function resetJobTimings(request: APIRequestContext): Promise<void> {
  await setJobTimings(request, {})
}

/** A bound on the pool walk, so a server that never answers 404 fails loud instead of looping. */
const MAX_POOL = 64

/**
 * Hard-kill every running container in the pool and return the names it killed. A spec can't know which runner hosts
 * its turn, so this walks `runner-0`, `runner-1`, ... until route 67 answers 404 `runner`: the handler's own bound
 * (`RUNNER_POOL`), so the walk and the server always agree on the pool's size. Fails unless at least one was running.
 * Brand-global (it kills other chats' turns too): see the top.
 */
export async function killRunners(request: APIRequestContext): Promise<string[]> {
  const killed: string[] = []
  for (let i = 0; i < MAX_POOL; i++) {
    const runner = `runner-${i}`
    const r = await call(request, actor('release'), 'POST', '/api/ops/alarm', { json: { action: 'killRunner', runner } })
    if (r.status === 404) {
      expect(r.json, r.text).toEqual({ error: { code: 'not_found', reason: 'runner' } })
      expect(i, 'the pool has at least one runner').toBeGreaterThan(0)
      expect(killed, 'at least one runner was running').not.toEqual([])
      return killed
    }
    expect(r.status, r.text).toBe(200)
    const { killed: was } = r.json as { killed: boolean }
    if (was) killed.push(runner)
  }
  throw new Error(`route 67 never answered 404 for a runner up to runner-${MAX_POOL - 1}`)
}

/**
 * Route 67's observe control (read only): the BrandAgent's isolate id and construct time, the job timings in effect,
 * and the turn's state, `started_at_ms`, `cut_cause`, `interrupt_asked`, its `turn-watch` task and the quarantined count.
 */
export async function observeAgent(request: APIRequestContext, turnId?: string): Promise<Record<string, unknown>> {
  return await jobControl(request, { action: 'observe', ...(turnId === undefined ? {} : { turnId }) }) as Record<string, unknown>
}

/** N3's job state route. Call once M1-B's route is present. */
export async function readJob(request: APIRequestContext, who: Actor, chatId: string): Promise<unknown> {
  const r = await call(request, who, 'GET', `/api/chats/${chatId}/job`)
  expect(r.status, r.text).toBe(200)
  return r.json as unknown
}
