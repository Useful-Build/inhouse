// Two contract facts (A2, 2026-11-20; p3-w1.md "Added by A2"): the payload hash and the one final-state step. Ways
// they can fail, written down first:
//  1. the hash covers a server-resolved value (a settings change turns a retry into key_reused) or misses a field the
//     caller sent (a changed send dedupes); key order or an `undefined` changes it;
//  2. a path that makes a turn final skips the one `storeFinal` step, or runs it twice.
import { describe, expect, it } from 'vitest'
import coreSource from './core.ts?raw'
import { canonicalJson, submitPayloadHash } from './run-start.ts'
import { MEMBER, ev, inAgent, settle, MIN } from '../../testing/brand-agent/core-harness.ts'
import type { TurnRow } from './core.ts'

const BASE = { text: 'hi', quote: 'q', attachments: [{ fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', name: 'a.pdf' }], model: 'sonnet', priority: 'next' as const }

describe('the payload hash (failure 1)', () => {
  it('is the SHA-256 of the canonical JSON (literal vector from shasum)', async () => {
    expect(await submitPayloadHash(BASE)).toBe('2ece3f57b18c1c0d138116e364c5313238ba23e4a50e9a44d8e451dbb3c960d5')
  })
  it('ignores key order, undefined fields and attachment names; covers every listed field', async () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}')
    const base = await submitPayloadHash(BASE)
    const renamed = [{ fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', name: 'renamed.pdf' }]
    expect(await submitPayloadHash({ ...BASE, attachments: renamed })).toBe(base)
    const changed = [
      { ...BASE, text: 'hi!' }, { ...BASE, quote: undefined }, { ...BASE, model: 'opus' }, { ...BASE, priority: 'now' as const },
      { ...BASE, attachments: [] }, { ...BASE, effort: 'high' }, { ...BASE, outputFormat: { type: 'json_schema', schema: {} } },
      { ...BASE, onEnd: { kind: 'routine-end', id: 'x' } },
    ]
    const hashes = await Promise.all(changed.map(c => submitPayloadHash(c)))
    for (const h of hashes) expect(h).not.toBe(base)
    expect(new Set(hashes).size).toBe(changed.length)
  })
  it('through the engine: the same input dedupes even after a settings change; a changed field is key_reused', () => inAgent(async h => {
    const first = await h.submit('c1', 'key-hash1', { text: 'same' })
    // A different resolved model, effort and turn budget (a settings change), the caller's input byte-for-byte equal.
    const t = { chatId: 'c1', by: { kind: 'person' as const, memberId: MEMBER }, model: 'claude-opus-5-5', pickerId: 'sonnet', effort: 'max' as const,
      sideModel: 'claude-opus-5-5', maxTurns: 100, webFetchDomains: [], input: { clientTurnKey: 'key-hash1', text: 'same', priority: 'next' as const, model: 'sonnet', attachments: [] } }
    expect(await h.core.submitTurn(t)).toEqual(first)
    expect(await h.submit('c1', 'key-hash1', { text: 'same', priority: 'later' })).toEqual({ refused: { code: 'conflict', reason: 'key_reused' } })
  }))
})

describe('one final-state step on every path (failure 2)', () => {
  const finals = (h: { core: { onFinal?: (t: TurnRow) => void } }) => {
    const seen: string[] = []
    h.core.onFinal = t => { seen.push(`${t.turn_id} ${t.state} ${t.outcome ?? '-'} ${t.failure ?? t.cancel_why ?? '-'}`) }
    return seen
  }
  const id = (r: unknown) => (r as { turnId: string }).turnId

  it('finished, failed, stopped, interrupted, cancelled (pause, stop, removal), fence and watchdog deadlines: once each', () => inAgent(async h => {
    const seen = finals(h)
    const done = id(await h.submit('c1', 'key-fin01')); await settle()
    h.push(done, ...[ev.started(), ev.text('a'), ev.checkpoint(2, null, null), ev.success(), ev.released({ mainEntries: 2, lastUuid: null, lastUuidIndex: null })])
    const failed = id(await h.submit('c2', 'key-fin02')); await settle()
    h.push(failed, ev.started(), ev.text('a'), ev.checkpoint(2, null, null), ev.finished('error_max_turns'), ev.released({ mainEntries: 2, lastUuid: null, lastUuidIndex: null }))
    const stopped = id(await h.submit('c3', 'key-fin03')); await settle()
    h.core.stop(stopped, { kind: 'person', memberId: MEMBER })
    h.push(stopped, ev.failed('stopped'), ev.released(null, false))
    const interrupted = id(await h.submit('c4', 'key-fin04')); await settle()
    h.core.interrupt(interrupted, { kind: 'person', memberId: MEMBER })
    h.push(interrupted, ev.started(), ev.finished('error_during_execution'), ev.released(null, false))
    const live = id(await h.submit('c5', 'key-fin05')); await settle()
    const queuedStop = id(await h.submit('c5', 'key-fin06'))
    h.core.stop(queuedStop, { kind: 'person', memberId: MEMBER })
    const queuedRemoved = id(await h.submit('c6', 'key-fin07', { member: 'm_gone' })); await settle()
    h.core.onMemberRemoved('m_gone')
    await h.tick(MIN)
    const crashed = live
    h.pool.statusAnswer = { state: 'unknown', containerGone: false }
    await h.tick(2 * MIN); await h.tick(MIN); await h.tick(MIN)
    const paused = id(await h.submit('c7', 'key-fin08')); await settle()
    h.core.pause({ kind: 'person', memberId: 'm_admin' })
    await h.tick(MIN)
    const byTurn = (t: string) => seen.filter(s => s.startsWith(`${t} `))
    expect(byTurn(done)).toEqual([`${done} ended done -`])
    expect(byTurn(failed)).toEqual([`${failed} ended failed max_turns`])
    expect(byTurn(stopped)).toEqual([`${stopped} ended stopped -`])
    expect(byTurn(interrupted)).toEqual([`${interrupted} ended interrupted -`])
    expect(byTurn(queuedStop)).toEqual([`${queuedStop} ended stopped -`])
    expect(byTurn(queuedRemoved)).toEqual([`${queuedRemoved} ended cancelled removed`])
    expect(byTurn(crashed)).toEqual([`${crashed} ended failed session_crashed`])
    expect(byTurn(paused)).toEqual([`${paused} ended cancelled paused`])
    // Every turn that's final went through it exactly once.
    const all = h.turns().filter(t => t.state === 'ended' || t.state === 'cancelled').map(t => t.turn_id)
    expect(seen.map(s => s.split(' ')[0]).sort()).toEqual(all.sort())
  }))

  it('a turn cancelled before it ran (cap_reached) goes through it once', () => inAgent(async h => {
    const seen = finals(h)
    h.usage.reserveAnswer = { refused: 'cap_reached' }
    const t = id(await h.submit('c1', 'key-fin09')); await settle()
    expect(seen).toEqual([`${t} cancelled - cap_reached`])
  }))
})

describe('only storeFinal writes a final state (L10)', () => {
  it('no other UPDATE of turns sets state to ended, cancelled or a bound value', () => {
    const start = coreSource.indexOf('  private storeFinal(')
    const end = coreSource.indexOf('\n  }\n', start)
    expect(start).toBeGreaterThan(0)
    const outside = coreSource.slice(0, start) + coreSource.slice(end)
    const writes = [...outside.matchAll(/UPDATE turns SET[^`"]*?\bstate = ('ended'|'cancelled'|\?)/g)].map(m => m[0])
    expect(writes).toEqual([])
    expect(coreSource.slice(start, end)).toMatch(/UPDATE turns SET state = \?/)
  })
})

describe('more final paths go through storeFinal once (L10)', () => {
  const watch = (h: { core: { onFinal?: (t: TurnRow) => void } }) => {
    const seen: string[] = []
    h.core.onFinal = t => { seen.push(`${t.state} ${t.outcome ?? '-'} ${t.failure ?? t.cancel_why ?? '-'}`) }
    return seen
  }
  it('budget_busy failure', () => inAgent(async h => {
    const seen = watch(h)
    h.usage.reserveAnswer = { refused: 'budget_busy' }
    await h.submit('c1', 'key-l10b1'); await settle()
    for (let i = 0; i < 9; i++) await h.tick(15 * 1000)
    expect(seen).toEqual(['ended failed budget_busy'])
  }))
  it('files, protocol (rejected) and pool_full placement answers', () => inAgent(async h => {
    const seen = watch(h)
    h.pool.placeAnswer = { refused: 'files' }
    await h.submit('c1', 'key-l10f1'); await settle()
    h.pool.placeAnswer = { refused: 'rejected', status: 413 }
    await h.submit('c2', 'key-l10p1'); await settle()
    h.pool.placeAnswer = { refused: 'pool_full' }
    await h.submit('c3', 'key-l10q1'); await settle()
    expect(seen).toEqual(['ended failed files', 'ended failed protocol', 'cancelled - pool_full'])
  }))
  it('the timeout fence, and a release with no terminal event', () => inAgent(async h => {
    const seen = watch(h)
    const a = await h.submit('c1', 'key-l10t1'); await settle()
    const id = (a as { turnId: string }).turnId
    h.push(id, ev.started())
    for (let i = 0; i < 13; i++) { await h.tick(MIN); h.push(id, ev.heartbeat()) }
    h.push(id, ev.released(null, false))
    const b = await h.submit('c2', 'key-l10r1'); await settle()
    h.push((b as { turnId: string }).turnId, ev.started(), ev.released(null, false))
    expect(seen).toEqual(['ended failed timeout', 'ended failed protocol'])
  }))
  it('L9: the engine refuses an attachment named twice (callers that skip the schema)', () => inAgent(async h => {
    const att = { fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', name: 'a.pdf' }
    // The input exists, so only the duplicate can refuse it.
    h.files.inputs.set('c1', [{ id: att.fileId, chatId: 'c1', kind: 'input', path: `inputs/${att.fileId}-a.pdf`, name: 'a.pdf', contentType: 'application/pdf', bytes: 1, sha256: 'a'.repeat(64), turnId: null }])
    expect(await h.submit('c1', 'key-l9dup1', { attachments: [att, att] })).toEqual({ refused: { code: 'invalid' } })
    expect(h.turns()).toEqual([])
  }))
})
