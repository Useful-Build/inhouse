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
