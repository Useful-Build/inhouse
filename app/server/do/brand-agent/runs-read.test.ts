// Routes 32 and 33's reads and the runs signal (p3-design 3, 4.1; p3-w1.md "Runs signal") on the BrandAgent's real
// SQLite with the port fakes. Expected values are literals from the script (its clock, its calls, its events). Ways it
// can fail, written down first:
//  1. a person sees another person's run or trace (scope ignored), or Inhouse's `all` misses one;
//  2. an ended run whose turns are all in D1 is still listed, or one with an unflushed turn isn't;
//  3. a trace's times, cost or tokens aren't the script's; a waiting call or an allowed hook shows as a step;
//  4. `runs_failed` counts stops, interrupts or cap refusals, or turns older than an hour; `runs_stuck` misses a turn
//     the watchdog should have ended; `session_damaged` misses damage in the last 24 h; a quarantined task isn't red.
import { describe, expect, it } from 'vitest'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import type { Refusal } from './ports.ts'
import { MEMBER, OTHER, SEC, T0, ev, fullAnswer, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
const usage = (input: number, output: number, micro: number) =>
  ({ inputTokens: input, outputTokens: output, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0, micro })

describe('route 32: active runs', () => {
  it('live runs and ended runs with an unflushed turn, in scope', () => inAgent(async h => {
    const a = ok(await h.submit('c-a', 'key-act01'))
    await settle()
    const b = ok(await h.submit('c-b', 'key-act02'))
    await settle()
    h.push(b.turnId, ...fullAnswer('done', 2))
    const c = ok(await h.submit('c-c', 'key-act03'))
    await settle()
    h.push(c.turnId, ...fullAnswer('done', 2))
    // c's turn is in D1 (PR 3 flushes it): its ended run is no longer one to attach to.
    h.sql.exec('UPDATE turns SET d1_flushed = 1 WHERE turn_id = ?', c.turnId)
    const o = ok(await h.submit('c-o', 'key-act04', { member: OTHER }))
    await settle()
    const mine = h.core.activeRuns({ owner: MEMBER })
    expect(mine).toEqual([
      { runId: a.runId, chatId: 'c-a', lastSeq: 3, live: true },
      { runId: b.runId, chatId: 'c-b', lastSeq: 6, live: false },
    ])
    expect(h.core.activeRuns({ owner: OTHER })).toEqual([{ runId: o.runId, chatId: 'c-o', lastSeq: 3, live: true }])
    expect(h.core.activeRuns({ all: true }).map(r => r.runId)).toEqual([a.runId, b.runId, o.runId])
  }))
})

describe('route 33: the trace', () => {
  it("a turn's steps, model calls, cost and tokens from its records; another person's is null", () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-trc01'))
    await settle()
    h.clock.now = T0 + 1 * SEC
    h.push(a.turnId, ev.started(), ev.tool('Read'))
    h.push(a.turnId, { type: 'audit', entry: { hook: 'PreToolUse', toolName: 'Read', decision: 'allow', input: {} } })
    h.push(a.turnId, { type: 'audit', entry: { hook: 'PreToolUse', toolName: 'Bash', decision: 'deny', input: {} } })
    h.clock.now = T0 + 2 * SEC
    void h.core.admitModelCall(a.turnId, 'c1', { model: 'claude-sonnet-5-5', inputTokens: 2000, maxTokens: 1000, modifiers: {}, micro: 100_000 })
    await settle()
    h.core.renewModelCall(a.turnId, 'c1', usage(0, 0, 0))
    h.clock.now = T0 + 5 * SEC
    h.core.releaseModelCall(a.turnId, 'c1', { usage: usage(1200, 300, 7_000), cut: false })
    await settle()
    h.clock.now = T0 + 8 * SEC
    h.push(a.turnId, ...fullAnswer('done', 2))
    await settle()
    const want = {
      title: 'question key-trc01', durationMs: 8000, cost: { minor: 1, currency: 'USD' }, tokens: '1.5k',
      steps: [
        { label: 'Inhouse agent', kind: 'root', startMs: 0, endMs: 8000, depth: 0, detail: '1 question' },
        { label: 'Reading a file', kind: 'tool', startMs: 1000, endMs: 1000, depth: 1, detail: 'Read' },
        { label: 'Bash', kind: 'fail', startMs: 1000, endMs: 1000, depth: 1, detail: 'PreToolUse · deny' },
        { label: 'claude-sonnet-5-5', kind: 'model', startMs: 2000, endMs: 5000, depth: 1, detail: '1200 in · 300 out' },
      ],
    }
    expect(h.core.readTrace(a.turnId, { owner: MEMBER })).toEqual({ id: a.turnId, ...want })
    expect(h.core.readTrace(a.runId, { all: true })).toEqual({ id: a.runId, ...want })
    expect(h.core.readTrace(a.turnId, { owner: OTHER })).toBeNull()
    expect(h.core.readTrace('t_AAAAAAAAAAAAAAAAAAAAAA', { all: true })).toBeNull()
  }))
})

describe('the runs signal', () => {
  it('failures over 20% of the last hour (stop, interrupt, caps aside), stuck turns, damage in 24 h, quarantined tasks', () => inAgent(async h => {
    const green = { failures: { ok: true, detail: '0 of 0 failed in the last hour' }, stuck: { ok: true, detail: '0 stuck' },
      damaged: { ok: true, detail: '0 damaged in 24 h' }, quarantined: { ok: true, detail: '0 quarantined' } }
    expect(h.core.runsHealth(0)).toEqual(green)
    // Five turns end in the hour: one success, one stopped, one interrupted, one failed on the cap, one failed `sdk_error`.
    const end = async (key: string, chat: string, bodies: Parameters<typeof h.push>[1][]) => {
      const t = ok(await h.submit(chat, key))
      await settle()
      h.push(t.turnId, ...bodies)
      await settle()
      return t
    }
    const ids: string[] = []
    ids.push((await end('key-sig01', 'c1', fullAnswer('fine', 2))).turnId)
    const s = ok(await h.submit('c2', 'key-sig02'))
    await settle()
    h.core.stop(s.turnId, { kind: 'person', memberId: MEMBER })
    h.push(s.turnId, ev.released(null, false))
    ids.push(s.turnId)
    const i = await end('key-sig03', 'c3', [])
    ids.push(i.turnId)
    h.core.interrupt(i.turnId, { kind: 'person', memberId: MEMBER })
    h.push(i.turnId, ev.started(), ev.finished('error_during_execution'), ev.released({ mainEntries: 2, lastUuid: 'u', lastUuidIndex: 1 }))
    const cap = ok(await h.submit('c4', 'key-sig04'))
    await settle()
    h.usage.extendRefusal = 'cap_reached'
    void h.core.admitModelCall(cap.turnId, 'c1', { model: 'claude-sonnet-5-5', inputTokens: 1, maxTokens: 1, modifiers: {}, micro: 900_000 })
    await settle()
    h.push(cap.turnId, ev.released(null, false))
    ids.push(cap.turnId)
    ids.push((await end('key-sig05', 'c5', [ev.started(), ev.failed('sdk_error'), ev.released(null, true)])).turnId)
    expect(ids.map(id => h.turn(id)).map(t => [t.state, t.outcome, t.failure])).toEqual([
      ['ended', 'done', null], ['ended', 'stopped', null], ['ended', 'interrupted', null], ['ended', 'failed', 'cap_reached'],
      ['ended', 'failed', 'sdk_error'],
    ])
    // 1 of 5 is 20%: not over it. The sdk_error chat ended damaged (the query ran, no checkpoint).
    expect(h.core.runsHealth(0)).toEqual({ ...green, failures: { ok: true, detail: '1 of 5 failed in the last hour' }, damaged: { ok: false, detail: '1 damaged in 24 h' } })
    await end('key-sig06', 'c6', [ev.started(), ev.failed('store'), ev.released(null, false)])
    expect(h.core.runsHealth(2).failures).toEqual({ ok: false, detail: '2 of 6 failed in the last hour' })
    expect(h.core.runsHealth(2).quarantined).toEqual({ ok: false, detail: '2 quarantined' })
    // An hour and a day later the failures and the damage age out.
    h.clock.now += 24 * 3600 * SEC + 1
    expect(h.core.runsHealth(0)).toEqual(green)
  }))

  // #159 round 1 (Opus F8, Sonnet L5): an admin switching a model off and a brand busy at its cap aren't failures, and
  // the ratio needs at least 5 turns in the hour.
  // #159 round 1 (Opus F8, Sonnet L5) and round 2 (Opus high): an admin switching a model off and a brand busy at its cap
  // aren't failures; red at 3 failures in the hour whatever the volume (a total outage at low volume), and over 20% once
  // at least 5 turns ended.
  it('runs_failed: red at 3 failures or over 20% of 5+ turns; model_off and budget_busy left out', () => inAgent(async h => {
    let n = 0
    const key = () => `key-rf${String(++n).padStart(3, '0')}`
    const failSdk = async () => {
      const t = ok(await h.submit(`f${n + 1}`, key()))
      await settle()
      h.push(t.turnId, ev.started(), ev.failed('sdk_error'), ev.released(null, false))
      await settle()
    }
    const succeed = async () => {
      const t = ok(await h.submit(`f${n + 1}`, key()))
      await settle()
      h.push(t.turnId, ...fullAnswer('fine', 2))
      await settle()
    }
    const failOff = async () => {
      h.modelsOff.add('sonnet')
      ok(await h.submit(`f${n + 1}`, key()))
      await settle()
      h.modelsOff.delete('sonnet')
    }
    const failBusy = async () => {
      const t = ok(await h.submit(`f${n + 1}`, key()))
      await settle()
      h.usage.extendRefusal = 'held'
      void h.core.admitModelCall(t.turnId, 'x1', { model: 'claude-sonnet-5-5', inputTokens: 1, maxTokens: 1, modifiers: {}, micro: 900_000 })
      await settle()
      h.usage.extendRefusal = null
      h.push(t.turnId, ev.released(null, false))
      await settle()
    }
    const hour = async (fails: number, oks: number) => {
      h.clock.now += 3_600_001
      for (let i = 0; i < fails; i++) await failSdk()
      for (let i = 0; i < oks; i++) await succeed()
      return h.core.runsHealth(0).failures
    }
    expect(await hour(3, 0)).toEqual({ ok: false, detail: '3 of 3 failed in the last hour' })
    expect(await hour(2, 2)).toEqual({ ok: true, detail: '2 of 4 failed in the last hour' })
    expect(await hour(4, 0)).toEqual({ ok: false, detail: '4 of 4 failed in the last hour' })
    expect(await hour(1, 4)).toEqual({ ok: true, detail: '1 of 5 failed in the last hour' })
    expect(await hour(2, 3)).toEqual({ ok: false, detail: '2 of 5 failed in the last hour' })
    expect(await hour(2, 8)).toEqual({ ok: true, detail: '2 of 10 failed in the last hour' })
    // A new hour: 1 sdk_error, 2 model_off, 2 budget_busy → 1 of 5 failed (20%, not over).
    h.clock.now += 3_600_001
    await failSdk()
    await failOff()
    await failOff()
    await failBusy()
    await failBusy()
    expect(h.turns().filter(t => t.ended_at_ms !== null && t.ended_at_ms >= h.clock.now - 3_600_000).map(t => t.failure).sort())
      .toEqual(['budget_busy', 'budget_busy', 'model_off', 'model_off', 'sdk_error'])
    expect(h.core.runsHealth(0).failures).toEqual({ ok: true, detail: '1 of 5 failed in the last hour' })
  }))

  it('a turn the watchdog should have ended is stuck', () => inAgent(async h => {
    const a = ok(await h.submit('c1', 'key-stk01'))
    await settle()
    // No alarm runs (the watchdog is down): 45 minutes of turn life + 5 minutes of slack are past.
    h.clock.now += 50 * 60 * SEC + 1
    expect(h.core.runsHealth(0).stuck).toEqual({ ok: false, detail: '1 stuck' })
    h.sql.exec("UPDATE turns SET state = 'starting', starting_deadline_ms = ? WHERE turn_id = ?", h.clock.now - 5 * 60 * SEC, a.turnId)
    expect(h.core.runsHealth(0).stuck).toEqual({ ok: true, detail: '0 stuck' })
    h.clock.now += 1
    expect(h.core.runsHealth(0).stuck).toEqual({ ok: false, detail: '1 stuck' })
  }))
})
