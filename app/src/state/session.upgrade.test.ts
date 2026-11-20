// A chat's saved messages from before C1 (P1) load in the new shapes (store.ts `upgradeMsg`, then `isMsg`). Ways it can
// fail, written down first:
//  1. an answer's `at` saved as epoch ms isn't turned into an instant, or turns into another moment;
//  2. a work row's time ("8:03 AM") or a routine card's time and next run ("7:00 AM", "Next run Mon, Nov 23 at 7:00 AM")
//     convert to the wrong day, minute or year, or the message is dropped though it could convert;
//  3. a message that can't convert is dropped silently, so nobody can tell a returning visitor lost it.
// The functions are private to store.ts, so the tests drive them the way the app does (as session.property.test.ts
// does): put the session in local storage, make a fresh store and read what it restored.
import { fc, test } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { ChatMessage } from '../agent/types'
import { instantOf } from '../lib/format'
import { STARTED_CHAT_PREFIX } from './chatIds'

let storage: Map<string, string>
let warn: MockInstance<typeof console.warn>
beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v) },
    removeItem: (k: string) => { storage.delete(k) },
  })
  vi.stubGlobal('window', { addEventListener: () => undefined })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const SESSION_KEY = 'inhouse.ui.session.v1'
const CHAT = `${STARTED_CHAT_PREFIX}old-1`

/** Saves a session with one started chat holding `extras`, loads a fresh store, and returns that chat's messages. */
async function restored(extras: unknown[]): Promise<ChatMessage[]> {
  storage.set(SESSION_KEY, JSON.stringify({
    started: [{ id: CHAT, title: 'An old chat', at: '8:00 AM' }],
    chats: { [CHAT]: { extras, hidden: {} } },
    drafts: {}, todayDraft: '', modelSel: null, feedback: {}, libraryView: 'masonry', answering: [], queued: {},
  }))
  vi.resetModules()
  const { useUi } = await import('./store')
  const s = useUi.getState()
  return s.chatId === CHAT ? s.extras : s.stash[CHAT]?.extras ?? []
}
/** A minute since midnight as it showed before C1 ("8:03 AM"). */
const shown = (min: number) => `${Math.floor(min / 60) % 12 || 12}:${String(min % 60).padStart(2, '0')} ${min < 720 ? 'AM' : 'PM'}`
/** The demo's Monday (Nov 16, 2026) at a local minute: the demo clock's day, which a fresh store runs on. */
const monday = (min: number) => instantOf(new Date(2026, 10, 16, 0, min).getTime())
const minute = fc.integer({ min: 0, max: 24 * 60 - 1 })
const answer = (part: unknown, at?: unknown) => ({ id: 'm-1', role: 'agent', trace: 'generic', part, ...(at === undefined ? {} : { at }) })

describe('a message that cannot convert is dropped and reported (failure 3)', () => {
  test.each([
    ['a work row with no time', { type: 'workRow', text: 'Checked stock', time: 'soon' }],
    ['a routine card whose next run is not a date', { type: 'routine', routine: { id: 'routine-chat-1', name: 'n', freq: 'Weekly', day: 'Mon', note: 'x', time: '7:00 AM', next: 'later' } }],
    ['a part of no known type', { type: 'poem', text: 'x' }],
  ])('%s', async (_what, part) => {
    expect(await restored([answer(part)])).toEqual([])
    expect(warn.mock.calls.map(c => String(c[0]))).toContain(`Inhouse: dropped 1 saved message(s) it could not read in chat ${CHAT}.`)
  })

  test('a chat whose messages all read says nothing', async () => {
    expect(await restored([answer({ type: 'text', text: 'Hello' })])).toHaveLength(1)
    expect(warn.mock.calls.map(c => String(c[0])).filter(t => t.includes('dropped'))).toEqual([])
  })
})

describe('each old shape converts to the right value (failures 1 and 2)', () => {
  test.prop([fc.integer({ min: 0, max: 4e12 })])("an answer's `at` saved as epoch ms becomes the same instant", async ms => {
    const [m] = await restored([answer({ type: 'text', text: 'Hello' }, ms)])
    expect(m).toMatchObject({ role: 'agent', at: instantOf(ms) })
  })

  test.prop([minute])("a work row's shown time becomes that minute on the demo clock's day", async min => {
    const [m] = await restored([answer({ type: 'workRow', text: 'Checked stock', time: shown(min) })])
    expect(m).toMatchObject({ role: 'agent', part: { type: 'workRow', text: 'Checked stock', at: monday(min) } })
    expect(m.role === 'agent' && 'time' in m.part).toBe(false)
  })

  test.prop([minute, fc.integer({ min: 0, max: 11 }), fc.integer({ min: 1, max: 28 })])("a routine card's time becomes a clock time and its next run an instant in the demo's year", async (min, month, day) => {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const routine = { id: 'routine-chat-1', name: 'Refund numbers', freq: 'Weekly', day: 'Mon', note: 'x', time: shown(min), next: `Next run Mon, ${MONTHS[month]} ${day} at ${shown(min)}` }
    const [m] = await restored([answer({ type: 'routine', routine })])
    expect(m).toMatchObject({ role: 'agent', part: { type: 'routine', routine: { ...routine, time: { hour: Math.floor(min / 60), minute: min % 60 }, next: instantOf(new Date(2026, month, day, 0, min).getTime()) } } })
    expect(warn.mock.calls.map(c => String(c[0])).filter(t => t.includes('dropped'))).toEqual([])
  })
})
