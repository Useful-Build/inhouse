// The blocking audit hook. Ways it could fail, written first:
// - it resolves on a nack, a rejected send, a closed channel or no answer at all (the call would run unrecorded);
// - it resolves on an answer that isn't a well-formed ack (`{ok: 'yes'}`, `true`, `undefined`);
// - it isn't blocking (`onFailure` not 'block') or doesn't match every tool;
// - the engine's own hook timeout fires before ours, or ours never fires;
// - the entry is missing the tool, its input or its id, or a huge input goes over the event cap;
// - the placeholder transport says yes.
import { fc, it } from '@fast-check/vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, vi } from 'vitest'
import {
  AUDIT_HOOK_TIMEOUT_S,
  AUDIT_INPUT_MAX_BYTES,
  AUDIT_TIMEOUT_MS,
  AuditRefusedError,
  auditHook,
  auditTransportMissing,
  recordToolCall,
  type AuditAnswer,
  type AuditChannel,
  type AuditEntry,
} from '../../src/guards/audit.ts'

const entry: AuditEntry = { toolUseId: 't1', tool: 'Bash', input: { command: 'ls' }, truncated: false }
const answering = (a: unknown): AuditChannel => ({ send: async () => a as AuditAnswer })
const signal = () => ({ signal: new AbortController().signal })
const pre = (tool: string, input: unknown): HookInput =>
  ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'u1', session_id: 's', transcript_path: '', cwd: '/work/a' }) as unknown as HookInput

afterEach(() => vi.useRealTimers())

describe('recordToolCall', () => {
  it('resolves on an ack', async () => {
    await expect(recordToolCall(answering({ ok: true }), entry)).resolves.toBeUndefined()
  })

  it.prop([fc.anything()])('throws on any answer that is not exactly an ack', async (a) => {
    fc.pre(!(a !== null && typeof a === 'object' && (a as { ok?: unknown }).ok === true))
    await expect(recordToolCall(answering(a), entry)).rejects.toThrow(AuditRefusedError)
  })

  it('throws on a nack, a closed channel and a send that rejects', async () => {
    await expect(recordToolCall(answering({ ok: false, reason: 'nack' }), entry)).rejects.toThrow(/nack/)
    await expect(recordToolCall(answering({ ok: false, reason: 'closed' }), entry)).rejects.toThrow(/closed/)
    await expect(recordToolCall({ send: () => Promise.reject(new Error('EPIPE')) }, entry)).rejects.toThrow(/closed/)
    await expect(recordToolCall({ send: () => { throw new Error('sync') } }, entry)).rejects.toThrow(AuditRefusedError)
  })

  it('throws when the root never answers, at the timeout and not before', async () => {
    vi.useFakeTimers()
    const p = recordToolCall({ send: () => new Promise<AuditAnswer>(() => {}) }, entry)
    let settled = false
    p.catch(() => {}).finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(AUDIT_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).rejects.toThrow(/timeout/)
  })

  it('the placeholder transport refuses', async () => {
    await expect(recordToolCall(auditTransportMissing, entry)).rejects.toThrow(AuditRefusedError)
  })
})

describe('auditHook', () => {
  it('matches every tool, blocks on failure, and its engine timeout is above ours', () => {
    const m = auditHook(answering({ ok: true }))
    expect(m.matcher).toBeUndefined()
    expect(m.onFailure).toBe('block')
    expect(AUDIT_HOOK_TIMEOUT_S * 1000).toBeGreaterThan(AUDIT_TIMEOUT_MS)
    expect(m.timeout).toBe(AUDIT_HOOK_TIMEOUT_S)
  })

  it.prop([fc.string({ minLength: 1 }), fc.jsonValue()])('sends the tool, its input and its id, and waits for the ack', async (tool, input) => {
    const sent: AuditEntry[] = []
    const m = auditHook({ send: async (e) => (sent.push(e), { ok: true }) })
    await expect(m.hooks[0]!(pre(tool, input), 'u1', signal())).resolves.toEqual({})
    expect(sent).toHaveLength(1)
    expect(sent[0]!.tool).toBe(tool)
    expect(sent[0]!.toolUseId).toBe('u1')
    if (!sent[0]!.truncated) expect(sent[0]!.input).toEqual(input)
  })

  it('throws (so the call is blocked) when the root refuses', async () => {
    const m = auditHook(answering({ ok: false, reason: 'nack' }))
    await expect(m.hooks[0]!(pre('Write', { file_path: '/work/a/x' }), 'u1', signal())).rejects.toThrow(AuditRefusedError)
  })

  it('records a huge input as its size', async () => {
    const sent: AuditEntry[] = []
    const m = auditHook({ send: async (e) => (sent.push(e), { ok: true }) })
    await m.hooks[0]!(pre('Write', { content: 'x'.repeat(AUDIT_INPUT_MAX_BYTES + 1) }), 'u1', signal())
    expect(sent[0]!.truncated).toBe(true)
    expect(sent[0]!.input).toEqual({ bytes: expect.any(Number) })
  })
})
