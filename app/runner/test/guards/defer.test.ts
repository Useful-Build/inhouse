// The defer hook's seam (Stage 1, N16; M2-Q fills the body). Ways it could fail, written first:
// - the hook defers anything yet, matches a tool other than question_ask, or doesn't block on failure;
// - `loneToolCall` says a call is alone when the turn holds another call too, before the call was seen, or before the
//   model's message that carried it is complete (its sibling blocks arrive as separate messages, after the hook runs);
// - it waits past its deadline, or misses a call that arrives while it waits, or a later turn's call;
// - a helper's call (a message with a parent tool use) counts toward the main agent's turn.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFERRED_TOOL, DEFER_SEEN_WITHIN_MS, deferHook } from '../../src/guards/defer.ts'
import { TurnToolUses } from '../../src/session/core.ts'

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
  // The SDK sends a turn's calls one block per assistant message (sharing the API message id, no stop reason), and the
  // CLI runs a call's hook as soon as its block is streamed, before the blocks after it (CLI 2.1.328). Only the
  // message's `message_stop` stream event says no more calls are coming.
  const block = (id: string, message: string, parent: string | null = null) =>
    ({ type: 'assistant', parent_tool_use_id: parent, message: { id: message, stop_reason: null, content: [{ type: 'tool_use', id, name: 'x', input: {} }] } }) as unknown as SDKMessage
  const stream = (event: Record<string, unknown>) => ({ type: 'stream_event', parent_tool_use_id: null, event }) as unknown as SDKMessage
  const start = (message: string) => stream({ type: 'message_start', message: { id: message } })
  const stop = stream({ type: 'message_stop' })

  it('true only once the message that carried the call is complete and it is the only call', async () => {
    const t = new TurnToolUses()
    t.see(start('m1'))
    t.see(block('a', 'm1'))
    let settled: boolean | undefined
    const waiting = t.lone('a', 2_000).then((v) => (settled = v))
    await Promise.resolve()
    // One call so far, the message still streaming: not yet.
    expect(settled).toBeUndefined()
    t.see(stop)
    expect(await waiting).toBe(true)
    // Asked again after the stop: at once.
    await expect(t.lone('a', 100)).resolves.toBe(true)
  })

  it('a multi-call turn whose first block arrives alone is never lone: false when the sibling block arrives', async () => {
    const t = new TurnToolUses()
    t.see(start('m1'))
    t.see(block('q', 'm1'))
    const waiting = t.lone('q', 2_000)
    t.see(block('r', 'm1'))
    t.see(stop)
    await expect(waiting).resolves.toBe(false)
  })

  it('without stream events (M1-E: includePartialMessages off) it never resolves true: false at the deadline, not before', async () => {
    vi.useFakeTimers()
    const t = new TurnToolUses()
    t.see(block('a', 'm1'))
    let settled: boolean | undefined
    const waiting = t.lone('a', 100).then((v) => (settled = v))
    await vi.advanceTimersByTimeAsync(99)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await waiting
    expect(settled).toBe(false)
  })

  it('a call never seen is false at the deadline; a helper\'s messages and stream events never count', async () => {
    vi.useFakeTimers()
    const t = new TurnToolUses()
    const never = t.lone('z', 100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(never).resolves.toBe(false)
    t.see(stream({ type: 'message_start', message: { id: 'h1' } }))
    t.see(block('h', 'h1', 'toolu_parent'))
    t.see(start('m2'))
    t.see(block('b', 'm2'))
    t.see({ type: 'stream_event', parent_tool_use_id: 'toolu_parent', event: { type: 'message_stop' } } as unknown as SDKMessage)
    const pending = t.lone('b', 100)
    await vi.advanceTimersByTimeAsync(100)
    // The helper's message_stop didn't close the main agent's message.
    await expect(pending).resolves.toBe(false)
    expect(t.count).toBe(1)
  })

  it('a new turn starts clean after the tool results', async () => {
    const t = new TurnToolUses()
    t.see(start('m1'))
    t.see(block('a', 'm1'))
    t.see(block('b', 'm1'))
    t.see(stop)
    t.see(results(['a', 'b']))
    t.see(start('m2'))
    t.see(block('c', 'm2'))
    t.see(stop)
    await expect(t.lone('c', 100)).resolves.toBe(true)
  })
})
