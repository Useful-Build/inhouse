// Day one and the setup list come from the agent's data, never from the demo's scenario switch (P1, C8 "Scenario data").
// Ways this could fail, written down before the tests:
//  1. a real first-day agent (data arrived, no tool connected) doesn't light a first-day screen, because the screen still
//     waits for the demo switch to say "First day";
//  2. a client that is still loading with no tool known yet (the product's stub) is taken for day one;
//  3. day one shows the cap banner (a cap of $0 is "reached" with nothing spent) or a "goes live by" line for a tool that
//     has a date, when nothing is live yet;
//  4. the first connected tool doesn't end day one;
//  5. the setup list comes out in another order, under a rebuilt key, or with other words than the demo showed;
//  6. a tool being set up needs a connected or going-live date to show its row (a real first-day tool has neither);
//  7. a setup entry for a tool the data doesn't describe is dropped silently;
//  8. the demo's screens change: a flag differs from what the scenario name gave in some scenario.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, vi } from 'vitest'
import { HttpAgent } from '../agent/http/client'
import { SCENARIOS } from '../agent/types'
import type { AgentData, Instant, Scenario, StageIndex, ToolDetail, ToolsData } from '../agent/types'
import { flags, goingLive, isFirstDay, noToolsYet, pendingIds, setupRows, todayCopy, toolState, toolView } from './derive'
import type { Ctx } from './derive'
import { fmtWeekday } from '../lib/format'
import { display, setNow } from './display'

// ---------- a real agent: the product's shapes, no mock, no sample data, no scenario ----------

/** The app's clock, at a local time on the demo's Monday (the device's zone is the display zone here). */
const clockAt = (hour: number, minute = 0) => setNow(() => new Date(2026, 10, 16, hour, minute).getTime())
clockAt(8)

const stub = new HttpAgent()
/** The product's empty snapshot: every list empty, `status` `loading`. */
const EMPTY = stub.read()
const NO_STATE = stub.getSnapshot()
const at = (iso: string): Instant => ({ iso, ms: Date.parse(iso) })
const tool = (name: string, extra: Partial<ToolDetail> = {}): ToolDetail => ({ name, desc: '', ex: [], read: '', draft: '', run: '', conn: '', site: '', ...extra })
const LIVE_BY = at('2031-03-07T15:00:00.000Z')
/**
 * What a server serves on a brand's first day: the data has arrived, no tool is connected, three are being set up.
 * `setup` is written in another order than `beingConnected`, and `ads` has a going-live date.
 */
const firstDay = (over: Partial<ToolsData> = {}): AgentData => ({
  ...EMPTY,
  status: 'ready',
  meta: { ...EMPTY.meta, currentUser: { ...EMPTY.meta.currentUser, name: 'Ada Example' } },
  usage: { ...EMPTY.usage, cap: { minor: 40_000, currency: 'USD' } },
  tools: {
    ...EMPTY.tools,
    beingConnected: ['store', 'help-desk', 'ads'],
    details: { store: tool('Store'), 'help-desk': tool('Help Desk'), ads: tool('Ads', { progress: true, liveBy: LIVE_BY }) },
    setup: { ads: { due: 'this-week' }, 'help-desk': { due: 'tomorrow' }, store: { due: 'today' } },
    ...over,
  },
})
/** The same brand once its first tool reads: `store` is connected, so the setup list is over. */
const afterFirstTool = (): AgentData => firstDay({ connected: ['store'], beingConnected: ['help-desk', 'ads'], setup: {}, readDone: 1, details: { store: tool('Store', { since: at('2031-03-03T15:00:00.000Z') }), 'help-desk': tool('Help Desk'), ads: tool('Ads', { progress: true, liveBy: LIVE_BY }) } })
const ctxOf = (data: AgentData, S: StageIndex = 1, settings: Record<string, string> = {}): Ctx => ({ S, agent: { ...NO_STATE, settings }, data })

describe('a real first-day agent, from its data alone', () => {
  test.each([0, 1, 2] as StageIndex[])('lights every first-day screen at stage %i', S => {
    const ctx = ctxOf(firstDay(), S)
    const f = flags(ctx)
    expect(f.isFirst).toBe(true)
    expect(f.isLoading).toBe(false)
    expect(f.noData).toBe(true)
    expect(pendingIds(ctx)).toEqual([])
    const copy = todayCopy(ctx)
    expect(copy.greeting).toBe('Welcome, Ada.')
    expect(copy.headline).toBe("We're setting up your Inhouse agent.")
  })

  test('shows no "goes live by" line, though a tool has a date: nothing is live yet', () => {
    expect(goingLive(ctxOf(firstDay()))).toBeNull()
  })

  test('is never at the cap, even with the cap set to $0', () => {
    const f = flags(ctxOf(firstDay(), 1, { 's:cap': '$0' }))
    expect(f.cap).toBe(false)
    expect(f.pausedEff).toBe(false)
  })

  test('its first connected tool ends day one: Today lists problems, the cap counts and the next tool goes live by its date', () => {
    const ctx = ctxOf(afterFirstTool())
    const f = flags(ctx)
    expect(f.isFirst).toBe(false)
    expect(f.noData).toBe(false)
    expect(todayCopy(ctx).greeting).toBe('Good morning, Ada.')
    // The greeting follows the app's clock: morning from 5:00, afternoon from 12:00, evening from 17:00 until 4:59.
    for (const [h, m, part] of [[4, 59, 'evening'], [5, 0, 'morning'], [11, 59, 'morning'], [12, 0, 'afternoon'], [16, 59, 'afternoon'], [17, 0, 'evening'], [0, 0, 'evening']] as const) {
      clockAt(h, m)
      expect(todayCopy(ctx).greeting).toBe(`Good ${part}, Ada.`)
    }
    clockAt(8)
    expect(goingLive(ctx)).toEqual({ name: 'Ads', by: fmtWeekday(LIVE_BY, display()) })
    expect(flags(ctxOf(afterFirstTool(), 1, { 's:cap': '$0' })).cap).toBe(true)
  })

  test('a client still loading with no tool known yet (the product stub) is loading, not day one', () => {
    const f = flags(ctxOf(EMPTY))
    expect(EMPTY.tools.connected).toEqual([])
    expect(f.isLoading).toBe(true)
    expect(f.isFirst).toBe(false)
    expect(f.noData).toBe(true)
  })

  test.prop([fc.constantFrom<AgentData['status']>('loading', 'ready'), fc.subarray(['store', 'help-desk', 'ads'])])(
    'day one is exactly: the data is ready and no tool is connected', (status, connected) => {
      const data: AgentData = { ...firstDay({ connected }), status }
      const f = flags(ctxOf(data))
      expect(f.isFirst).toBe(status === 'ready' && connected.length === 0)
      expect(isFirstDay(data)).toBe(f.isFirst)
      expect(f.isLoading).toBe(status === 'loading')
      expect(f.isFirst && f.isLoading).toBe(false)
    })

  test('a demo switch left on the selectors\' input changes nothing: only the data decides', () => {
    const withSwitch = (data: AgentData, scenario: Scenario): Ctx => ({ ...ctxOf(data), scenario } as Ctx)
    expect(flags(withSwitch(afterFirstTool(), 'First day')).isFirst).toBe(false)
    expect(goingLive(withSwitch(afterFirstTool(), 'First day'))).not.toBeNull()
    expect(flags(withSwitch(firstDay(), 'Normal')).isFirst).toBe(true)
    expect(goingLive(withSwitch(firstDay(), 'Normal'))).toBeNull()
  })
})

// A tool-less brand whose server already holds something for Today: until the tools read arrives (P5), `connected` is always
// empty, so the screen must also ask the server's own data (Today's cards, the routines' runs).
describe('day one with nothing connected: only a brand the server holds nothing for', () => {
  const card = (id: string): AgentData['problems'][number] => ({
    id, sev: 'warning', area: 'Orders', title: 'Orders waiting to ship', sub: '', logos: [], cost: { minor: 0, currency: 'USD' }, costNote: '', next: '',
    doneText: '', found: [], sources: [], draft: { title: '', lines: [], cta: 'Approve' }, draftedAt: at('2031-03-03T15:00:00.000Z'),
  } as AgentData['problems'][number])
  const routine = (last?: { result: string }): AgentData['routines'][number] => ({
    id: 'routine-morning-check', name: 'Morning check', what: '', freq: 'Daily', day: '', time: { hour: 6, minute: 0 }, next: at('2031-03-04T11:00:00.000Z'), need: 0, rev: 1,
    ...(last ? { last: { at: at('2031-03-03T11:00:00.000Z'), ...last } } : {}),
  } as AgentData['routines'][number])
  const withData = (over: Partial<AgentData>): AgentData => ({ ...firstDay(), ...over })

  test('a truly new brand (nothing connected, no cards, no routine has run) is day one', () => {
    expect(isFirstDay(withData({ routines: [routine()] }))).toBe(true)
    expect(isFirstDay(withData({}))).toBe(true)
  })

  test('Today\'s cards present: not day one, and the cards show', () => {
    const ctx = ctxOf(withData({ problems: [card('p1')] }))
    expect(flags(ctx).isFirst).toBe(false)
    expect(flags(ctx).noData).toBe(false)
  })

  test('a routine has run, even a failed run: not day one, so the failed-check card can show', () => {
    // The real shape of a failed run: `last` is present, with the result "didn't finish" (GET /api/routines in the sandbox run).
    for (const result of ['found 1 thing', "didn't finish"]) {
      const ctx = ctxOf(withData({ routines: [routine({ result })], problems: [card('p_check_failed')] }))
      expect(flags(ctx).isFirst, result).toBe(false)
      expect(flags(ctx).noData, result).toBe(false)
    }
    // Every card set aside leaves no cards, but the run happened.
    expect(isFirstDay(withData({ routines: [routine({ result: 'found 1 thing' })] }))).toBe(false)
  })

  test('the "goes live by" line follows the same rule (shown once a routine has run, hidden on day one)', () => {
    const ran = withData({ routines: [routine({ result: "didn't finish" })] })
    expect(goingLive(ctxOf(ran))).not.toBeNull()
    expect(goingLive(ctxOf(withData({})))).toBeNull()
  })

  test('with cards but no connected list the stage-0 line names no tools and has no empty list or double space', () => {
    const ctx = ctxOf(withData({ problems: [card('p1')], routines: [routine({ result: 'found 1 thing' })] }), 0)
    const { headSub } = todayCopy(ctx)
    expect(headSub).toBe('Your Inhouse agent checked this morning and changed nothing.')
    expect(headSub).not.toMatch(/ {2}|read\s+and/)
  })

  test('screens may claim "no tools connected" on day one only, not when the server holds Today data', () => {
    expect(noToolsYet(withData({}))).toBe(true)
    expect(noToolsYet(withData({ status: 'loading' }))).toBe(true)
    expect(noToolsYet(withData({ problems: [card('p1')] }))).toBe(false)
    expect(noToolsYet(withData({ routines: [routine({ result: "didn't finish" })] }))).toBe(false)
    expect(noToolsYet(afterFirstTool())).toBe(false)
  })

  test.prop([fc.constantFrom<AgentData['status']>('loading', 'ready'), fc.subarray(['store', 'ads']), fc.boolean(), fc.constantFrom<'never' | 'ok' | 'failed'>('never', 'ok', 'failed')])(
    'day one is exactly: ready, no tool connected, no cards and no routine run', (status, connected, cards, run) => {
      const data: AgentData = {
        ...firstDay({ connected }), status,
        problems: cards ? [card('p1')] : [],
        routines: [routine(run === 'never' ? undefined : { result: run === 'ok' ? 'found 1 thing' : "didn't finish" })],
      }
      expect(isFirstDay(data)).toBe(status === 'ready' && connected.length === 0 && !cards && run === 'never')
    })
})

describe('the setup list, by tool key', () => {
  test('follows the order the tools are being connected in, with each tool\'s own key, name and the words for when', () => {
    expect(setupRows(firstDay())).toEqual([
      { key: 'store', name: 'Store', when: 'Connecting today' },
      { key: 'help-desk', name: 'Help Desk', when: 'Tomorrow' },
      { key: 'ads', name: 'Ads', when: 'This week' },
    ])
  })

  test('a tool being connected that has no setup entry is not in it', () => {
    expect(setupRows(firstDay({ setup: { store: { due: 'today' } } })).map(r => r.key)).toEqual(['store'])
  })

  test('a tool being set up says when it connects on its Tools row, with no connected or going-live date', () => {
    const ctx = ctxOf(firstDay())
    expect(toolView(ctx, 'store').listLine).toBe('Connecting today')
    expect(toolView(ctx, 'help-desk').listLine).toBe('Tomorrow')
    expect(toolView(ctx, 'store').connectedRow).toBe('Not yet')
  })

  test('with no setup entry, a tool being connected says when it goes live', () => {
    expect(toolView(ctxOf(afterFirstTool()), 'ads').listLine).toBe(`Live by ${fmtWeekday(LIVE_BY, display())}`)
  })

  test('a setup entry for a tool the data doesn\'t describe stops loudly, not silently', () => {
    const data = firstDay({ beingConnected: ['store', 'ghost'], setup: { store: { due: 'today' }, ghost: { due: 'tomorrow' } } })
    expect(() => setupRows(data)).toThrow('Unknown tool key: ghost')
  })

  test('once the data is past day one the list is empty', () => {
    expect(setupRows(afterFirstTool())).toEqual([])
    expect(setupRows(EMPTY)).toEqual([])
  })
})

// ---------- the demo: every scenario shows what the scenario name used to decide ----------

// The mock reads and writes localStorage when it starts: an empty one in memory, so it starts fresh and quietly.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
const { MockAgent } = await import('../agent/mock')
const mock = new MockAgent()
/** The demo's view of a scenario: the product's (Act, no stages; decision A13). */
const demoCtx = (scenario: Scenario): Ctx => {
  mock.setDemo({ scenario })
  return { S: 1, agent: mock.getSnapshot(), data: mock.read(), noStages: true }
}
/** `goingLive` before day one's rule: the first tool being connected that has a going-live date. */
const firstWithLiveBy = (ctx: Ctx): { name: string; by: string } | null => {
  for (const [key, d] of Object.entries(ctx.data.tools.details)) if (d.liveBy && toolState(ctx, key) === 'connecting') return { name: d.name, by: fmtWeekday(d.liveBy, display()) }
  return null
}
/** Today's setup list as scenarios.json held it before the reshape: the name shown and the words beside it, in order. */
const SETUP_BEFORE: [string, string][] = [['Shopify', 'Connecting today'], ['Amazon', 'Tomorrow'], ['ShipBob', 'Tomorrow'], ['Xero', 'This week'], ['Gorgias', 'This week'], ['Meta Ads', 'This week']]
/** The key Today rebuilt from a setup name before the reshape. */
const keyBefore = (name: string) => name.toLowerCase().replace(/\s+/g, '-')
const everyDemo = SCENARIOS

describe('the demo shows what the scenario name used to decide', () => {
  test.each(everyDemo)('the flags in %s', scenario => {
    const ctx = demoCtx(scenario)
    const f = flags(ctx)
    expect(f.isFirst).toBe(scenario === 'First day')
    expect(f.isLoading).toBe(scenario === 'Loading')
    expect(f.noData).toBe(scenario === 'First day' || scenario === 'Loading')
    expect(f.disc).toBe(scenario === 'Tool disconnected')
    expect(f.cap).toBe(scenario === 'Cap reached')
  })

  test.each(everyDemo)('the "goes live by" line in %s', scenario => {
    const ctx = demoCtx(scenario)
    // The sample data has a tool with a going-live date in every scenario, so only day one's rule hides the line.
    expect(firstWithLiveBy(ctx)).not.toBeNull()
    expect(goingLive(ctx)).toEqual(scenario === 'First day' ? null : firstWithLiveBy(ctx))
  })

  test.each(everyDemo)('the setup list in %s', scenario => {
    const ctx = demoCtx(scenario)
    const rows = setupRows(ctx.data)
    if (scenario !== 'First day') { expect(rows).toEqual([]); return }
    expect(rows.map(r => [r.name, r.when])).toEqual(SETUP_BEFORE)
    expect(rows.map(r => r.key)).toEqual(SETUP_BEFORE.map(([name]) => keyBefore(name)))
    for (const r of rows) expect(toolView(ctx, r.key).listLine).toBe(r.when)
  })
})
