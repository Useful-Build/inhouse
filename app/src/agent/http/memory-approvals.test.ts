// Team memory approval's HTTP calls (P6a W2, routes 77 and 78) over a fake `fetch`. Ways they could break, written down
// first: the list read from the wrong route or taken unparsed; a decision sent to the wrong route, without `ifRev`, or
// with a body the server refuses; a conflict that loses the line as it is now; and `reviewLanded` calling a conflict
// "done" when it isn't (a concurrent change that left the fact waiting, a newer rev, the other decision) or "not done"
// when an earlier send of the same decision landed and its answer was lost. Wire paths and bodies are literals.
import { describe, expect, test } from 'vitest'
import { AgentError } from '../types'
import { readWaitingMemory, reviewLanded, reviewMemoryLine } from './memory'
import { Transport } from './transport'

const iso = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const waitingLine = { key: 'mem_AAAAAAAAAAAAAAAAAAAAAA', text: 'Kestrel wants PDFs', source: 'Sam told your Inhouse agent in a chat', at: iso(1), rev: 3, scope: 'brand' as const, waiting: true as const }
const LIST = { facts: [{ ...waitingLine, kind: 'memory' }] }

function fake(answer: (method: string, path: string, body: unknown) => { status: number; body: unknown }) {
  const sent: { method: string; path: string; body: unknown }[] = []
  const http = new Transport({
    origin: 'http://brand.test',
    fetch: async (input, init) => {
      const url = new URL(String(input))
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      sent.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, body })
      const a = answer(init?.method ?? 'GET', url.pathname, body)
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
    },
  })
  return { http, sent }
}

describe('readWaitingMemory (route 77)', () => {
  test('reads the list, with no query, and parses it', async () => {
    const { http, sent } = fake(() => ({ status: 200, body: LIST }))
    expect(await readWaitingMemory(http)).toEqual(LIST)
    expect(sent).toEqual([{ method: 'GET', path: '/api/memory/waiting', body: undefined }])
  })
  test('only a team line still waiting is kept: a person line or one not marked waiting is left out', async () => {
    const { waiting: _w, ...notWaiting } = waitingLine
    const body = { facts: [{ ...waitingLine, kind: 'memory' }, { ...waitingLine, key: 'mem_BBBBBBBBBBBBBBBBBBBBBB', scope: 'person', kind: 'memory' }, { ...notWaiting, key: 'mem_CCCCCCCCCCCCCCCCCCCCCC', kind: 'memory' }] }
    const { http } = fake(() => ({ status: 200, body }))
    expect((await readWaitingMemory(http)).facts.map(f => f.key)).toEqual([waitingLine.key])
  })
  test('an answer that is not the list is refused; a line without kind memory is refused', async () => {
    for (const body of [{ facts: 'nope' }, { facts: [waitingLine] }, { facts: [{ ...waitingLine, kind: 'action' }] }]) {
      const { http } = fake(() => ({ status: 200, body }))
      await expect(readWaitingMemory(http), JSON.stringify(body)).rejects.toMatchObject({ code: 'unknown' })
    }
  })
})

describe('reviewMemoryLine (route 78)', () => {
  test('approve and reject go to the /approved route with approved and the rev last read', async () => {
    const { http, sent } = fake((_m, _p, body) => {
      const b = body as { approved: boolean; ifRev: number }
      const { waiting: _w, ...rest } = waitingLine
      return { status: 200, body: { ...rest, rev: b.ifRev + 1, ...(b.approved ? {} : { forgotten: true }) } }
    })
    const k = await http.contract()
    const { waiting: _w, ...approved } = waitingLine
    expect(await reviewMemoryLine(http, k, waitingLine, true)).toEqual({ ...approved, rev: 4 })
    expect(await reviewMemoryLine(http, k, waitingLine, false)).toEqual({ ...approved, rev: 4, forgotten: true })
    expect(sent).toEqual([
      { method: 'PUT', path: '/api/memory/brand/mem_AAAAAAAAAAAAAAAAAAAAAA/approved', body: { approved: true, ifRev: 3 } },
      { method: 'PUT', path: '/api/memory/brand/mem_AAAAAAAAAAAAAAAAAAAAAA/approved', body: { approved: false, ifRev: 3 } },
    ])
  })
  test('a conflict rejects with an AgentError carrying the line as it is now', async () => {
    const current = { ...waitingLine, rev: 5 }
    const { http } = fake(() => ({ status: 409, body: { error: { code: 'conflict', current } } }))
    const err = await reviewMemoryLine(http, await http.contract(), waitingLine, true).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect(err).toMatchObject({ code: 'conflict', current })
  })
  test('a body the server would refuse never leaves (an ifRev of 0)', async () => {
    const { http, sent } = fake(() => ({ status: 200, body: {} }))
    const k = await http.contract()
    expect(() => reviewMemoryLine(http, k, { key: waitingLine.key, rev: 0 }, true)).toThrow()
    expect(sent).toEqual([])
  })
})

describe('reviewLanded: a conflict that is an earlier send of the same decision (the answer was lost)', () => {
  const { waiting: _w, ...base } = waitingLine
  const sentAt = 3
  test('approve: done only when the line is one rev on, neither forgotten nor waiting', () => {
    expect(reviewLanded({ ...base, rev: 4 }, sentAt, true)).toBe(true)
  })
  test('approve: a change at rev + 1 that left it waiting is a conflict, not done (A10)', () => {
    expect(reviewLanded({ ...base, rev: 4, waiting: true }, sentAt, true)).toBe(false)
  })
  test('approve: forgotten, a newer rev, or the same rev is a conflict', () => {
    expect(reviewLanded({ ...base, rev: 4, forgotten: true }, sentAt, true)).toBe(false)
    expect(reviewLanded({ ...base, rev: 5 }, sentAt, true)).toBe(false)
    expect(reviewLanded({ ...base, rev: 3 }, sentAt, true)).toBe(false)
  })
  test('reject: done when the line is one rev on and forgotten (a concurrent forget reads as done too)', () => {
    expect(reviewLanded({ ...base, rev: 4, forgotten: true }, sentAt, false)).toBe(true)
  })
  test('reject: active, waiting or a newer rev is a conflict', () => {
    expect(reviewLanded({ ...base, rev: 4 }, sentAt, false)).toBe(false)
    expect(reviewLanded({ ...base, rev: 4, waiting: true }, sentAt, false)).toBe(false)
    expect(reviewLanded({ ...base, rev: 5, forgotten: true }, sentAt, false)).toBe(false)
  })
})
