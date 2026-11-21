// The store reading a chat's history (`loadHistory`). Ways it could fail, written first:
//  - the same page read twice (two renders of the same chat), or a page read while another is on its way;
//  - the history shown newest first (the thread reads oldest first, by stored position);
//  - an older page that replaces what is shown instead of coming before it;
//  - a failed read that is lost, or that can't be tried again.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MockAgent } from '../agent/mock'
import { AgentError } from '../agent/types'

beforeEach(() => {
  const storage = new Map<string, string>()
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
  await import('../screens/chat/run')
  await (agent as unknown as MockAgent).preload()
  return { mock: agent as unknown as MockAgent, ui: () => store.useUi.getState() }
}
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('loadHistory', () => {
  test('reads the chat once, oldest first by position, and a second call while shown reads nothing', async () => {
    const l = await load()
    void l.ui().ask('Which orders are stuck over 3 days?')
    await vi.advanceTimersByTimeAsync(60_000)
    const id = l.ui().chatId as string
    const read = vi.spyOn(l.mock, 'getChat')
    l.ui().loadHistory(id)
    l.ui().loadHistory(id)
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    const h = l.ui().history[id]
    expect(h.state).toBe('ready')
    expect(h.messages[0]).toMatchObject({ role: 'user', text: 'Which orders are stuck over 3 days?' })
    expect(h.messages.map(m => m.id)).toEqual(l.ui().extras.map(m => m.id))
    l.ui().loadHistory(id)
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
  })

  test('an older page comes before what is shown; with no older page `more` reads nothing', async () => {
    const l = await load()
    const id = l.mock.allChatIds()[0]
    const page = (pos: number[], next: string | null) => ({
      chat: { id, title: 't', customTitle: null, pinned: false, deleted: false, at: { iso: '2026-11-20T00:00:00.000Z', ms: 1 }, rev: 1, running: false },
      messages: pos.map(p => ({ id: `t_AAAAAAAAAAAAAAAAAAAAAA.${p === 0 ? 'u' : p}`, role: 'user' as const, text: `m${p}`, turnId: 't_AAAAAAAAAAAAAAAAAAAAAA', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', pos: p, at: { iso: '2026-11-20T00:00:00.000Z', ms: 1 } })),
      nextCursor: next, runs: [],
    })
    const get = vi.spyOn(l.mock, 'getChat').mockResolvedValueOnce(page([3, 2], 'older')).mockResolvedValueOnce(page([1, 0], null))
    l.ui().loadHistory(id)
    await settle()
    expect(l.ui().history[id].messages.map(m => (m as { text: string }).text)).toEqual(['m2', 'm3'])
    expect(l.ui().history[id].next).toBe('older')
    l.ui().loadHistory(id, true)
    await settle()
    expect(l.ui().history[id].messages.map(m => (m as { text: string }).text)).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(get).toHaveBeenLastCalledWith(id, 'older')
    l.ui().loadHistory(id, true)
    await settle()
    expect(get).toHaveBeenCalledTimes(2)
  })

  test('a failed read is kept as an error, and trying again reads the page', async () => {
    const l = await load()
    const id = l.mock.allChatIds()[0]
    const get = vi.spyOn(l.mock, 'getChat').mockRejectedValueOnce(new AgentError('offline', 'x'))
    l.ui().loadHistory(id)
    await settle()
    expect(l.ui().history[id].state).toBe('error')
    get.mockRestore()
    l.ui().loadHistory(id)
    await settle()
    expect(l.ui().history[id].state).toBe('ready')
  })
})

describe('history around a grant ending and a chat just started', () => {
  async function loadWithLink() {
    vi.resetModules()
    const { agent } = await import('../agent')
    let fire: (s: 'grantEnded') => void = () => {}
    vi.spyOn(agent, 'onLink').mockImplementation(l => { fire = l as never; return () => {} })
    const store = await import('./store')
    await import('../screens/chat/run')
    await (agent as unknown as MockAgent).preload()
    return { mock: agent as unknown as MockAgent, ui: () => store.useUi.getState(), grantEnded: () => fire('grantEnded') }
  }
  const page = (id: string) => ({
    chat: { id, title: 't', customTitle: null, pinned: false, deleted: false, at: { iso: '2026-11-20T00:00:00.000Z', ms: 1 }, rev: 1, running: false },
    messages: [{ id: 't_AAAAAAAAAAAAAAAAAAAAAA.u', role: 'user' as const, text: 'secret', turnId: 't_AAAAAAAAAAAAAAAAAAAAAA', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', pos: 0, at: { iso: '2026-11-20T00:00:00.000Z', ms: 1 } }],
    nextCursor: null, runs: [],
  })

  test('a read still on its way when the grant ends writes nothing back, and its failure writes nothing either', async () => {
    const l = await loadWithLink()
    const id = l.mock.allChatIds()[0]
    let finish!: (p: ReturnType<typeof page>) => void
    vi.spyOn(l.mock, 'getChat').mockReturnValueOnce(new Promise(r => { finish = r }))
    l.ui().loadHistory(id)
    l.grantEnded()
    expect(l.ui().history).toEqual({})
    finish(page(id))
    await settle()
    expect(l.ui().history).toEqual({})
  })

  test('a chat this tab started that the agent does not have (not_found) reads as empty, not as an error; a chat it did not start still errors', async () => {
    const l = await load()
    void l.ui().ask('A question')
    await settle()
    const started = l.ui().started[0].id
    const get = vi.spyOn(l.mock, 'getChat').mockRejectedValue(new (await import('../agent/types')).AgentError('not_found', 'gone'))
    l.ui().loadHistory(started)
    await settle()
    expect(l.ui().history[started]).toEqual({ messages: [], next: null, state: 'ready' })
    const other = l.mock.allChatIds().find(c => c !== started)!
    l.ui().loadHistory(other)
    await settle()
    expect(l.ui().history[other].state).toBe('error')
    expect(get).toHaveBeenCalledTimes(2)
  })

  test('openModelMenu asks the composer once per call', async () => {
    const l = await load()
    const before = l.ui().modelMenuAsk
    l.ui().openModelMenu(); l.ui().openModelMenu()
    expect(l.ui().modelMenuAsk).toBe(before + 2)
  })

  test('opening a chat follows the runs its page names (the live run and an ended one not stored yet), from the first event', async () => {
    const l = await load()
    const id = l.mock.allChatIds()[0]
    const R1 = 'r_AAAAAAAAAAAAAAAAAAAAAA', R2 = 'r_BBBBBBBBBBBBBBBBBBBBBB'
    const attach = vi.spyOn(l.mock, 'attach').mockReturnValue(() => {})
    vi.spyOn(l.mock, 'getChat').mockResolvedValue({
      chat: { id, title: 't', customTitle: null, pinned: false, deleted: false, at: { iso: '2026-11-20T00:00:00.000Z', ms: 1 }, rev: 1, running: true },
      messages: [], nextCursor: null, runs: [{ runId: R1, chatId: id, lastSeq: 9, live: true }, { runId: R2, chatId: id, lastSeq: 3, live: false }],
    })
    l.ui().loadHistory(id)
    await settle()
    // One run is followed per chat at a time (the first); each from seq 0.
    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach.mock.calls[0].slice(0, 1)).toEqual([R1])
    expect(attach.mock.calls[0][2]).toBe(0)
    expect(l.ui().runs[id]?.runId).toBe(R1)
  })

  test('one unknown-chat navigation raises one notice: the demo\'s getChat on an unknown id is itself a notice, so the thread must not ask for it', async () => {
    const l = await load()
    const heard: string[] = []
    l.mock.onNotice(n => heard.push(n.type === 'error' ? n.text : n.type))
    const { historyWanted } = await import('../screens/chat/notes')
    // What the thread does when a link names a chat that doesn't exist: it asks only when `historyWanted` says so.
    const id = 'no-such-chat'
    if (historyWanted(l.mock.read().chat.chats, id)) l.ui().loadHistory(id)
    await settle()
    expect(heard).toEqual([])
    // The read itself would have raised the second notice (this is the double the e2e saw).
    await l.mock.getChat(id).catch(() => undefined)
    expect(heard).toEqual(["That chat isn't available. It may have been deleted."])
  })
})
