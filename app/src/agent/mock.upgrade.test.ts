// A demo saved before C1 (P1) loads in the new shapes (mock.ts `sanitize`). Ways the upgrade can fail, written down first:
//  1. an old value that should convert is dropped, or converts to the wrong instant or clock time (wrong day, wrong
//     minute, wrong year, AM read as PM);
//  2. an old value that can't convert is dropped silently, so nobody can tell a returning visitor lost something;
//  3. something that is dropped on purpose (a run of a routine that no longer exists) is reported as a failure;
//  4. the demo's start (`demoStartedAt`) leaks into the agent's state, or stops being saved under the same key;
//  5. loading an old shape writes it back at once, so a tab still on the old build reads (and strips) the new shape.
import { fc, test } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import fixture from '../../e2e/support/fixtures/demo-storage-pre-seam.json'

const store = new Map<string, string>()
const writes: string[] = []
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { writes.push(k); store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
const { MockAgent } = await import('./mock')
const { demoDayAt } = await import('./demo-clock')
const { instantOf } = await import('../lib/format')

const STATE_KEY = 'inhouse.demo.v2'
const fixtureState = () => JSON.parse(fixture[STATE_KEY]) as Record<string, unknown>
/** The fixture's state with `patch` over it, saved, then loaded by a new mock. */
const load = (patch: Record<string, unknown>) => {
  store.set(STATE_KEY, JSON.stringify({ ...fixtureState(), ...patch }))
  writes.length = 0
  return new MockAgent()
}
/** A minute since midnight as the demo showed it before C1 ("8:03 AM"), with a normal space or a no-break one. */
const shown = (min: number, nbsp = false) => {
  const h = Math.floor(min / 60), m = min % 60
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${nbsp ? '\u00a0' : ' '}${h < 12 ? 'AM' : 'PM'}`
}
/** The demo's Monday (Nov 16, 2026) at a local minute. */
const monday = (min: number) => instantOf(new Date(2026, 10, 16, 0, min).getTime())
const minute = fc.integer({ min: 0, max: 24 * 60 - 1 })

let warn: MockInstance<typeof console.warn>
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => {
  vi.restoreAllMocks()
  store.clear()
  writes.length = 0
})
/** Every warning's text, joined. */
const warned = () => warn.mock.calls.map(c => String(c[0])).join('\n')

describe('an old value that cannot convert is dropped and reported (failure 2), and only then (failure 3)', () => {
  test.each([
    ['routinesExtra', { routinesExtra: [{ id: 'routine-chat-1', name: 'n', freq: 'Weekly', day: 'Mon', time: 'soon', next: 'Next run Mon, Nov 23 at 7:00 AM', note: '', what: 'w' }] }, 'routinesExtra[0]'],
    ['routinesExtra next', { routinesExtra: [{ id: 'routine-chat-1', name: 'n', freq: 'Weekly', day: 'Mon', time: '7:00 AM', next: 'Next run someday', note: '', what: 'w' }] }, 'routinesExtra[0]'],
    ['undone', { undone: { oversell: { at: '8:03 AM', by: 'Sam Mercer' } } }, 'undone.oversell'],
    ['setAside', { setAside: { po: { reason: 'snoozed', at: '8:03 AM', atMin: 483, by: 'Sam Mercer' } } }, 'setAside.po'],
    ['setAside reason', { setAside: { po: { reason: 'forgotten', at: '8:03 AM', atMin: 483, by: 'Sam Mercer', ms: 1 } } }, 'setAside.po'],
    ['paused', { paused: 'after lunch' }, 'paused'],
    ['routineRuns', { routineRuns: [{ routine: 'routine-morning-check', at: 'early' }] }, 'routineRuns[0]'],
    ['approved', { approved: { stock: { at: '8:00 AM', by: 'Sam Mercer', title: 't', doneText: 'd' } } }, 'approved.stock'],
  ])('%s', (_field, patch, where) => {
    const s = load(patch).getSnapshot()
    expect(warned()).toContain(`Inhouse demo: dropped saved entries it could not read: ${where}.`)
    if (where === 'paused') expect(s.paused).toBeNull()
  })

  test('a run of a routine that no longer exists is dropped without a warning', () => {
    const s = load({ routineRuns: [{ routine: 'routine-gone', at: '8:03 AM', atMin: 483 }] }).getSnapshot()
    expect(s.routineRuns).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  test('the stored demo from before the seam loads with nothing dropped', () => {
    const s = load({}).getSnapshot()
    expect(warn).not.toHaveBeenCalled()
    expect(Object.keys(s.approved)).toEqual(['stock'])
  })
})

describe('each old shape converts to the right value (failure 1)', () => {
  test.prop([minute, fc.boolean()])('undone: a shown time and its minute become that minute on the demo\'s Monday', (min, nbsp) => {
    const s = load({ undone: { oversell: { at: shown(min, nbsp), atMin: min, by: 'Sam Mercer' } } }).getSnapshot()
    expect(s.undone).toEqual({ oversell: { at: monday(min), by: 'Sam Mercer' } })
    expect(demoDayAt(min)).toEqual(monday(min))
  })

  test.prop([minute, fc.integer({ min: 1, max: 4e12 }), fc.constantFrom('snoozed', 'dismissed', 'declined')])('setAside: the stamp on the demo\'s Monday, the real time from `ms`', (min, ms, reason) => {
    const s = load({ setAside: { po: { reason, at: shown(min), atMin: min, by: 'Sam Mercer', ms } } }).getSnapshot()
    expect(s.setAside).toEqual({ po: { reason, at: monday(min), by: 'Sam Mercer', loggedAt: instantOf(ms) } })
  })

  test.prop([minute, fc.boolean()])('paused: a shown time becomes that time on the demo\'s Monday', (min, nbsp) => {
    expect(load({ paused: shown(min, nbsp) }).getSnapshot().paused).toEqual(monday(min))
  })

  test.prop([minute])('routineRuns: a run of a known routine keeps its routine, result and trace, at its minute', min => {
    const s = load({ routineRuns: [{ routine: 'routine-morning-check', at: shown(min), atMin: min, result: 'Read 6 tools', trace: 'morning' }] }).getSnapshot()
    expect(s.routineRuns).toEqual([{ routine: 'routine-morning-check', at: monday(min), result: 'Read 6 tools', trace: 'morning' }])
  })

  test.prop([minute, fc.integer({ min: 0, max: 11 }), fc.integer({ min: 1, max: 28 })])('routinesExtra: the time as a clock time, the next run as an instant in the demo\'s year', (min, month, day) => {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const old = { id: 'routine-chat-1', name: 'Refund numbers', freq: 'Weekly', day: 'Mon', time: shown(min), next: `Next run Mon, ${MONTHS[month]} ${day} at ${shown(min)}`, note: 'n', what: 'w' }
    const s = load({ routinesExtra: [old] }).getSnapshot()
    expect(s.routinesExtra).toEqual([{ ...old, time: { hour: Math.floor(min / 60), minute: min % 60 }, next: instantOf(new Date(2026, month, day, 0, min).getTime()) }])
    expect(warn).not.toHaveBeenCalled()
  })

  test('a value already in the new shape loads as it was saved', () => {
    const at = monday(483)
    const s = load({ paused: at, undone: { oversell: { at, by: 'Sam Mercer' } } }).getSnapshot()
    expect(s.paused).toEqual(at)
    expect(s.undone.oversell).toEqual({ at, by: 'Sam Mercer' })
  })
})

describe("the demo's start is a demo control, saved where it always was (failure 4)", () => {
  test('it is not in the agent state, the mock reports it, and a write saves it under the same key', async () => {
    const started = fixtureState().demoStartedAt as number
    const agent = load({})
    expect(Object.keys(agent.getSnapshot())).not.toContain('demoStartedAt')
    expect(agent.demoStartedAt()).toBe(started)
    await agent.setToggle('r:Morning check', false)
    expect((JSON.parse(store.get(STATE_KEY)!) as { demoStartedAt: number }).demoStartedAt).toBe(started)
  })

  test('a first load with nothing saved starts the clock and saves that moment at once', () => {
    store.clear()
    const agent = new MockAgent()
    expect(writes).toContain(STATE_KEY)
    expect((JSON.parse(store.get(STATE_KEY)!) as { demoStartedAt: number }).demoStartedAt).toBe(agent.demoStartedAt())
  })
})

describe('loading an old shape does not write it back (failure 5)', () => {
  test('the stored demo from before the seam is converted in memory and saved only at the next write', async () => {
    const agent = load({ paused: '8:03 AM' })
    expect(writes).toEqual([])
    expect(store.get(STATE_KEY)).toBe(JSON.stringify({ ...fixtureState(), paused: '8:03 AM' }))
    await agent.resume()
    expect(writes).toEqual([STATE_KEY])
    expect(JSON.parse(store.get(STATE_KEY)!).approved.stock.at).toEqual(agent.getSnapshot().approved.stock.at)
  })
})
