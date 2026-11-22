// The Watch switches in a turn's RunStart (P8a S). Ways it can fail: a turn stored before P8a (WebFetch hosts null, no
// web search column) starts with WebFetch open to any public host or web search on; a listed host is dropped; web search
// is on without an explicit true; the start no longer parses as protocol v2.
import { fc, it as prop } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { RunStart } from '../../../shared/protocol/index.ts'
import { buildStart, type StartInput } from './run-start.ts'

const input = (over: Partial<StartInput>): StartInput => ({
  turnId: 't_turn1', chatId: 'chat-a', sessionId: '00000000-0000-4000-8000-00000000000a', expect: null, text: 'hi', quote: null,
  attachments: [], model: 'claude-sonnet-5-5', sideModel: 'claude-haiku-5-5', effort: 'medium', maxTurns: 25,
  webFetchDomains: [], systemPrompt: 'p', ...over,
})
const parses = (s: ReturnType<typeof buildStart>) => RunStart.parse({ ...s, runToken: 'x'.repeat(32) })

describe('buildStart: the switches', () => {
  it('null hosts (a turn stored before P8a) start with no host, never null', () => {
    expect(buildStart(input({ webFetchDomains: null })).webFetchDomains).toEqual([])
    expect(parses(buildStart(input({ webFetchDomains: null }))).webFetchDomains).toEqual([])
  })
  it('web search is on only when true; absent (a turn stored before P8a) is off', () => {
    expect(buildStart(input({})).webSearch).toBe(false)
    expect(buildStart(input({ webSearch: false })).webSearch).toBe(false)
    expect(parses(buildStart(input({ webSearch: true }))).webSearch).toBe(true)
  })
  const LABEL = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$/)
  const HOST = fc.tuple(LABEL, fc.constantFrom('com', 'org', 'test')).map(([a, b]) => `${a}.${b}`)
  prop.prop([fc.uniqueArray(HOST, { maxLength: 8 }), fc.option(fc.boolean(), { nil: undefined })])('a listed set of hosts is sent exactly, and the start parses', (hosts, webSearch) => {
    const s = parses(buildStart(input({ webFetchDomains: hosts, webSearch })))
    expect(s.webFetchDomains).toEqual(hosts)
    expect(s.webSearch).toBe(webSearch === true)
  })
})
