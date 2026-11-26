// Stage 1 W0-A: the `pause_gen` seam (N12). The outbox's claim needs its gate row's `do_gen` to equal this counter, so a
// Pause or a Resume whose hook failed or hasn't run yet lets nothing be claimed. Expected values are literals written
// here, never read back from core.ts. Ways it can fail, written down first:
//  1. a pause or a resume doesn't raise it (a repeated pause of a paused brand included), or raises it by more than one;
//  2. it rises only after the hooks ran (so a hook that throws or never settles leaves it behind the flag);
//  3. it is held in memory, so a restart (a reset object) reads 0 again or an old value;
//  4. `TaskContext.pauseGen` is a value captured when the context was built, not the stored counter at each access;
//  5. resume's clean-up deletes it with the pause flags.
import { describe, expect, it } from 'vitest'
import { SEC, inAgent } from '../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../testing/brand-agent/core-harness.ts'

const ADMIN = { kind: 'person' as const, memberId: 'm_admin' }

describe('pause_gen (N12)', () => {
  it('starts at 0 and rises by exactly one on every pause and every resume, a repeated pause included (failures 1, 5)', () => inAgent(async h => {
    expect(h.core.pauseGen()).toBe(0)
    await h.core.pause(ADMIN)
    expect(h.core.pauseGen()).toBe(1)
    await h.core.pause(ADMIN)
    expect(h.core.pauseGen()).toBe(2)
    await h.core.resume(ADMIN)
    expect(h.core.pauseGen()).toBe(3)
    await h.core.resume(ADMIN)
    expect(h.core.pauseGen()).toBe(4)
    expect(h.core.pauseState()).toEqual({ paused: false, at: null, by: null })
  }))

  it('rises in the synchronous step, before any hook runs, and stays raised when a hook throws (failure 2)', () => inAgent(async h => {
    const seen: string[] = []
    h.core.registerPauseHook({
      onPause: async () => { seen.push(`pause:${h.core.pauseGen()}`); throw new Error('hook failed') },
      onResume: async () => { seen.push(`resume:${h.core.pauseGen()}`) },
    })
    const p = h.core.pause(ADMIN)
    // No await yet: the counter moved in the call itself.
    expect(h.core.pauseGen()).toBe(1)
    await expect(p).rejects.toThrow('hook failed')
    expect(h.core.pauseGen()).toBe(1)
    await h.core.resume(ADMIN)
    expect(seen).toEqual(['pause:1', 'resume:2'])
  }))

  it('survives a restart (failure 3)', () => inAgent(async h => {
    await h.core.pause(ADMIN)
    await h.core.resume(ADMIN)
    await h.core.pause(ADMIN)
    const again = h.restart()
    expect(again.core.pauseGen()).toBe(3)
    await again.core.resume(ADMIN)
    expect(again.core.pauseGen()).toBe(4)
    expect(h.restart().core.pauseGen()).toBe(4)
  }))

  it('TaskContext.pauseGen reads the stored counter at each access (failure 4)', () => {
    const seen: number[] = []
    return inAgent(async h => {
      h.sched.schedule({ id: 'probe', kind: 'probe', dueAtMs: h.clock.now })
      await h.tick(SEC)
      expect(seen).toEqual([0, 1, 2])
    }, {
      handlers: {
        probe: async (_t, ctx) => {
          seen.push(ctx.pauseGen)
          const core = ctx.agent as unknown as Harness['core']
          await core.pause(ADMIN)
          seen.push(ctx.pauseGen)
          await core.resume(ADMIN)
          seen.push(ctx.pauseGen)
          return { done: true }
        },
      },
    })
  })
})
