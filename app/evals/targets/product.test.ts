// The product target's end of a turn that parks on a question (Stage 1 M2-H: `question_ask` is on in the eval build).
// Ways it could fail, written first:
//  - a lone `question_ask` leaves the chat waiting with no answer and no end row, and the chat loop polls until its timeout;
//  - another chat's question, or one already answered, is taken as this turn's end;
//  - the question's text and options aren't recorded for grading (T10 grades the call), or the call is counted twice
//    when the trace already holds it;
//  - a turn that answered, or ended with an end row, reads the questions at all.
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { GRADED_PROMPT_APP, GRADED_PROMPT_VERSION } from '../prompt-version.ts'
import { API_TIMEOUT_MS, QUESTION_ASK, createProductTarget, parkedAnswer, parkedQuestionOf, productSession } from './product.ts'
import type { Api } from './product.ts'

const TURN = 't_AAAAAAAAAAAAAAAAAAAAAA'
const QUESTION = { question: 'Norda or the cheaper supplier?', options: ['Norda', 'The cheaper one'] }

interface World {
  /** The chat's messages once read this many times (a parked turn has none of its own). */
  messages: (reads: number, chatId: string) => unknown[]
  /** Route 140's items for the reading person. */
  questions: (chatId: string) => unknown[]
  /** The trace's tool steps. */
  steps: unknown[]
}

function session(w: World) {
  const calls: string[] = []
  let chatId = ''
  let reads = 0
  const api: Api = async (_who, method, path, o) => {
    calls.push(`${method} ${path}`)
    const ok = (json: unknown, status = 200) => ({ status, json, text: JSON.stringify(json) })
    if (method === 'POST' && path === '/api/chats') { chatId = String((o?.json as { id?: string } | undefined)?.id); return ok({}, 201) }
    if (method === 'POST' && path.endsWith('/turns')) return ok({ turnId: TURN }, 202)
    if (method === 'GET' && path === `/api/chats/${chatId}`) return ok({ messages: w.messages(++reads, chatId) })
    if (method === 'GET' && path === '/api/questions') return ok({ items: w.questions(chatId) })
    if (method === 'GET' && path.startsWith('/api/traces/')) {
      return ok({ steps: w.steps, cost: { minor: 3 }, promptVersions: [GRADED_PROMPT_VERSION], promptApps: [[GRADED_PROMPT_APP]] })
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
  const s = productSession({
    api, must: (r, what, okc = [200, 201]) => { if (!okc.includes(r.status)) throw new Error(`${what}: ${r.status}`) },
    door: { rows: async () => [] } as never, people: { current: 'm_cur', tom: 'm_tom', lena: 'm_lena' }, askedAs: 'eval-x',
    picker: 'sonnet', real: new Map(), pollMs: 1, sleep: async () => {}, onSpend: () => {},
  })
  return { s, calls, chat: () => chatId }
}

const open = (chatId: string, o: Record<string, unknown> = {}) => ({ id: 'q_AAAAAAAAAAAAAAAAAAAAAA', state: 'open', chatId, ...QUESTION, ...o })

describe('a turn parked on a question', () => {
  test('ends at the open question of its chat: the answer reads as the question and options, and the call is recorded with them', async () => {
    const { s } = session({ messages: () => [], questions: (c) => [open('c_other'), open(c, { state: 'answered' }), open(c)], steps: [] })
    const r = await s.chat('Ask me which supplier to use.')
    expect(r.answer).toBe(parkedAnswer(QUESTION))
    expect(r.answer).toBe('Asked: Norda or the cheaper supplier?\nOptions: Norda | The cheaper one')
    expect(r.runOk).toBe(true)
    expect(r.toolCalls).toEqual([{ name: QUESTION_ASK, input: QUESTION, result: 'Asked; the chat waits on the answer (seen from the open question, route 140)', isError: false }])
  })

  test("the trace's own question_ask call is kept, not doubled", async () => {
    const step = { kind: 'tool', detail: QUESTION_ASK, io: { input: JSON.stringify(QUESTION) } }
    const { s } = session({ messages: () => [], questions: (c) => [open(c)], steps: [step] })
    const r = await s.chat('Ask me.')
    expect(r.toolCalls.filter((c) => c.name === QUESTION_ASK)).toHaveLength(1)
    expect(r.toolCalls[0]!.input).toEqual(QUESTION)
  })

  test('waits while nothing is there yet, then ends when the question opens', async () => {
    let asked = false
    const { s, calls } = session({ messages: (n) => { if (n >= 3) asked = true; return [] }, questions: (c) => (asked ? [open(c)] : []), steps: [] })
    const r = await s.chat('Ask me.')
    expect(r.answer).toBe(parkedAnswer(QUESTION))
    expect(calls.filter((c) => c === 'GET /api/questions')).toHaveLength(3)
  })

  test('only another chat\'s or an answered question: not an end (an answer that comes later is)', async () => {
    const { s } = session({
      messages: (n) => (n >= 4 ? [{ role: 'agent', turnId: TURN, pos: 1, part: { type: 'text', text: 'Went with Norda.' } }] : []),
      questions: (c) => [open('c_other'), open(c, { state: 'answered' })],
      steps: [],
    })
    const r = await s.chat('Ask me.')
    expect(r.answer).toBe('Went with Norda.')
    expect(r.toolCalls).toEqual([])
  })

  test('a turn that answered at once never reads the questions', async () => {
    const { s, calls } = session({ messages: () => [{ role: 'agent', turnId: TURN, pos: 1, part: { type: 'text', text: 'Done.' } }], questions: () => { throw new Error('read') }, steps: [] })
    expect((await s.chat('Hi')).answer).toBe('Done.')
    expect(calls).not.toContain('GET /api/questions')
  })

  test('parkedQuestionOf takes only an open question of this chat', () => {
    expect(parkedQuestionOf([open('c_1', { state: 'expired' }), open('c_2')], 'c_1')).toBeNull()
    expect(parkedQuestionOf([open('c_1')], 'c_1')).toEqual(QUESTION)
  })
})

describe('#672: every call to the eval deployment has a deadline', () => {
  const env = { INHOUSE_EVAL_BRAND: '1', INHOUSE_EVAL_RUN: '1-1', INHOUSE_EVAL_ORIGIN: 'https://eval.example', INHOUSE_EVAL_ACCESS_CLIENT_ID: 'id', INHOUSE_EVAL_ACCESS_CLIENT_SECRET: 's' }
  const target = (seen: (AbortSignal | null | undefined)[], hang = false) => createProductTarget({
    paid: true, budgetUsd: 1, env, signIn: async () => ({}),
    fetch: (async (_u: unknown, init?: RequestInit) => {
      seen.push(init?.signal)
      const signal = init!.signal!
      if (hang) await new Promise((_, reject) => (signal.aborted ? reject(signal.reason) : signal.addEventListener('abort', () => reject(signal.reason))))
      return new Response('{}')
    }) as typeof fetch,
  })

  test('setup refuses before any call when ps can\'t list the processes (#740)', async () => {
    const seen: unknown[] = []
    const t = createProductTarget({ paid: true, budgetUsd: 1, env, signIn: async () => ({}), ps: path.join(tmpdir(), 'no-such-ps'), fetch: (async (u: unknown) => { seen.push(u); return new Response('{}') }) as typeof fetch })
    await expect(t.ready()).rejects.toThrow(/the process tree could not be listed .*the run stops/)
    expect(seen).toEqual([])
  })

  test('a call with no signal of its own still gets one; a caller\'s cancel still ends it', async () => {
    const seen: (AbortSignal | null | undefined)[] = []
    await target(seen).call('lena', 'GET', '/api/me')
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(seen[0]!.aborted).toBe(false)
    const cancel = new AbortController()
    const hung = target(seen, true).call('lena', 'GET', '/api/me', { signal: cancel.signal })
    cancel.abort(new Error('cancelled'))
    await expect(hung).rejects.toThrow('cancelled')
  })

  test('a hung call with no signal of its own ends at the deadline, not a moment before (#685)', async () => {
    vi.useFakeTimers()
    try {
      const seen: (AbortSignal | null | undefined)[] = []
      let settled = false
      const hung = target(seen, true).call('lena', 'GET', '/api/me')
      hung.then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(hung).rejects.toThrow(`the call did not end within ${API_TIMEOUT_MS / 1000} s`)
      expect(API_TIMEOUT_MS).toBe(60_000)
    } finally {
      vi.useRealTimers()
    }
  })
})
