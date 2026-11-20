// The fakes behave like their ports' contracts (W2, W3 and W1's next PR test against them). Expected values are
// literals. Ways it can fail, written down first:
//  1. the fake ledger adds an extend twice on a retry, raises a hold on a close, closes a call twice, moves a final
//     turn's hold on a close, or books a settle twice;
//  2. the fake pool's drain doesn't hold 30 minutes from its time, or a warm-up doesn't clear it;
//  3. the fake RPC's pause and resume don't change what getPause answers;
//  4. the fake file ledger answers ids, not the stored rows, or takes an output for an input.
import { describe, expect, it } from 'vitest'
import type { ChatFile } from '../ports.ts'
import { FakeBrandAgentRpc } from './fake-brand-agent-rpc.ts'
import { FakeFileLedger } from './fake-files.ts'
import { FakeRunnerPool } from './fake-pool.ts'
import { FakeUsageLedger } from './fake-usage.ts'

describe('FakeUsageLedger (failure 1)', () => {
  it('answers a repeated extend of one call the same, adding once', async () => {
    const usage = new FakeUsageLedger()
    await usage.reserve({ turnId: 't', runId: 'r', chatId: 'c', memberId: 'm_a', model: 'x', nowMs: 0 })
    expect(await usage.extend('t', 'call-1', 100)).toEqual({ ok: true, ledgerHold: 250_100 })
    expect(await usage.extend('t', 'call-1', 100)).toEqual({ ok: true, ledgerHold: 250_100 })
    expect(await usage.extend('t', 'call-2', 50)).toEqual({ ok: true, ledgerHold: 250_150 })
    expect(usage.holds.get('t')).toBe(250_150)
  })
  it('a refused extend may be tried again, and is granted once there is room', async () => {
    const usage = new FakeUsageLedger()
    usage.extendRefusal = 'held'
    expect(await usage.extend('t', 'call-1', 100)).toEqual({ refused: 'held', ledgerHold: 0 })
    usage.extendRefusal = null
    expect(await usage.extend('t', 'call-1', 100)).toEqual({ ok: true, ledgerHold: 100 })
    expect(await usage.extend('t', 'call-1', 100)).toEqual({ ok: true, ledgerHold: 100 })
  })
  // PR 2b: the fake now keeps W4's rules (a close only lowers the hold, once per call; a final turn answers 0).
  it('a close only lowers the hold, once per call; after settle or release it changes nothing', async () => {
    const usage = new FakeUsageLedger()
    await usage.reserve({ turnId: 't', runId: 'r', chatId: 'c', memberId: 'm_a', model: 'x', nowMs: 0 })
    expect(await usage.extend('t', 'call-1', 100_000)).toEqual({ ok: true, ledgerHold: 350_000 })
    expect(await usage.close('t', 'call-1', 10, 400_000)).toEqual({ ledgerHold: 350_000 })
    expect(await usage.close('t', 'call-2', 10, 300_000)).toEqual({ ledgerHold: 300_000 })
    expect(await usage.close('t', 'call-2', 10, 260_000)).toEqual({ ledgerHold: 300_000 })
    expect(usage.monthReserved).toBe(300_000)
    await usage.settle('t', 20, 1)
    expect([usage.monthReserved, usage.spent]).toEqual([0, 20])
    expect(await usage.close('t', 'call-3', 10, 5)).toEqual({ ledgerHold: 0 })
    expect(await usage.extend('t', 'call-4', 5)).toEqual({ refused: 'turn_budget', ledgerHold: 0 })
    await usage.settle('t', 99, 2)
    expect([usage.monthReserved, usage.spent]).toEqual([0, 20])
    await usage.reserve({ turnId: 'u', runId: 'r', chatId: 'c', memberId: 'm_a', model: 'x', nowMs: 0 })
    await usage.close('u', 'call-1', 7, 250_000)
    await usage.release('u', 1)
    expect(await usage.close('u', 'call-2', 0, 7)).toEqual({ ledgerHold: 0 })
    expect([usage.monthReserved, usage.spent, usage.booked.get('u')]).toEqual([0, 27, 7])
  })
})

describe('FakeRunnerPool (failure 2)', () => {
  it('drains for 30 minutes from its time, reports it, and a warm-up clears it', async () => {
    const pool = new FakeRunnerPool()
    expect(pool.drainState().drainingUntilMs).toBeNull()
    expect(pool.drain(1_000).drainingUntilMs).toBe(1_801_000)
    expect(pool.drainState().drainingUntilMs).toBe(1_801_000)
    expect(await pool.warmup()).toEqual({ ok: true })
    expect(pool.drainState().drainingUntilMs).toBeNull()
  })
  it('an admitted placement leaves the queue', async () => {
    const pool = new FakeRunnerPool()
    pool.placeAnswer = { queued: true }
    await pool.place({ runId: 't_1' } as never, 1)
    pool.placeAnswer = { admitted: 'runner-1' }
    await pool.place({ runId: 't_1' } as never, 2)
    expect(pool.queue).toEqual([])
  })
})

describe('FakeBrandAgentRpc (failure 3)', () => {
  it('pause and resume change what getPause answers', async () => {
    const rpc = new FakeBrandAgentRpc(undefined, () => Date.parse('2026-11-20T10:00:00.000Z'))
    expect(await rpc.getPause()).toEqual({ paused: false, at: null, by: null })
    await rpc.pause({ kind: 'inhouse', memberId: 'm_ih_1' })
    const at = { iso: '2026-11-20T10:00:00.000Z', ms: Date.parse('2026-11-20T10:00:00.000Z') }
    expect(await rpc.getPause()).toEqual({ paused: true, at, by: 'm_ih_1' })
    await rpc.resume({ kind: 'person', memberId: 'm_admin' })
    expect(await rpc.getPause()).toEqual({ paused: false, at: null, by: null })
  })
})

describe('FakeFileLedger (failure 4)', () => {
  const row = (id: string, kind: 'input' | 'output', name: string): ChatFile =>
    ({ id, chatId: 'c1', kind, path: `${kind}s/${id}-${name}`, name, contentType: 'text/csv', bytes: 1, sha256: 'ab', turnId: null })
  it('answers the stored input rows in the order asked, and refuses an output or another chat\'s file', async () => {
    const files = new FakeFileLedger()
    files.inputs.set('c1', [row('f_a', 'input', 'a.csv'), row('f_b', 'input', 'b.csv'), row('f_o', 'output', 'o.csv')])
    expect(await files.inputsOf('c1', ['f_b', 'f_a'])).toEqual({ ok: true, files: [row('f_b', 'input', 'b.csv'), row('f_a', 'input', 'a.csv')] })
    expect(await files.inputsOf('c1', ['f_a', 'f_o'])).toEqual({ missing: ['f_o'] })
    expect(await files.inputsOf('c2', ['f_a'])).toEqual({ missing: ['f_a'] })
  })
})
