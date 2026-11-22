// A question asked from Today, on the real client over a fake server and socket: the chat it starts is listed once. Ways
// this can fail, written first:
//  1. the chat shows twice in the lists (once as started here, once as the agent's own list now carries it);
//  2. the same, after a reload (the saved session lists it, and so does the server's first page);
//  3. a second chat is made on the server for the one question (a second create under a new id).
// The ship spec S5 is the end-to-end proof of the same thing.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SocketLike } from '../agent/http/stream/socket'
import { chatRow, reads, server } from '../agent/http/testing/fake-server'

const RANDOM = 'AAAAAAAAAAAAAAAAAAAAAA'
const RUN = `r_${RANDOM}`
const TURN = `t_${RANDOM}`
const Q = 'scenario:hello an old question 07a7587e'

let storage: Map<string, string>
beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } })
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.doUnmock('@client') })

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(r => setTimeout(r, 0)) }

/** The server: the chats it was asked to make, by id, and every create it was sent. */
function backend() {
  const chats = new Map<string, { id: string; title: string }>()
  const creates: string[] = []
  const base = server(reads())
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://x.test')
    const at = `${init?.method ?? 'GET'} ${decodeURIComponent(url.pathname)}${url.search}`
    const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (at === 'POST /api/chats') {
      const c = JSON.parse(String(init?.body)) as { id: string; title: string }
      creates.push(c.id)
      if (!chats.has(c.id)) chats.set(c.id, c)
      return answer(chatRow(c.id, { title: chats.get(c.id)!.title }))
    }
    if (at === 'GET /api/chats?limit=50') return answer({ items: [...chats.values()].map(c => chatRow(c.id, { title: c.title })), nextCursor: null })
    if (at === 'GET /api/runs/active') return answer({ runs: [] })
    if (/^POST \/api\/chats\/[^/]+\/turns$/.test(at)) return answer({ runId: RUN, turnId: TURN, messageId: `${TURN}.u`, position: 'starting' })
    return base.fetch(input, init)
  }
  return { fetch, chats, creates }
}

/** A socket that answers an attach with the whole run: a short answer, then the run's end. */
class RunSocket implements SocketLike {
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  private readonly chatId: () => string
  constructor(chatId: () => string) { this.chatId = chatId; setTimeout(() => this.onopen?.(), 0) }
  close() {}
  send(d: string) {
    const m = JSON.parse(d) as { type: string; runId: string }
    if (m.type !== 'attach') return
    const at = { iso: new Date(5000).toISOString(), ms: 5000 }
    const events = [
      { type: 'run.started', runId: RUN, chatId: this.chatId() },
      { type: 'turn.started', turnId: TURN, model: 'opus' },
      { type: 'part', turnId: TURN, messageId: `${TURN}.0`, part: { type: 'text', text: 'Hello from the scripted model.' }, model: 'opus', at },
      { type: 'turn.finished', turnId: TURN, outcome: 'done' },
      { type: 'run.finished', runId: RUN, turns: 1, durationMs: 10, cost: { minor: 1, currency: 'USD' } },
    ]
    setTimeout(() => {
      this.onmessage?.({ data: JSON.stringify({ type: 'attached', runId: RUN, lastSeq: events.length, live: true }) })
      events.forEach((event, n) => this.onmessage?.({ data: JSON.stringify({ type: 'frame', frame: { v: 1, chatId: this.chatId(), runId: RUN, seq: n + 1, at, event } }) }))
    }, 0)
  }
}

/** The app as a page load sees it: a fresh store on the product client, over the same server and the same saved session. */
async function load(be: ReturnType<typeof backend>) {
  vi.resetModules()
  let open = () => ''
  vi.doMock('@client', async () => {
    const { HttpAgent } = await import('../agent/http/client')
    const agent = new HttpAgent({ fetch: be.fetch, origin: '', openSocket: () => new RunSocket(() => open()) })
    return { default: { agent, demo: null, now: () => Date.now() } }
  })
  const store = await import('./store')
  const { agent } = await import('../agent')
  await (agent as unknown as { whenLoaded(): Promise<void> }).whenLoaded()
  await settle()
  const ui = () => store.useUi.getState()
  open = () => ui().chatId ?? ''
  /** What the sidebar's Recent chats and All chats list. */
  const listed = () => store.chatEntries(agent.read(), ui().started, agent.getSnapshot())
  return { store, agent, ui, listed }
}

test('one question from Today makes one chat, listed once, before and after a reload', async () => {
  const be = backend()
  const page = await load(be)
  page.ui().go('today')
  page.ui().patch({ todayDraft: Q })
  void page.ui().ask(Q, { fromComposer: true })
  await settle()
  const id = page.ui().chatId as string
  expect(id).toBeTruthy()
  expect(Object.keys(page.ui().runs), 'the answer ended').toEqual([])
  expect(page.ui().extras.map(m => (m.role === 'user' ? m.text : m.role === 'agent' && m.part.type === 'text' ? m.part.text : m.role)))
    .toEqual([Q, 'Hello from the scripted model.'])
  expect(page.listed().map(c => [c.id, c.title]), 'listed once').toEqual([[id, Q]])

  const again = await load(be)
  expect(again.listed().map(c => [c.id, c.title]), 'listed once after the reload').toEqual([[id, Q]])
  expect([...be.chats.keys()], 'one chat on the server').toEqual([id])
  expect(new Set(be.creates), 'every create named that one chat').toEqual(new Set([id]))
})
