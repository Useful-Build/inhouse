// The store's chat runs on the demo's agent: what a person sees while a run goes. Ways this can fail, written first:
//  1. the question shows twice (the optimistic one and the run's own), or under an id the history won't know;
//  2. Stop ends the run's queue with it (the old demo's behaviour), or leaves the thinking line up;
//  3. a turn waiting on the budget shows as failed, or its notice is lost;
//  4. a spending-cap or step-cap ending shows the generic failure instead of its own words;
//  5. a refused send (a paused agent) vanishes: the person sees nothing;
//  6. a damaged session can't be recovered from the chat.
// Expected texts are written out here, not read from the code.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MockAgent } from '../agent/mock'

let storage: Map<string, string>
beforeEach(() => {
  storage = new Map()
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } })
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function load() {
  vi.resetModules()
  const store = await import('./store')
  const { agent } = await import('../agent')
  return { store, mock: agent as unknown as MockAgent, ui: () => store.useUi.getState() }
}
type Loaded = Awaited<ReturnType<typeof load>>
const settle = () => vi.advanceTimersByTimeAsync(0)
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const open = (l: Loaded) => l.ui().chatId as string
const texts = (l: Loaded) => l.ui().extras.map(m => (m.role === 'agent' ? (m.part.type === 'text' || m.part.type === 'error' ? m.part.text : m.part.type) : m.text))
const ids = (l: Loaded) => l.ui().extras.map(m => m.id)
const Q = 'Which orders are stuck over 3 days?'

describe('a question in a chat', () => {
  test('shows once, under the stable id the run uses, and the run ends cleanly', async () => {
    const l = await load()
    void l.ui().ask(Q)
    await settle()
    expect(l.ui().extras).toHaveLength(1)
    await run(60_000)
    const user = l.ui().extras.filter(m => m.role === 'user')
    expect(user).toHaveLength(1)
    expect(user[0].id, 'the question is <turnId>.u').toMatch(/^t_[A-Za-z0-9_-]{22}\.u$/)
    const agentIds = l.ui().extras.filter(m => m.role === 'agent').map(m => m.id)
    expect(agentIds.length).toBeGreaterThan(0)
    agentIds.forEach((id, n) => expect(id, 'parts are <turnId>.<n>').toBe(`${user[0].id.slice(0, -2)}.${n}`))
    expect(Object.keys(l.ui().runs), 'nothing answering any more').toEqual([])
    expect(new Set(ids(l)).size, 'no message twice').toBe(ids(l).length)
  })
})

describe('Stop', () => {
  test('ends that answer only: a message queued behind it still goes on and is answered', async () => {
    const l = await load()
    void l.ui().ask(Q)
    await run(1000)
    const cid = open(l)
    l.ui().patch({ chatDraft: 'And which are over $500?' })
    l.ui().queueMessage()
    await settle()
    expect(l.ui().runs[cid].sent.map(q => q.text), 'it waits as a turn the agent holds').toEqual(['And which are over $500?'])
    l.ui().stopRun()
    await settle()
    expect(texts(l)).toContain('You stopped your Inhouse agent. Nothing was changed.')
    await run(60_000)
    expect(texts(l)).toContain('And which are over $500?')
    expect(l.ui().extras.filter(m => m.role === 'user').map(m => m.text), 'both questions, once each').toEqual([Q, 'And which are over $500?'])
    expect(l.ui().extras.filter(m => m.role === 'agent').length, 'the second one was answered').toBeGreaterThan(0)
    expect(Object.keys(l.ui().runs)).toEqual([])
  })
})

describe('what the spending rules say', () => {
  test('a turn waiting on the budget is waiting, not failed, and then it is answered', async () => {
    const l = await load()
    l.mock.scriptNextTurn('budgetBusyThenStart')
    void l.ui().ask(Q)
    await run(1000)
    const cid = open(l)
    expect(l.ui().views[cid].budgetWait).toBe(true)
    expect(l.ui().views[cid].notice?.text).toBe("You're close to your spending cap, so this answer is waiting for others to finish")
    expect(l.ui().extras.some(m => m.role === 'agent' && m.part.type === 'error'), 'nothing failed').toBe(false)
    expect(l.ui().runs[cid], 'still answering').toBeDefined()
    await run(120_000)
    expect(l.ui().views[cid].budgetWait).toBe(false)
    expect(l.ui().extras.some(m => m.role === 'agent' && m.part.type === 'text')).toBe(true)
  })

  test.each([
    ['capReached', "Your team has reached its spending cap, so this answer didn't run."],
    ['turnBudget', 'This answer reached the spending limit for one answer, so it stopped.'],
    ['maxTurns', 'This answer needed more steps than your team allows, so it stopped. Ask again, or raise the limit in Settings.'],
    ['budgetBusyThenFail', "This answer waited for others to finish and didn't get its turn. Try again in a minute."],
  ] as const)('%s ends with its own words', async (kind, words) => {
    const l = await load()
    l.mock.scriptNextTurn(kind)
    void l.ui().ask(Q)
    await run(200_000)
    expect(texts(l)).toContain(words)
    expect(Object.keys(l.ui().runs)).toEqual([])
  })
})

describe('a send the agent refuses', () => {
  test('a paused agent: the question stays, with the paused words and a way to try again', async () => {
    const l = await load()
    await l.mock.pause()
    void l.ui().ask(Q)
    await run(1000)
    expect(texts(l)).toContain('Your Inhouse agent is paused. Questions wait until an Admin resumes it.')
    const err = l.ui().extras.find(m => m.role === 'agent' && m.part.type === 'error')
    expect(err && err.role === 'agent' && err.part.type === 'error' && err.part.retryQuestion).toBe(Q)
    expect(Object.keys(l.ui().runs), 'no run is left waiting').toEqual([])
  })
})

describe('a damaged session', () => {
  test('is marked after the turn, refuses the next send, and Start fresh recovers it', async () => {
    const l = await load()
    l.mock.scriptNextTurn('sessionDamaged')
    void l.ui().ask(Q)
    await run(60_000)
    const cid = open(l)
    expect(l.ui().views[cid].damaged).toBe(true)
    void l.ui().ask('Another one?')
    await run(1000)
    expect(texts(l)).toContain("This chat's memory couldn't be saved, so it can't go on. Start it fresh to keep asking.")
    l.ui().resetSession(cid)
    await run(1000)
    expect(l.ui().views[cid].damaged).toBe(false)
    void l.ui().ask('And now?')
    await run(60_000)
    expect(l.ui().extras.filter(m => m.role === 'user').map(m => m.text)).toContain('And now?')
    expect(l.ui().extras.filter(m => m.role === 'agent' && m.part.type === 'error' && m.part.retryQuestion === 'And now?')).toEqual([])
  })
})

describe('a chat deleted while it answers', () => {
  test('its answer stops with a note, and what waited in it waits paused', async () => {
    const l = await load()
    void l.ui().ask(Q)
    await run(1000)
    const cid = open(l)
    l.ui().patch({ chatDraft: 'Queued one' })
    l.ui().queueMessage()
    await settle()
    l.ui().deleteChats([cid])
    await run(60_000)
    expect(Object.keys(l.ui().runs)).toEqual([])
    expect(l.ui().queued[cid]?.map(q => [q.text, q.paused])).toEqual([['Queued one', true]])
  })
})
