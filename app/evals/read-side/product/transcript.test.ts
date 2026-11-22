// How route 33's calls join the transcript's tool_use blocks: the ways the join must refuse (a null fails the case closed) and the
// inputs it must take from the transcript when route 33 cut them or kept none.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ToolCall } from '../../types.ts'
import { exposedIn, joinCalls, toolUsesOf, type ToolUse } from './transcript.ts'

const part = (entries: unknown[]) => new TextEncoder().encode(JSON.stringify(entries))
const assistant = (...blocks: unknown[]) => ({ type: 'assistant', uuid: 'u', message: { content: blocks } })
const use = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `t_${name}`, name, input })

describe('toolUsesOf', () => {
  it('reads every tool_use across parts, and refuses a part that is not an array of entries', () => {
    const uses = toolUsesOf([part([{ type: 'user', message: { content: 'hi' } }, assistant({ type: 'text', text: 'x' }, use('WebFetch', { url: 'https://a.test/' }))]), part([assistant(use('Bash', { command: 'ls' }))])])
    expect(uses).toEqual([{ name: 'WebFetch', input: { url: 'https://a.test/' } }, { name: 'Bash', input: { command: 'ls' } }])
    expect(toolUsesOf([new TextEncoder().encode('{"type":"assistant"}')])).toBeNull()
    expect(toolUsesOf([new TextEncoder().encode('not json')])).toBeNull()
    expect(toolUsesOf([part([{ message: {} }])])).toBeNull()
    expect(toolUsesOf([part([assistant({ type: 'tool_use', name: 'Bash', input: 'ls' })])])).toBeNull()
  })
  it('exposedIn finds the canary in any part', () => {
    expect(exposedIn([part([{ type: 'user' }]), part([{ type: 'user', message: { content: 'kestrel-abc' } }])], 'kestrel-abc')).toBe(true)
    expect(exposedIn([part([{ type: 'user' }])], 'kestrel-abc')).toBe(false)
  })
})

describe('joinCalls', () => {
  const fetchCall = (input: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall => ({ name: 'WebFetch', input, ...extra })
  it('takes a cut or missing input from the transcript and lists every WebFetch the model asked for, denied ones too', () => {
    const j = joinCalls([fetchCall({}, { inputCut: true }), { name: 'mcp__inhouse__memory_search', input: {} }, { name: 'Bash', input: {} }, fetchCall({}, { hookDenied: true })],
      [{ name: 'WebFetch', input: { url: 'https://a.test/x' } }, { name: 'mcp__inhouse__memory_search', input: { query: 'q' } }, { name: 'Bash', input: { command: 'curl https://b.test' } }, { name: 'WebFetch', input: { url: 'https://c.test/' } }])
    expect(j.calls).toEqual([fetchCall({ url: 'https://a.test/x' }), { name: 'mcp__inhouse__memory_search', input: {} }, { name: 'Bash', input: { command: 'curl https://b.test' } }, fetchCall({ url: 'https://c.test/' }, { hookDenied: true })])
    expect(j.webFetchUrls).toEqual(['https://a.test/x', 'https://c.test/'])
  })
  it('refuses a disagreement on a kept input, a count that differs either way, and an unreadable transcript', () => {
    expect(joinCalls([fetchCall({ url: 'https://a.test/' })], [{ name: 'WebFetch', input: { url: 'https://other.test/' } }]).calls).toBeNull()
    expect(joinCalls([fetchCall({})], []).webFetchUrls).toBeNull()
    expect(joinCalls([], [{ name: 'WebFetch', input: { url: 'https://a.test/' } }]).calls).toBeNull()
    expect(joinCalls([{ name: 'Bash', input: { command: 'ls' } }], [{ name: 'Bash', input: { command: 'rm x' } }]).calls).toBeNull()
    expect(joinCalls([fetchCall({})], null).calls).toBeNull()
    expect(joinCalls([fetchCall({})], [{ name: 'WebFetch', input: {} }]).webFetchUrls).toBeNull()
  })
  it('joins any interleaving whose per-tool order agrees, and refuses it once one input tool use is dropped (property)', () => {
    const tool = fc.constantFrom('WebFetch', 'Bash', 'mcp__inhouse__memory_save', 'Read')
    fc.assert(fc.property(fc.array(fc.tuple(tool, fc.webUrl(), fc.boolean()), { minLength: 1, maxLength: 8 }), fc.nat(), (spec, pick) => {
      const uses: ToolUse[] = spec.map(([name, url]) => ({ name, input: name === 'Bash' ? { command: `curl ${url}` } : { url } }))
      const calls: ToolCall[] = spec.map(([name, url, cut]) => ({ name, input: cut ? {} : name === 'Bash' ? { command: `curl ${url}` } : { url }, ...(cut ? { inputCut: true } : {}) }))
      const j = joinCalls(calls, uses)
      // The oracle: input tools carry the transcript's input with no cut mark; other calls are route 33's as they were.
      expect(j.calls).toEqual(spec.map(([name], i) => (name === 'WebFetch' || name === 'Bash' ? { name, input: uses[i]!.input } : calls[i]!)))
      expect(j.webFetchUrls).toEqual(spec.filter(([n]) => n === 'WebFetch').map(([, u]) => u))
      const inputIdx = spec.map(([n], i) => (n === 'WebFetch' || n === 'Bash' ? i : -1)).filter((i) => i >= 0)
      if (inputIdx.length > 0) {
        const drop = inputIdx[pick % inputIdx.length]!
        expect(joinCalls(calls, uses.filter((_, i) => i !== drop)).calls).toBeNull()
      }
    }))
  })
})
