// The Memory pages' HTTP calls over a fake `fetch`. Ways they could break, written down first: a forget sent to the
// wrong route (a team line to the personal route, or the reverse), without `ifRev`, or with a body the server refuses;
// a conflict that loses the line as it is now; an answer that isn't a memory page reaching the caller; a line found
// under the wrong scope. Wire paths and bodies are literals.
import { describe, expect, test } from 'vitest'
import { AgentError } from '../types'
import { findMemoryLine, forgetMemoryLine, readMemory } from './memory'
import { Transport } from './transport'

const iso = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const teamLine = { key: 'mem_AAAAAAAAAAAAAAAAAAAAAA', text: 'We restock on Fridays', source: 'Sam told your Inhouse agent in a chat', at: iso(1), rev: 3, scope: 'brand' }
const ownLine = { key: 'mem_BBBBBBBBBBBBBBBBBBBBBB', text: 'Sort order tables by date', source: 'Sam told your Inhouse agent in a chat', at: iso(2), rev: 1, scope: 'person' }
const PAGE = { team: [{ group: 'Shared with the team', lines: [teamLine] }], personal: [ownLine] }

function fake(answer: (method: string, path: string, body: unknown) => { status: number; body: unknown }) {
  const sent: { method: string; path: string; body: unknown }[] = []
  const http = new Transport({
    origin: 'http://brand.test',
    fetch: async (input, init) => {
      const url = new URL(String(input))
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      sent.push({ method: init?.method ?? 'GET', path: url.pathname, body })
      const a = answer(init?.method ?? 'GET', url.pathname, body)
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
    },
  })
  return { http, sent }
}

describe('readMemory (route 43)', () => {
  test('reads the page and parses it', async () => {
    const { http, sent } = fake(() => ({ status: 200, body: PAGE }))
    expect(await readMemory(http)).toEqual(PAGE)
    expect(sent).toEqual([{ method: 'GET', path: '/api/memory', body: undefined }])
  })
  test('an answer that is not a memory page is refused', async () => {
    const { http } = fake(() => ({ status: 200, body: { team: 'nope' } }))
    await expect(readMemory(http)).rejects.toMatchObject({ code: 'unknown' })
  })
})

describe('forgetMemoryLine (routes 44 and 45)', () => {
  test('a team line goes to the brand route, a person line to the personal one, each with ifRev', async () => {
    const { http, sent } = fake((_m, path) => ({ status: 200, body: path.includes('/brand/') ? { ...teamLine, rev: 4, forgotten: true } : { ...ownLine, rev: 2, forgotten: true } }))
    const k = await http.contract()
    expect(await forgetMemoryLine(http, k, teamLine, 'brand', true)).toEqual({ ...teamLine, rev: 4, forgotten: true })
    expect(await forgetMemoryLine(http, k, ownLine, 'person', false)).toEqual({ ...ownLine, rev: 2, forgotten: true })
    expect(sent).toEqual([
      { method: 'PUT', path: '/api/memory/brand/mem_AAAAAAAAAAAAAAAAAAAAAA/forgotten', body: { forgotten: true, ifRev: 3 } },
      { method: 'PUT', path: '/api/memory/personal/mem_BBBBBBBBBBBBBBBBBBBBBB/forgotten', body: { forgotten: false, ifRev: 1 } },
    ])
  })
  test('a conflict rejects with the line as it is now', async () => {
    const current = { ...ownLine, rev: 5, forgotten: true }
    const { http } = fake(() => ({ status: 409, body: { error: { code: 'conflict', current } } }))
    const err = await forgetMemoryLine(http, await http.contract(), ownLine, 'person', true).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect(err).toMatchObject({ code: 'conflict', current })
  })
})

describe('findMemoryLine', () => {
  test('finds a line with its scope, or null', () => {
    expect(findMemoryLine(PAGE as never, teamLine.key)).toEqual({ line: teamLine, scope: 'brand' })
    expect(findMemoryLine(PAGE as never, ownLine.key)).toEqual({ line: ownLine, scope: 'person' })
    expect(findMemoryLine(PAGE as never, 'mem_CCCCCCCCCCCCCCCCCCCCCC')).toBeNull()
  })
})
