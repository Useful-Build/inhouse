// Property tests for the saved session (store.ts: sessionOf, loadSession, restoreSession).
//
// Ways saving and loading a session can fail, written down before the properties:
//  - a field is dropped or renamed on save, or read under another name on load;
//  - the saved version key changes and an older save is silently ignored (or a newer one is misread);
//  - the JSON is partial (cut off mid-write) or corrupt, or isn't JSON at all;
//  - a field has the wrong type: a string where a list goes, null where an object goes, a number for a draft;
//  - unknown keys, or keys like "__proto__", ride along and leak into the state;
//  - huge or empty values: very long text, empty strings, empty lists and maps;
//  - chats or drafts for ids that don't exist, a model the team can't use any more, a view that isn't one;
//  - storage throws: reading is blocked, or writing is (quota, private mode).
//
// The functions are private to store.ts, so the properties drive them the way the app does: put JSON in local storage,
// make a fresh store (it runs loadSession on creation), read its state, fire `pagehide` (it runs sessionOf and saves)
// and read the storage back.
//
// Run count: 100 by default. For a long run: VITE_PROP_RUNS=1000 npm run test:unit
import { fc } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Attachment, ChatMessage, MessagePart } from '../agent/types'
import { STARTED_CHAT_PREFIX } from './chatIds'

const SESSION_KEY = 'inhouse.ui.session.v1'
const numRuns = Number(import.meta.env.VITE_PROP_RUNS) || 100

// ---------- a fake browser: just what the store touches when it is made ----------
let storage: Map<string, string>
let onPagehide: (() => void)[]
let storageBlocked: { read: boolean; write: boolean }

beforeEach(() => {
  storage = new Map()
  onPagehide = []
  storageBlocked = { read: false, write: false }
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => {
      if (storageBlocked.read) throw new Error('storage blocked')
      return storage.get(k) ?? null
    },
    setItem: (k: string, v: string) => {
      if (storageBlocked.write) throw new Error('quota exceeded')
      storage.set(k, v)
    },
    removeItem: (k: string) => { storage.delete(k) },
  })
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: () => void) => { if (type === 'pagehide') onPagehide.push(fn) },
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Store = typeof import('./store')

/** A store made fresh from whatever local storage holds now, like a page load. */
async function loadStore(): Promise<Store> {
  vi.resetModules()
  return import('./store')
}

/** What the person would see restored, read from the store's state. A chat with nothing added is the same as no entry:
 *  sessionOf drops those on purpose, so they are left out here. */
function view(store: Store) {
  const s = store.useUi.getState()
  return {
    started: s.started,
    stash: Object.fromEntries(Object.entries(s.stash).filter(([, c]) => c.extras.length || Object.keys(c.hidden).length)), extras: s.extras, hidden: s.hidden, chatId: s.chatId,
    todayDraft: s.todayDraft, atts: s.atts, drafts: s.drafts, modelSel: s.modelSel,
    feedback: s.feedback, libraryView: s.libraryView, queued: s.queued,
  }
}

/** Save the way the app does: a change schedules a save, `pagehide` runs it now. */
function saveNow(store: Store): string | null {
  const s = store.useUi.getState()
  store.useUi.setState({ started: [...s.started] })
  for (const fn of onPagehide) fn()
  return storage.get(SESSION_KEY) ?? null
}

// ---------- arbitraries that mirror the real types ----------
const str = fc.oneof({ weight: 20, arbitrary: fc.string() }, { weight: 4, arbitrary: fc.string({ unit: 'binary' }) }, { weight: 4, arbitrary: fc.constant('') }, { weight: 1, arbitrary: fc.string({ minLength: 2000, maxLength: 5000 }) })
const optional = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined })

const attachment: fc.Arbitrary<Attachment> = fc.record({ name: str, meta: str, icon: str })

const row = fc.record({ order: str, age: str, why: str, value: str })
const part: fc.Arbitrary<MessagePart> = fc.oneof(
  fc.record({ type: fc.constant('text' as const), text: str }),
  fc.record({
    type: fc.constant('table' as const),
    table: fc.record({ title: str, summary: str, rows: fc.array(row, { maxLength: 4 }), sources: fc.array(str, { maxLength: 4 }) },
      { requiredKeys: ['title', 'summary', 'rows', 'sources'] }),
  }),
  fc.record({ type: fc.constant('approval' as const), problemId: str }),
  fc.record({
    type: fc.constant('routine' as const),
    routine: fc.record({ id: str, name: str, freq: str, day: str, time: str, next: str, note: str }),
  }),
  fc.record({
    type: fc.constant('skill' as const),
    skill: fc.record({ name: str, desc: str, tools: str, mode: str }) as unknown as fc.Arbitrary<Extract<MessagePart, { type: 'skill' }>['skill']>,
  }),
  fc.record({ type: fc.constant('workRow' as const), text: str, time: str }),
  fc.record({ type: fc.constant('notInThisStage' as const), text: str }),
  fc.record({ type: fc.constant('error' as const), text: str, retryQuestion: str }),
  fc.record({ type: fc.constant('suggestions' as const), questions: fc.array(str, { maxLength: 4 }) }),
)

const message: fc.Arbitrary<ChatMessage> = fc.oneof(
  fc.record({ id: str, role: fc.constant('user' as const), text: str, quote: optional(str), atts: optional(fc.array(attachment, { maxLength: 3 })) }, { requiredKeys: ['id', 'role', 'text'] }),
  fc.record({ id: str, role: fc.constant('event' as const), text: str }),
  fc.record({ id: str, role: fc.constant('agent' as const), part, trace: str, model: optional(str), at: optional(fc.integer({ min: 0, max: 4e12 })) }, { requiredKeys: ['id', 'role', 'part', 'trace'] }),
)

const startedId = str.map(s => STARTED_CHAT_PREFIX + s)
const started = fc.record({ id: startedId, title: str, day: str, at: str })

const hidden = fc.dictionary(str, fc.constant(true as const), { maxKeys: 4 })
const adds = fc.record({ extras: fc.array(message, { maxLength: 4 }), hidden })
const draft = fc.record({ text: str, atts: fc.array(attachment, { maxLength: 3 }) })
const queued = fc.record({
  id: str, text: str, quote: optional(str), atts: optional(fc.array(attachment, { maxLength: 3 })),
  model: fc.constant(null), paused: fc.constant(true as const),
}, { requiredKeys: ['id', 'text', 'model', 'paused'] })

/** A saved session that is valid by the store's own rules. Chat ids are the real sample ids plus the started chats' ids. */
async function validSession() {
  const { agent } = await import('../agent')
  const sampleIds = agent.allChatIds()
  return fc.uniqueArray(started, { selector: c => c.id, maxLength: 3 }).chain(list => {
    const ids = fc.constantFrom(...sampleIds, ...list.map(c => c.id))
    return fc.record({
      started: fc.constant(list),
      chats: fc.dictionary(ids, adds),
      todayDraft: str,
      drafts: fc.dictionary(fc.oneof(ids, fc.constant('today')), draft),
      modelSel: fc.constantFrom(null, 'sonnet', 'opus'),
      feedback: fc.dictionary(str, fc.constantFrom('up' as const, 'down' as const)),
      libraryView: fc.constantFrom('masonry' as const, 'grid' as const, 'list' as const),
      answering: fc.uniqueArray(ids, { maxLength: 2 }),
      queued: fc.dictionary(ids, fc.array(queued, { minLength: 1, maxLength: 3 })),
    })
  })
}

describe('session save and load', () => {
  test('round trip: what is saved loads back equal', async () => {
    const arb = await validSession()
    await fc.assert(fc.asyncProperty(arb, async session => {
      storage.clear()
      onPagehide = []
      storage.set(SESSION_KEY, JSON.stringify(session))

      const first = await loadStore()
      const before = view(first)
      // What the person kept comes back as saved.
      expect(before.started).toEqual(session.started)
      expect(before.todayDraft).toBe(session.todayDraft)
      expect(before.libraryView).toBe(session.libraryView)
      expect(before.feedback).toEqual(session.feedback)
      expect(before.modelSel).toBe(session.modelSel)

      // Save it again and load that: the same session comes back.
      const saved = saveNow(first)
      expect(saved).not.toBeNull()
      onPagehide = []
      const second = await loadStore()
      expect(view(second)).toEqual(before)
      expect(saveNow(second)).toBe(saved)
    }), { numRuns })
  })

  const junk = fc.oneof(
    fc.string(),
    fc.string({ unit: 'binary' }),
    fc.json(),
    fc.jsonValue().map(v => JSON.stringify(v)),
    fc.constantFrom('null', '[]', '{}', '0', 'true', '"x"', '{"started":null}', '{"chats":[]}', '{"drafts":"x"}', '{"queued":{"a":5}}'),
    // Right keys, wrong types.
    fc.record({
      started: fc.jsonValue(), chats: fc.jsonValue(), todayDraft: fc.jsonValue(), drafts: fc.jsonValue(), modelSel: fc.jsonValue(),
      feedback: fc.jsonValue(), libraryView: fc.jsonValue(), answering: fc.jsonValue(), queued: fc.jsonValue(), extra: fc.jsonValue(),
    }, { requiredKeys: [] }).map(v => JSON.stringify(v)),
    // Hostile keys.
    fc.constantFrom(
      '{"__proto__":{"libraryView":"list"},"feedback":{"__proto__":"up"}}',
      '{"chats":{"__proto__":{"extras":[],"hidden":{}},"constructor":{"extras":[],"hidden":{}}}}',
      '{"drafts":{"today":{"text":"a","atts":[]},"__proto__":{"text":"a","atts":[]}}}',
    ),
  )

  /** A truncated valid session: the write was cut off. */
  async function truncated() {
    const valid = await validSession()
    return fc.tuple(valid, fc.nat(100)).map(([s, pct]) => {
      const json = JSON.stringify(s)
      return json.slice(0, Math.floor(json.length * pct / 100))
    })
  }

  /** Usable: the store exists, and every restored field has the right shape. */
  function expectUsable(store: Store) {
    const s = store.useUi.getState()
    expect(s.page).toBe('today')
    expect(Array.isArray(s.started)).toBe(true)
    for (const c of s.started) {
      expect(c.id.startsWith(STARTED_CHAT_PREFIX)).toBe(true)
      expect([c.title, c.day, c.at].every(v => typeof v === 'string')).toBe(true)
    }
    expect(typeof s.todayDraft).toBe('string')
    expect(['masonry', 'grid', 'list']).toContain(s.libraryView)
    expect(Array.isArray(s.extras)).toBe(true)
    expect(Array.isArray(s.atts)).toBe(true)
    for (const v of Object.values(s.feedback)) expect(['up', 'down']).toContain(v)
    for (const list of Object.values(s.queued)) expect(list.every(q => q.paused === true && typeof q.text === 'string')).toBe(true)
    // Nothing leaked onto the prototype.
    expect(Object.getPrototypeOf(s.feedback)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).libraryView).toBeUndefined()
    // And the usable store saves again without throwing.
    expect(() => saveNow(store)).not.toThrow()
  }

  test('junk in storage never throws and gives a usable store', async () => {
    await fc.assert(fc.asyncProperty(junk, async text => {
      storage.clear()
      onPagehide = []
      storage.set(SESSION_KEY, text)
      expectUsable(await loadStore())
    }), { numRuns })
  })

  test('a cut-off save never throws and gives a usable store', async () => {
    const arb = await truncated()
    await fc.assert(fc.asyncProperty(arb, async text => {
      storage.clear()
      onPagehide = []
      storage.set(SESSION_KEY, text)
      expectUsable(await loadStore())
    }), { numRuns })
  })

  test('a valid session with one field swapped for junk still loads', async () => {
    const valid = await validSession()
    const fields = ['started', 'chats', 'todayDraft', 'drafts', 'modelSel', 'feedback', 'libraryView', 'answering', 'queued']
    await fc.assert(fc.asyncProperty(valid, fc.constantFrom(...fields), fc.jsonValue(), async (session, field, value) => {
      storage.clear()
      onPagehide = []
      storage.set(SESSION_KEY, JSON.stringify({ ...session, [field]: value }))
      expectUsable(await loadStore())
    }), { numRuns })
  })

  test('storage that throws on read starts fresh', async () => {
    storageBlocked.read = true
    const store = await loadStore()
    expect(store.useUi.getState().libraryView).toBe('masonry')
    expect(store.useUi.getState().started).toEqual([])
  })

  test('storage that throws on write does not break saving', async () => {
    const store = await loadStore()
    storageBlocked.write = true
    expect(() => saveNow(store)).not.toThrow()
  })
})
