// The fake pool's placement queue (W2 fit point: `retryQueue`, `dequeue`, `clearQueue`), which the BrandAgent's
// pause and cancel paths are tested against until W2's real pool lands. Expected values are literals. Ways it can fail:
//  1. a queued placement isn't held, or is held twice;
//  2. `dequeue` drops another turn, or fails on a turn that isn't queued;
//  3. `clearQueue` loses the order, returns a turn twice, or leaves anything queued.
import { describe, expect, it } from 'vitest'
import type { RunStart } from '../../../../shared/protocol/index.ts'
import { FakeRunnerPool } from './fake-pool.ts'

const rs = (turnId: string) => ({ runId: turnId }) as RunStart

describe('the fake pool queue', () => {
  it('holds queued placements in order, once each (failure 1)', async () => {
    const pool = new FakeRunnerPool()
    pool.placeAnswer = { queued: true }
    for (const t of ['t_1', 't_2', 't_1', 't_3']) expect(await pool.place(rs(t), 1)).toEqual({ queued: true })
    pool.placeAnswer = { admitted: 'runner-0' }
    await pool.place(rs('t_4'), 1)
    expect(pool.queue).toEqual(['t_1', 't_2', 't_3'])
  })
  it('dequeue takes out that turn only (failure 2)', async () => {
    const pool = new FakeRunnerPool()
    pool.placeAnswer = { queued: true }
    for (const t of ['t_1', 't_2', 't_3']) await pool.place(rs(t), 1)
    pool.dequeue('t_2')
    pool.dequeue('t_none')
    expect(pool.queue).toEqual(['t_1', 't_3'])
  })
  it('clearQueue returns the queued turns in order and empties it (failure 3)', async () => {
    const pool = new FakeRunnerPool()
    pool.placeAnswer = { queued: true }
    for (const t of ['t_1', 't_2', 't_3']) await pool.place(rs(t), 1)
    expect(pool.clearQueue()).toEqual(['t_1', 't_2', 't_3'])
    expect(pool.clearQueue()).toEqual([])
    expect(pool.queue).toEqual([])
    await pool.retryQueue()
    expect(pool.calls.map(c => c.method).slice(-3)).toEqual(['clearQueue', 'clearQueue', 'retryQueue'])
  })
})

describe('a rejected RunStart', () => {
  it('is a typed refusal with the runner\'s status, never queued', async () => {
    const pool = new FakeRunnerPool()
    pool.placeAnswer = { refused: 'rejected', status: 413 }
    expect(await pool.place(rs('t_9'), 1)).toEqual({ refused: 'rejected', status: 413 })
    expect(pool.queue).toEqual([])
  })
})
