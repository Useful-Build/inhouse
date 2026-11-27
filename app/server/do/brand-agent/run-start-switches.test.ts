// The Watch switches in a turn's RunStart (P8a S). Ways it can fail: a turn stored before P8a (WebFetch hosts SQL NULL, no
// web search column) starts with WebFetch open to any public host (`webFetchOf`, below) or web search on; open
// mode (M3-F: null hosts) doesn't reach the runner as null; a listed host is dropped; web search
// is on without an explicit true; the start no longer parses as protocol v2; a start with web search off carries the
// key, so a runner on an image from before P8a (a strict schema without it) refuses every run mid-rollout.
import { fc, it as prop } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { checkRunStart, RunStart, RunStartFields } from '../../../shared/protocol/index.ts'
import { buildStart, webFetchOf, type StartInput } from './run-start.ts'

const input = (over: Partial<StartInput>): StartInput => ({
  turnId: 't_turn1', chatId: 'chat-a', sessionId: '00000000-0000-4000-8000-00000000000a', expect: null, text: 'hi', quote: null,
  attachments: [], model: 'claude-sonnet-5-5', sideModel: 'claude-haiku-5-5', effort: 'medium', maxTurns: 25,
  webFetchDomains: [], systemPrompt: 'p', ...over,
})
const parses = (s: ReturnType<typeof buildStart>) => RunStart.parse({ ...s, runToken: 'x'.repeat(32) })
/** The runner's schema before P8a: the same strict object without `webSearch`. */
const OldRunStart = RunStartFields.omit({ webSearch: true }).superRefine(checkRunStart)

describe('buildStart: the switches', () => {
  it('null hosts (open mode, M3-F) start as null, any public host; a turn stored before P8a is read as no host before it gets here', () => {
    expect(buildStart(input({ webFetchDomains: null })).webFetchDomains).toBeNull()
    expect(parses(buildStart(input({ webFetchDomains: null }))).webFetchDomains).toBeNull()
    // The turn row's column: SQL NULL (stored before P8a S) is no host; the JSON text `null` (open mode) is any public host.
    expect(webFetchOf(null)).toEqual([])
    expect(webFetchOf('null')).toBeNull()
    expect(webFetchOf('[]')).toEqual([])
    expect(webFetchOf('["docs.example.com"]')).toEqual(['docs.example.com'])
  })
  it('web search is on only when true; off (or absent: a turn stored before P8a) sends no key at all', () => {
    for (const off of [{}, { webSearch: false }]) {
      const s = buildStart(input(off))
      expect('webSearch' in s).toBe(false)
      expect(OldRunStart.safeParse({ ...s, runToken: 'x'.repeat(32) }).success).toBe(true)
    }
    expect(parses(buildStart(input({ webSearch: true }))).webSearch).toBe(true)
  })
  const LABEL = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$/)
  const HOST = fc.tuple(LABEL, fc.constantFrom('com', 'org', 'test')).map(([a, b]) => `${a}.${b}`)
  prop.prop([fc.uniqueArray(HOST, { maxLength: 8 }), fc.option(fc.boolean(), { nil: undefined })])('a listed set of hosts is sent exactly, and the start parses', (hosts, webSearch) => {
    const s = parses(buildStart(input({ webFetchDomains: hosts, webSearch })))
    expect(s.webFetchDomains).toEqual(hosts)
    expect('webSearch' in s).toBe(webSearch === true)
    if (webSearch === true) expect(s.webSearch).toBe(true)
  })
})
