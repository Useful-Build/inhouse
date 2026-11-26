// The defer hook (Stage 1, N16). Ways it could fail, written first:
// - the hook defers a call the run doesn't say is alone, a helper's call or another tool, or doesn't block on failure;
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

describe('the defer hook', () => {
  const input = (o: Record<string, unknown> = {}) =>
    ({ hook_event_name: 'PreToolUse', tool_name: DEFERRED_TOOL, tool_input: {}, tool_use_id: 'u1', session_id: 's', transcript_path: '', cwd: '/work/a', ...o }) as never
  const opts = { signal: new AbortController().signal }
  /** A run whose `loneToolCall` answers `lone`, recording what it was asked. */
  const run = (lone: boolean) => {
    const asked: [string, number][] = []
    return { asked, ctx: { audit: async () => {}, loneToolCall: async (id: string, within: number) => (asked.push([id, within]), lone) } }
  }

  it('matches only question_ask, blocks on failure, and refuses another hook event', async () => {
    const m = deferHook(run(true).ctx)
    expect(m.matcher).toBe('mcp__inhouse__question_ask')
    expect(DEFERRED_TOOL).toBe('mcp__inhouse__question_ask')
    expect(DEFER_SEEN_WITHIN_MS).toBe(2_000)
    expect(m.onFailure).toBe('block')
    await expect(m.hooks[0]!({ hook_event_name: 'PostToolUse' } as never, 'u1', opts)).rejects.toThrow(/defer hook got/)
  })

  it('defers exactly when the run says the call is alone, asking about this call within 2 s', async () => {
    const yes = run(true)
    expect(await deferHook(yes.ctx).hooks[0]!(input(), 'u1', opts)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } })
    expect(yes.asked).toEqual([['u1', 2_000]])
    const no = run(false)
    expect(await deferHook(no.ctx).hooks[0]!(input(), 'u1', opts)).toEqual({})
  })

  it("never defers a helper's call, another tool, or a call with no id, and doesn't ask the run about them", async () => {
    const r = run(true)
    const hook = deferHook(r.ctx).hooks[0]!
    expect(await hook(input({ agent_id: 'agent-1' }), 'u1', opts)).toEqual({})
    expect(await hook(input({ tool_name: 'mcp__inhouse__memory_save' }), 'u1', opts)).toEqual({})
    expect(await hook(input({ tool_use_id: undefined }), undefined, opts)).toEqual({})
    expect(r.asked).toEqual([])
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

  it('without a message_stop stream event it never resolves true: false at the deadline, not before', async () => {
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
