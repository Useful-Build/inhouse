// The defer hook's seam (Stage 1, N16; M2-Q fills the body). Ways it could fail, written first:
// - the hook defers anything yet, matches a tool other than question_ask, or doesn't block on failure;
// - `loneToolCall` says a call is alone when the turn holds another call too, or before the call was seen;
// - it waits past its deadline, or misses a call that arrives while it waits, or a later turn's call;
// - a helper's call (a message with a parent tool use) counts toward the main agent's turn.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFERRED_TOOL, DEFER_SEEN_WITHIN_MS, deferHook } from '../../src/guards/defer.ts'
import { TurnToolUses } from '../../src/session/core.ts'

const assistant = (ids: string[], parent: string | null = null) =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { content: ids.map((id) => ({ type: 'tool_use', id, name: 'x', input: {} })) } }) as unknown as SDKMessage
const results = (ids: string[]) =>
  ({ type: 'user', parent_tool_use_id: null, message: { content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) } }) as unknown as SDKMessage

afterEach(() => vi.useRealTimers())

describe('the defer hook (no-op until M2-Q)', () => {
  it('matches only question_ask, blocks on failure, and never defers', async () => {
    const m = deferHook({ audit: async () => {}, loneToolCall: async () => true })
    expect(m.matcher).toBe('mcp__inhouse__question_ask')
    expect(DEFERRED_TOOL).toBe('mcp__inhouse__question_ask')
    expect(DEFER_SEEN_WITHIN_MS).toBe(2_000)
    expect(m.onFailure).toBe('block')
    const input = { hook_event_name: 'PreToolUse', tool_name: DEFERRED_TOOL, tool_input: {}, tool_use_id: 'u1', session_id: 's', transcript_path: '', cwd: '/work/a' }
    expect(await m.hooks[0]!(input as never, 'u1', { signal: new AbortController().signal })).toEqual({})
    await expect(m.hooks[0]!({ hook_event_name: 'PostToolUse' } as never, 'u1', { signal: new AbortController().signal })).rejects.toThrow(/defer hook got/)
  })
})

describe('the turn tracker behind loneToolCall', () => {
  it('true for the turn\'s only call, false beside another, and false for a call never seen (at the deadline, not before)', async () => {
    vi.useFakeTimers()
    const t = new TurnToolUses()
    t.see(assistant(['a']))
    await expect(t.lone('a', 100)).resolves.toBe(true)
    t.see(results(['a']))
    t.see(assistant(['b', 'c']))
    await expect(t.lone('b', 100)).resolves.toBe(false)
    let settled: boolean | undefined
    const never = t.lone('z', 100).then((v) => (settled = v))
    await vi.advanceTimersByTimeAsync(99)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await never
    expect(settled).toBe(false)
  })

  it('a call that arrives while it waits is seen at once; a helper\'s message never counts', async () => {
    vi.useFakeTimers()
    const t = new TurnToolUses()
    const waiting = t.lone('q', 2_000)
    t.see(assistant(['h1'], 'toolu_parent'))
    t.see(assistant(['q']))
    await expect(waiting).resolves.toBe(true)
    const pair = t.lone('r', 2_000)
    t.see(results(['q']))
    t.see(assistant(['r', 's']))
    await expect(pair).resolves.toBe(false)
  })
})
