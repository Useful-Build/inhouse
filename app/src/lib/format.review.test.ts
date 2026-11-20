// PR #66, review round 1: a test for each code fix that fails without it. The format check's probes are in
// format.check.test.ts; the call sites' helpers (round 1, item 2) are what format.golden.test.ts now calls.
import { afterEach, describe, expect, test, vi } from 'vitest'
import fixture from '../../e2e/support/fixtures/demo-storage-pre-seam.json'
import type { Instant, TeamRequest } from '../agent/types'

// The mock reads and writes localStorage: one in memory, with each write counted.
const store = new Map<string, string>()
const writes: string[] = []
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { writes.push(k); store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
const { MockAgent } = await import('../agent/mock')
const { DEMO_START } = await import('../agent/clock')
const F = await import('./format')
const { display } = await import('../state/display')
const { activityRows, draftView, handled, teamRequestLine } = await import('../state/derive')
const d = display()
const STATE_KEY = 'inhouse.demo.v2'

afterEach(() => {
  vi.useRealTimers()
  store.clear()
  writes.length = 0
})

describe('item 4: a duration under a second is never grouped', () => {
  test('999.6 ms rounds to "1000ms", not "1,000ms"', () => {
    expect(F.fmtDuration(999.6, d)).toBe('1000ms')
    expect(F.fmtDuration(820, d)).toBe('820ms')
  })
})

describe('item 5: a request the person sent says "just now", as before C1', () => {
  const sentAt = DEMO_START.getTime()
  const q: Omit<TeamRequest, 'icon'> = { title: 'Connect Klaviyo', sub: 'New tool · sent by Sam Mercer', at: F.instantOf(sentAt), status: 'Sent' }
  test('two hours after it went', () => {
    expect(teamRequestLine(q, sentAt + 2 * 3_600_000, true)).toEqual({ sub: 'New tool · sent by Sam Mercer, just now', status: 'Sent' })
  })
  test('a seeded request still shows its date', () => {
    expect(teamRequestLine(q, sentAt + 2 * 3_600_000, false).sub).toBe(`New tool · sent by Sam Mercer, ${F.fmtTime(sentAt, d)}`)
  })
})

describe('item 6: a state saved before C1 is saved back converted once, on load', () => {
  /** The stored-demo fixture's state with a team request sent before C1 (no `at`: it said "just now"). */
  const oldState = () => {
    const s = JSON.parse(fixture[STATE_KEY]) as Record<string, unknown>
    return JSON.stringify({ ...s, teamRequests: [{ icon: 'add_link', title: 'Connect Klaviyo', sub: 'New tool · sent by Sam Mercer, just now', status: 'Sent' }] })
  }
  const savedRequestAt = () => (JSON.parse(store.get(STATE_KEY)!) as { teamRequests: { at?: Instant }[] }).teamRequests[0].at

  test("the request's time is fixed by the upgrade, not set again at the next load", () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const demoStartedAt = (JSON.parse(fixture[STATE_KEY]) as { demoStartedAt: number }).demoStartedAt
    vi.setSystemTime(demoStartedAt + 10 * 60_000)
    store.set(STATE_KEY, oldState())
    const first = new MockAgent().getSnapshot().teamRequests[0]
    expect(first.sub).toBe('New tool · sent by Sam Mercer')
    expect(savedRequestAt()).toEqual(first.at)
    vi.setSystemTime(demoStartedAt + 40 * 60_000)
    expect(new MockAgent().getSnapshot().teamRequests[0].at).toEqual(first.at)
  })

  test('a state saved in the current shape is not written again on load', async () => {
    const agent = new MockAgent()
    await agent.sendTeamRequest({ icon: 'add_link', title: 'Connect Klaviyo', sub: 'New tool · sent by Sam Mercer', at: F.instantOf(DEMO_START.getTime()), status: 'Sent' })
    await agent.runRoutine('routine-morning-check')
    writes.length = 0
    new MockAgent()
    expect(writes.filter(k => k === STATE_KEY)).toEqual([])
  })
})

describe('item 7: what the agent did, its note and Activity\'s "by" are sentences built from instants', () => {
  test('fmtProse writes each time in the display zone and refuses a token with no time', () => {
    const at = F.instantOf(DEMO_START.getTime())
    expect(F.fmtProse({ text: 'Paused at {at:time}. New date: {at:weekday}', times: { at } }, d)).toBe(`Paused at ${F.fmtTime(at, d)}. New date: ${F.fmtWeekday(at, d)}`)
    expect(() => F.fmtProse({ text: 'Paused at {at:time}', times: {} }, d)).toThrow()
    expect(() => F.fmtProse({ text: 'Paused at {at}', times: { at } }, d)).toThrow()
  })

  // What the screens showed before the split (the sample prose as it was, with the no-break space before AM).
  const BEFORE = {
    oversell: 'Paused the variant at 6:04\u00a0AM. Customer emails wait in Approvals',
    po: 'Chased Kestrel at 6:08\u00a0AM. New date: Thu, Nov 19',
    returns: 'Restocked 11 units at 6:10\u00a0AM',
    stuck: 'Asked ShipBob at 6:06\u00a0AM. Picked at 7:40\u00a0AM',
  }
  test('the sentences read as they did, in Run', () => {
    const agent = new MockAgent()
    agent.setDemo({ stage: 'Run', scenario: 'Normal' })
    const data = agent.read()
    const shown = Object.fromEntries(data.problems.filter(p => p.done).map(p => [p.id, F.fmtProse(p.done!, d)]))
    expect(shown).toEqual(BEFORE)
    const ctx = { S: 2 as const, scenario: 'Normal' as const, agent: agent.getSnapshot(), data }
    expect(draftView(ctx, 'oversell').doneNote).toBe('Your Inhouse agent already paused the variant at 6:04\u00a0AM, inside your Run limits. The customer emails wait for a person.')
    expect(handled(ctx).summary).toContain('Paused the variant')
    const rows = activityRows(ctx)
    expect(rows.find(r => r.text === 'Paused the variant')?.t).toBe('6:04\u00a0AM')
    expect(rows.find(r => r.text.startsWith('Reorder of 300 Summit Fleece'))?.by).toBe('Drafted by Inhouse agent, approved by Dana Kim at 10:12\u00a0AM.')
  })
})
