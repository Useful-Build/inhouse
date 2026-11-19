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
// Why `fc.assert(fc.asyncProperty(...))` and not `test.prop`: the arbitraries are built with `await` (they need the
// agent's real chat ids), and `test.prop` takes ready-made arbitraries. fast-check prints the seed and the shrunk
// counterexample when a property fails. To replay: VITE_PROP_SEED=<seed> npm run test:unit
//
// Run count: 100 by default. For a long run: VITE_PROP_RUNS=1000 npm run test:unit
import { fc } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Attachment, ChatMessage, MessagePart } from '../agent/types'
import { CHAT_TITLE_MAX } from '../agent/types'
import { STARTED_CHAT_PREFIX } from './chatIds'
import type { ChatEntry, ComposerDraft, LibraryView, QueuedMsg } from './store'

const numRuns = Number(import.meta.env.VITE_PROP_RUNS) || 100
const seedText = import.meta.env.VITE_PROP_SEED
const params: fc.Parameters<unknown> = { numRuns, ...(seedText ? { seed: Number(seedText) } : {}) }

// ---------- a fake browser: just what the store touches when it is made ----------
let storage: Map<string, string>
let onPagehide: (() => void)[]
let storageBlocked: { read: boolean; write: boolean }

beforeEach(async () => {
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
  await sampleOf()
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

/** Empty storage, no listeners: the start of one run. */
function reset() {
  storage.clear()
  onPagehide = []
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

/** The view of a store with nothing saved. */
async function emptyView() {
  reset()
  return view(await loadStore())
}

/** Every chat's additions, the open one's too, without empty entries (the way a save files them). */
function chatsOf(store: Store): Record<string, { extras: ChatMessage[]; hidden: Record<string, true> }> {
  const s = store.useUi.getState()
  const all = { ...s.stash }
  if (s.chatId !== null) all[s.chatId] = { extras: s.extras, hidden: s.hidden }
  return Object.fromEntries(Object.entries(all).filter(([, c]) => c.extras.length || Object.keys(c.hidden).length))
}

/** Save the way the app does: a change schedules a save, `pagehide` runs it now. */
function saveNow(store: Store): string | null {
  const s = store.useUi.getState()
  store.useUi.setState({ started: [...s.started] })
  for (const fn of onPagehide) fn()
  return storage.get(store.SESSION_KEY) ?? null
}

// ---------- arbitraries that mirror the real types ----------
/** Long text is real: the app caps no message or draft, only chat titles. */
const long = fc.string({ minLength: 2000, maxLength: 10000 })
const text = (arb: fc.Arbitrary<string>) => fc.oneof({ weight: 20, arbitrary: arb }, { weight: 4, arbitrary: fc.string({ unit: 'binary' }) }, { weight: 4, arbitrary: fc.constant('') }, { weight: 3, arbitrary: long })
const str = text(fc.string())
/** A chat title: never past CHAT_TITLE_MAX. */
const title = fc.oneof({ weight: 20, arbitrary: fc.string({ maxLength: CHAT_TITLE_MAX }) }, { weight: 4, arbitrary: fc.string({ unit: 'binary', maxLength: CHAT_TITLE_MAX }) }, { weight: 4, arbitrary: fc.constant('') })
const optional = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined })

const attachment: fc.Arbitrary<Attachment> = fc.record({ name: str, meta: str, icon: str })

const row = fc.record({ order: str, age: str, why: str, value: str })
const part: fc.Arbitrary<MessagePart> = fc.oneof(
  fc.record({ type: fc.constant('text' as const), text: str }),
  fc.record({
    type: fc.constant('table' as const),
    table: fc.record({ title: str, summary: str, icon: optional(str), rows: fc.array(row, { maxLength: 4 }), sources: fc.array(str, { maxLength: 4 }) },
      { requiredKeys: ['title', 'summary', 'rows', 'sources'] }),
  }),
  fc.record({ type: fc.constant('approval' as const), problemId: str }),
  fc.record({
    type: fc.constant('routine' as const),
    routine: fc.record({ id: str, name: str, freq: str, day: str, time: str, next: str, note: str }),
  }),
  fc.record({ type: fc.constant('skill' as const), skill: fc.record({ name: str, desc: str, tools: str, mode: str }) }),
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
// `pinned` is a real ChatEntry field, but the session doesn't keep it (the agent does): load drops it, by design.
const started: fc.Arbitrary<ChatEntry> = fc.record({ id: startedId, title, day: str, at: str, pinned: optional(fc.boolean()) }, { requiredKeys: ['id', 'title', 'day', 'at'] })

const hidden = fc.dictionary(str, fc.constant(true as const), { maxKeys: 4 })
const adds = fc.record({ extras: fc.array(message, { maxLength: 4 }), hidden })
const draft: fc.Arbitrary<ComposerDraft> = fc.record({ text: str, atts: fc.array(attachment, { maxLength: 3 }) })

/** A queued message as the JSON can hold it: `paused` may be anything a save left (load always makes it true). */
type SavedQueued = Omit<QueuedMsg, 'paused'> & { paused?: boolean }
/** The agent's own chat ids and model ids, read once from an agent that started with nothing saved. The agent in the module
 *  cache has taken in the started chats of an earlier run, so its list can't be trusted. */
let sample: { chatIds: string[]; models: string[] } | undefined
async function sampleOf() {
  if (!sample) {
    reset()
    vi.resetModules()
    const { agent } = await import('../agent')
    sample = { chatIds: agent.allChatIds(), models: agent.read().models.map(m => m.id) }
  }
  return sample
}
const usableModels = async () => (await sampleOf()).models

interface Session {
  started: ChatEntry[]
  chats: Record<string, { extras: ChatMessage[]; hidden: Record<string, true> }>
  todayDraft: string
  drafts: Record<string, ComposerDraft>
  modelSel: string | null
  feedback: Record<string, 'up' | 'down'>
  libraryView: LibraryView
  answering: string[]
  queued: Record<string, SavedQueued[]>
}

/** A saved session that is valid by the store's own rules. Chat ids are the real sample ids plus the started chats' ids. */
async function validSession(): Promise<fc.Arbitrary<Session>> {
  const { chatIds: sampleIds, models } = await sampleOf()
  const queued: fc.Arbitrary<SavedQueued> = fc.record({
    id: str, text: str, quote: optional(str), atts: optional(fc.array(attachment, { maxLength: 3 })),
    model: fc.constantFrom<string | null>(null, ...models), paused: optional(fc.boolean()),
  }, { requiredKeys: ['id', 'text', 'model'] })
  // Chat ids are picked by slot, not with `chain`: a chain shrinks the started list alone and leaves ids that point at
  // chats no longer there, which makes a valid-looking counterexample that isn't valid.
  const slot = fc.nat()
  return fc.record({
    list: fc.uniqueArray(started, { selector: c => c.id, maxLength: 3 }),
    chats: fc.array(fc.tuple(slot, adds), { maxLength: 6 }),
    todayDraft: str,
    drafts: fc.array(fc.tuple(fc.option(slot, { nil: null }), draft), { maxLength: 6 }),
    modelSel: fc.constantFrom<string | null>(null, ...models),
    feedback: fc.dictionary(str, fc.constantFrom('up' as const, 'down' as const)),
    libraryView: fc.constantFrom('masonry' as const, 'grid' as const, 'list' as const),
    answering: fc.array(slot, { maxLength: 2 }),
    queued: fc.array(fc.tuple(slot, fc.array(queued, { minLength: 1, maxLength: 3 })), { maxLength: 4 }),
  }).map((r): Session => {
    const ids = [...sampleIds, ...r.list.map(c => c.id)]
    const at = (n: number) => ids[n % ids.length]
    return {
      started: r.list,
      chats: Object.fromEntries(r.chats.map(([n, c]) => [at(n), c])),
      todayDraft: r.todayDraft,
      drafts: Object.fromEntries(r.drafts.map(([n, d]) => [n === null ? 'today' : at(n), d])),
      modelSel: r.modelSel,
      feedback: r.feedback,
      libraryView: r.libraryView,
      answering: [...new Set(r.answering.map(at))],
      queued: Object.fromEntries(r.queued.map(([n, list]) => [at(n), list])),
    }
  })
}

/** Every field the store restored equals what the session holds, the way load is meant to read it:
 *  `pinned` is dropped, a queued message waits paused, and a chat that was answering gets the reload note. */
function expectLoaded(session: Session, store: Store) {
  const s = store.useUi.getState()
  expect(s.started).toEqual(session.started.map(({ id, title, day, at }) => ({ id, title, day, at })))
  expect(s.todayDraft).toBe(session.todayDraft)
  expect(s.libraryView).toBe(session.libraryView)
  expect(s.feedback).toEqual(session.feedback)
  expect(s.modelSel).toBe(session.modelSel)

  // Chats: what was saved, minus empty entries, plus a reload note on each chat that was answering.
  const chats = chatsOf(store)
  for (const id of session.answering) {
    const note = chats[id]?.extras.at(-1)
    expect(note, `no reload note on ${id}`).toBeDefined()
    expect(note?.role).toBe('event')
    expect(note && store.isStoppedNote(note)).toBe(true)
    expect(note && 'text' in note ? note.text : '').toContain('reloaded')
    chats[id] = { ...chats[id], extras: chats[id].extras.slice(0, -1) }
    if (!chats[id].extras.length && !Object.keys(chats[id].hidden).length) delete chats[id]
  }
  const wantChats = Object.fromEntries(Object.entries(session.chats).filter(([, c]) => c.extras.length || Object.keys(c.hidden).length))
  expect(chats).toEqual(wantChats)

  // Drafts: Today's files go to `atts`, every other composer's draft stays under its id.
  const { today, ...others } = session.drafts
  expect(s.drafts).toEqual(others)
  expect(s.atts).toEqual(today?.atts ?? [])

  // Queued: each waits paused, whatever `paused` was saved as.
  const wantQueued = Object.fromEntries(Object.entries(session.queued).map(([id, list]) => [id, list.map(q => ({ ...q, paused: true }))]))
  expect(s.queued).toEqual(wantQueued)
}

/** The same rules as the store's, written separately: a restored message has the shape of its role and part. */
const strs = (o: object, keys: string[]) => keys.every(k => typeof (o as Record<string, unknown>)[k] === 'string')
function validAtts(list: unknown): boolean {
  return Array.isArray(list) && list.every(a => typeof a === 'object' && a !== null && strs(a, ['name', 'meta', 'icon']))
}
function validPart(p: MessagePart): boolean {
  switch (p.type) {
    case 'text': case 'notInThisStage': return strs(p, ['text'])
    case 'table': return strs(p.table, ['title', 'summary']) && (p.table.icon === undefined || typeof p.table.icon === 'string')
      && p.table.rows.every(r => strs(r, ['order', 'age', 'why', 'value'])) && p.table.sources.every(x => typeof x === 'string')
    case 'approval': return strs(p, ['problemId'])
    case 'routine': return strs(p.routine, ['id', 'name', 'freq', 'day', 'time', 'next', 'note'])
    case 'skill': return strs(p.skill, ['name', 'desc', 'tools', 'mode'])
    case 'workRow': return strs(p, ['text', 'time'])
    case 'error': return strs(p, ['text', 'retryQuestion'])
    case 'suggestions': return p.questions.every(x => typeof x === 'string')
    default: return false
  }
}
function validMsg(m: ChatMessage): boolean {
  if (typeof m.id !== 'string') return false
  if (m.role === 'user') return strs(m, ['text']) && (m.quote === undefined || typeof m.quote === 'string') && (m.atts === undefined || validAtts(m.atts))
  if (m.role === 'event') return strs(m, ['text'])
  if (m.role === 'agent') return typeof m.trace === 'string' && validPart(m.part) && (m.model === undefined || typeof m.model === 'string') && (m.at === undefined || typeof m.at === 'number')
  return false
}

/** Usable: the store exists, and every restored field has the right shape and refers only to things that exist. */
async function expectUsable(store: Store) {
  const { chatIds, models } = await sampleOf()
  const s = store.useUi.getState()
  expect(s.page).toBe('today')
  expect(Array.isArray(s.started)).toBe(true)
  for (const c of s.started) {
    expect(c.id.startsWith(STARTED_CHAT_PREFIX)).toBe(true)
    expect([c.title, c.day, c.at].every(v => typeof v === 'string')).toBe(true)
  }
  const known = new Set([...chatIds, ...s.started.map(c => c.id)])
  expect(typeof s.todayDraft).toBe('string')
  expect(['masonry', 'grid', 'list']).toContain(s.libraryView)
  expect(s.modelSel === null || models.includes(s.modelSel)).toBe(true)
  for (const v of Object.values(s.feedback)) expect(['up', 'down']).toContain(v)

  // What was added to chats: only chats that exist, only valid messages, `hidden` holds only true.
  expect(s.extras.every(validMsg)).toBe(true)
  expect(Object.values(s.hidden).every(v => v === true)).toBe(true)
  for (const [id, c] of Object.entries(s.stash)) {
    expect(known.has(id), `stash holds unknown chat ${id}`).toBe(true)
    expect(Array.isArray(c.extras) && c.extras.every(validMsg)).toBe(true)
    expect(Object.values(c.hidden).every(v => v === true)).toBe(true)
    expect(Object.getPrototypeOf(c.hidden)).toBe(Object.prototype)
  }

  // Drafts: only existing composers, text a string, files whole.
  expect(validAtts(s.atts)).toBe(true)
  for (const [id, d] of Object.entries(s.drafts)) {
    expect(known.has(id), `drafts hold unknown composer ${id}`).toBe(true)
    expect(typeof d.text).toBe('string')
    expect(validAtts(d.atts)).toBe(true)
  }

  // Queued: only existing chats, each paused, its model one the team can use or null.
  for (const [id, list] of Object.entries(s.queued)) {
    expect(known.has(id), `queued holds unknown chat ${id}`).toBe(true)
    for (const q of list) {
      expect(q.paused).toBe(true)
      expect(strs(q, ['id', 'text'])).toBe(true)
      expect(q.quote === undefined || typeof q.quote === 'string').toBe(true)
      expect(q.atts === undefined || validAtts(q.atts)).toBe(true)
      expect(q.model === null || models.includes(q.model)).toBe(true)
    }
  }

  // Nothing leaked onto a prototype.
  for (const o of [s.feedback, s.stash, s.drafts, s.queued, s.hidden]) expect(Object.getPrototypeOf(o)).toBe(Object.prototype)
  expect(Object.keys(Object.prototype)).toEqual([])
  const plain = {} as Record<string, unknown>
  for (const k of ['libraryView', 'extras', 'hidden', 'text', 'atts', 'paused', 'up']) expect(plain[k]).toBeUndefined()
  // And the usable store saves again without throwing.
  expect(() => saveNow(store)).not.toThrow()
}

describe('session save and load', () => {
  test('round trip: every field loads back as saved, and saving again changes nothing', async () => {
    const arb = await validSession()
    await fc.assert(fc.asyncProperty(arb, async session => {
      reset()
      const key = (await loadStore()).SESSION_KEY
      reset()
      storage.set(key, JSON.stringify(session))

      const first = await loadStore()
      expectLoaded(session, first)
      const before = view(first)

      // Save it again and load that: the same session comes back.
      const saved = saveNow(first)
      expect(saved).not.toBeNull()
      onPagehide = []
      const second = await loadStore()
      expect(view(second)).toEqual(before)
      expect(saveNow(second)).toBe(saved)
    }), params)
  })

  // Junk that is not a record at all: nothing to read, so the store starts as if nothing was saved.
  const notRecord = (v: unknown) => typeof v !== 'object' || v === null || Array.isArray(v)
  const parsesToRecord = (t: string) => { try { return !notRecord(JSON.parse(t)) } catch { return false } }
  const nonRecordJunk = fc.oneof(
    fc.string().filter(t => !parsesToRecord(t)),
    fc.string({ unit: 'binary' }).filter(t => !parsesToRecord(t)),
    fc.jsonValue().filter(notRecord).map(v => JSON.stringify(v)),
    fc.constantFrom('', 'null', '[]', '0', 'true', '"x"', '[{"started":[]}]', '{"started":', '{', '}', 'undefined', 'NaN'),
  )
  /** A truncated valid session: the write was cut off. Never the whole text, so it never parses. */
  async function truncated() {
    const valid = await validSession()
    return fc.tuple(valid, fc.nat(99)).map(([s, pct]) => {
      const json = JSON.stringify(s)
      return json.slice(0, Math.floor(json.length * pct / 100))
    })
  }

  test('junk that is not a record loads as an empty store', async () => {
    const empty = await emptyView()
    await fc.assert(fc.asyncProperty(nonRecordJunk, async junk => {
      reset()
      const store = await loadStore()
      storage.set(store.SESSION_KEY, junk)
      const loaded = await loadStore()
      expect(view(loaded)).toEqual(empty)
      await expectUsable(loaded)
    }), params)
  })

  test('a cut-off save loads as an empty store', async () => {
    const empty = await emptyView()
    const arb = await truncated()
    await fc.assert(fc.asyncProperty(arb, async cut => {
      reset()
      const key = (await loadStore()).SESSION_KEY
      reset()
      storage.set(key, cut)
      const loaded = await loadStore()
      expect(view(loaded)).toEqual(empty)
      await expectUsable(loaded)
    }), params)
  })

  // Records with the right keys and wrong contents: every restored field is still checked, deeply.
  const recordJunk = fc.oneof(
    fc.record({
      started: fc.jsonValue(), chats: fc.jsonValue(), todayDraft: fc.jsonValue(), drafts: fc.jsonValue(), modelSel: fc.jsonValue(),
      feedback: fc.jsonValue(), libraryView: fc.jsonValue(), answering: fc.jsonValue(), queued: fc.jsonValue(), extra: fc.jsonValue(),
    }, { requiredKeys: [] }).map(v => JSON.stringify(v)),
    fc.jsonValue().filter(v => !notRecord(v)).map(v => JSON.stringify(v)),
    fc.constantFrom('{}', '{"started":null}', '{"chats":[]}', '{"drafts":"x"}', '{"queued":{"a":5}}'),
  )

  test('a record with junk contents gives a usable store', async () => {
    await fc.assert(fc.asyncProperty(recordJunk, async junk => {
      reset()
      const key = (await loadStore()).SESSION_KEY
      reset()
      storage.set(key, junk)
      await expectUsable(await loadStore())
    }), params)
  })

  test('a valid session with one field swapped for junk still loads, and the other fields are untouched', async () => {
    const valid = await validSession()
    const fields = ['started', 'chats', 'todayDraft', 'drafts', 'modelSel', 'feedback', 'libraryView', 'answering', 'queued'] as const
    await fc.assert(fc.asyncProperty(valid, fc.constantFrom(...fields), fc.jsonValue(), async (session, field, value) => {
      reset()
      const key = (await loadStore()).SESSION_KEY
      reset()
      storage.set(key, JSON.stringify({ ...session, [field]: value }))
      const store = await loadStore()
      await expectUsable(store)
      // These four don't depend on any other field.
      const s = store.useUi.getState()
      if (field !== 'todayDraft') expect(s.todayDraft).toBe(session.todayDraft)
      if (field !== 'libraryView') expect(s.libraryView).toBe(session.libraryView)
      if (field !== 'feedback') expect(s.feedback).toEqual(session.feedback)
      if (field !== 'modelSel') expect(s.modelSel).toBe(session.modelSel)
    }), params)
  })

  test('chats that do not exist and models the team cannot use are dropped', async () => {
    const valid = await validSession()
    const models = await usableModels()
    const ghost = fc.uniqueArray(fc.string().map(s => `ghost-${s}`), { minLength: 1, maxLength: 3 })
    // Random ids plus near-misses of real ones (case, spaces, prefixes), so a loose compare would fail.
    const nearMiss = fc.constantFrom(...models).chain(m => fc.constantFrom(m.toUpperCase(), ` ${m}`, `${m} `, m.slice(0, -1), `${m}x`))
    const unusable = fc.oneof(fc.string(), nearMiss).filter(s => !models.includes(s))
    await fc.assert(fc.asyncProperty(valid, ghost, unusable, fc.boolean(), async (session, ghosts, badModel, spoilQueued) => {
      const spoil = (q: SavedQueued): SavedQueued => (spoilQueued ? { ...q, model: badModel } : q)
      const dirty: Session = {
        ...session,
        modelSel: badModel,
        chats: { ...session.chats, ...Object.fromEntries(ghosts.map(id => [id, { extras: [], hidden: { x: true as const } }])) },
        drafts: { ...session.drafts, ...Object.fromEntries(ghosts.map(id => [id, { text: 'a', atts: [] }])) },
        answering: [...session.answering, ...ghosts],
        queued: {
          ...Object.fromEntries(Object.entries(session.queued).map(([id, list]) => [id, list.map(spoil)])),
          ...Object.fromEntries(ghosts.map(id => [id, [{ id: 'q', text: 'a', model: null }]])),
        },
      }
      // What load should make of it: no ghost anywhere, no model pick, and the spoiled queue models fall back to null.
      const clean: Session = {
        ...session, modelSel: null,
        queued: Object.fromEntries(Object.entries(session.queued).map(([id, list]) => [id, list.map(q => ({ ...q, model: spoilQueued ? null : q.model }))])),
      }
      reset()
      const key = (await loadStore()).SESSION_KEY
      reset()
      storage.set(key, JSON.stringify(dirty))
      const store = await loadStore()
      expectLoaded(clean, store)
      const s = store.useUi.getState()
      for (const id of ghosts) {
        expect(Object.keys(s.stash)).not.toContain(id)
        expect(Object.keys(s.drafts)).not.toContain(id)
        expect(Object.keys(s.queued)).not.toContain(id)
      }
      await expectUsable(store)
    }), params)
  })

  test('a save under another version key is ignored', async () => {
    const valid = await validSession()
    const empty = await emptyView()
    const other = fc.oneof(fc.integer({ min: 0, max: 99 }).filter(n => n !== 1), fc.constantFrom(-1, 2, 10))
    await fc.assert(fc.asyncProperty(valid, other, async (session, version) => {
      reset()
      const key = (await loadStore()).SESSION_KEY
      expect(key).toMatch(/\.v1$/)
      const otherKey = key.replace(/\.v1$/, `.v${version}`)
      reset()
      const body = JSON.stringify(session)
      storage.set(otherKey, body)
      const store = await loadStore()
      expect(view(store)).toEqual(empty)
      // Saving writes the current key and leaves the other one alone.
      saveNow(store)
      expect(storage.get(otherKey)).toBe(body)
      expect(storage.get(key)).not.toBe(body)
    }), params)
  })

  // Keys that name something on Object.prototype, or look like it, in every record the session holds.
  const hostileKey = fc.oneof(
    fc.constantFrom('__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', '__lookupGetter__', 'isPrototypeOf', 'today'),
    str,
  )
  /** A JSON object written by hand, so `__proto__` is a real key in the text. */
  const obj = (entries: [string, string][]) => `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}`

  test('hostile keys never leak and never become chats', async () => {
    const realId = (await sampleOf()).chatIds[0]
    const keys = fc.uniqueArray(hostileKey, { maxLength: 6 })
    await fc.assert(fc.asyncProperty(keys, keys, keys, keys, keys, fc.constantFrom<'up' | 'down'>('up', 'down'), async (feedbackKeys, chatKeys, draftKeys, queuedKeys, hiddenKeys, thumb) => {
      const att = JSON.stringify({ name: 'n', meta: 'm', icon: 'i' })
      const raw = obj([
        ['feedback', obj(feedbackKeys.map(k => [k, JSON.stringify(thumb)]))],
        ['chats', obj([...chatKeys.map((k): [string, string] => [k, '{"extras":[],"hidden":{"x":true}}']),
          ...hiddenKeys.length ? [[realId, `{"extras":[],"hidden":${obj(hiddenKeys.map(k => [k, 'true']))}}`] as [string, string]] : []])],
        ['drafts', obj(draftKeys.map(k => [k, `{"text":"t","atts":[${att}]}`]))],
        ['queued', obj(queuedKeys.map(k => [k, '[{"id":"q","text":"t","model":null}]']))],
      ])
      reset()
      const key = (await loadStore()).SESSION_KEY
      reset()
      storage.set(key, raw)
      const store = await loadStore()
      await expectUsable(store)
      const s = store.useUi.getState()
      // Thumbs are free-form keys: they all load, as own entries.
      expect(Object.entries(s.feedback).sort()).toEqual(feedbackKeys.map(k => [k, thumb]).sort())
      // No hostile key is a chat, so none files a draft or a queue. Today's files come from the 'today' key only.
      expect(Object.keys(s.drafts)).toEqual([])
      expect(s.atts.length).toBe(draftKeys.includes('today') ? 1 : 0)
      expect(Object.keys(s.queued)).toEqual([])
      // Hidden keys on a real chat all load.
      const hiddenLoaded = Object.keys(chatsOf(store)[realId]?.hidden ?? {}).sort()
      expect(hiddenLoaded).toEqual([...hiddenKeys].sort())
      expect(Object.keys(chatsOf(store)).filter(id => id !== realId)).toEqual([])
    }), params)
  })

  test('storage that throws on read starts fresh and warns', async () => {
    const empty = await emptyView()
    storageBlocked.read = true
    const warn = vi.mocked(console.warn)
    warn.mockClear()
    onPagehide = []
    const store = await loadStore()
    expect(view(store)).toEqual(empty)
    // Other stores (the agent's own state) warn about the blocked read too, so look for the session's notice.
    expect(warn.mock.calls.map(c => String(c[0]))).toContain('Inhouse: could not read the saved session, starting fresh.')
    // Reading is blocked, not writing: the store still works and saves.
    storageBlocked.read = false
    expect(() => saveNow(store)).not.toThrow()
  })

  test('failed saves: each warns, the notice shows once per run of failures, state and storage stay intact', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), async outcomes => {
      reset()
      storageBlocked.write = false
      const store = await loadStore()
      const toast = vi.fn()
      store.useUi.setState({ showToast: toast })
      const warn = vi.mocked(console.warn)
      warn.mockClear()
      const initial = storage.get(store.SESSION_KEY)

      let failing = false
      let fails = 0
      let notices = 0
      let lastSaved: string | undefined
      outcomes.forEach((works, i) => {
        storageBlocked.write = !works
        const draft = `step-${i}`
        store.useUi.setState({ todayDraft: draft })
        expect(() => { for (const fn of onPagehide) fn() }).not.toThrow()
        if (works) { failing = false; lastSaved = draft }
        else { fails++; if (!failing) notices++; failing = true }
        // The state is whatever the person typed, saved or not.
        expect(store.useUi.getState().todayDraft).toBe(draft)
      })
      expect(warn).toHaveBeenCalledTimes(fails)
      expect(toast).toHaveBeenCalledTimes(notices)
      for (const call of toast.mock.calls) expect(String(call[0])).toContain("Couldn't save")
      // Storage holds the last save that worked, or what was there before.
      const stored = storage.get(store.SESSION_KEY)
      if (lastSaved === undefined) expect(stored).toBe(initial)
      else expect((JSON.parse(stored ?? 'null') as Session).todayDraft).toBe(lastSaved)
    }), params)
  })
})
