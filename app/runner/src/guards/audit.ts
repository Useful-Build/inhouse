// The blocking audit hook: every tool call is recorded before it runs, or it doesn't run.
//
// The transport (decided): the session process sends the entry to the root over the local channel, the root writes it
// as an `audit` run event on the Worker's open stream and acks. The hook resolves only on that ack. A nack, a closed
// channel or stream, or no answer within the timeout throws, and `onFailure: 'block'` turns the throw into a blocked
// call. R1's second PR adds the messages; until then the production channel is `auditTransportMissing` (every call
// blocked), never a channel that says yes.
import { createHash } from 'node:crypto'
import type { HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk'

/** One tool call, as the root records it. `input` is the tool's input, capped (see `AUDIT_INPUT_MAX_BYTES`). */
export type AuditEntry = {
  toolUseId: string
  tool: string
  input: unknown
  /**
   * True when `input` was over the cap and is replaced by its size, hash, start and end (see `capInput`). The
   * replacement says so itself (`truncated: true`, `bytes`), so the flag stays with it wherever the entry is carried.
   */
  truncated: boolean
}

/** What the root answered. Anything but `ack` blocks the call. */
export type AuditAnswer = { ok: true } | { ok: false; reason: 'nack' | 'closed' | 'timeout'; message?: string }

/** The session's side of the audit transport. `send` may reject (a closed channel); that blocks the call too. */
export interface AuditChannel {
  send(entry: AuditEntry): Promise<AuditAnswer>
}

export class AuditRefusedError extends Error {}

/** Within the event cap with room to spare; a bigger input is recorded as its size, hash, start and end. */
export const AUDIT_INPUT_MAX_BYTES = 64 * 1024
/** How much of the start and of the end of an over-cap input is kept, in characters of its JSON text. */
export const AUDIT_EDGE_CHARS = 4 * 1024
/** How long the hook waits for the root's ack. */
export const AUDIT_TIMEOUT_MS = 5_000
/** The engine's own hook timeout, in seconds, above ours so our timeout is the one that fires. */
export const AUDIT_HOOK_TIMEOUT_S = 15

export function capInput(input: unknown): { input: unknown; truncated: boolean } {
  let text: string | undefined
  try {
    text = JSON.stringify(input)
  } catch {
    return { input: { unencodable: true }, truncated: true }
  }
  const bytes = text === undefined ? 0 : Buffer.byteLength(text)
  if (bytes <= AUDIT_INPUT_MAX_BYTES || text === undefined) return { input, truncated: false }
  // Padding at either end can't hide a command: the start and end are kept, and the hash pins the whole input. What
  // sat in the middle is gone, so the record says it was cut and how big the whole was: a reader never takes the
  // start and end for the whole call.
  const sha256 = createHash('sha256').update(text).digest('hex')
  return { input: { truncated: true, bytes, sha256, head: text.slice(0, AUDIT_EDGE_CHARS), tail: text.slice(-AUDIT_EDGE_CHARS) }, truncated: true }
}

/**
 * Records one call and resolves only on the root's ack. Throws on anything else, including a channel that never
 * answers (after `timeoutMs`).
 */
export async function recordToolCall(channel: AuditChannel, entry: AuditEntry, timeoutMs = AUDIT_TIMEOUT_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<AuditAnswer>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs)
  })
  let answer: AuditAnswer
  try {
    answer = await Promise.race([channel.send(entry), timeout])
  } catch (e) {
    answer = { ok: false, reason: 'closed', message: String(e instanceof Error ? e.message : e) }
  } finally {
    clearTimeout(timer)
  }
  // Only a well-formed ack counts: a channel that resolves with anything else is a failure, not a yes.
  if (answer === null || typeof answer !== 'object' || answer.ok !== true) {
    const reason = answer && typeof answer === 'object' && answer.ok === false ? answer.reason : 'nack'
    throw new AuditRefusedError(`audit not recorded (${reason}); the tool call is blocked`)
  }
}

/** The PreToolUse matcher: every tool (no `matcher`), blocking on failure. */
export function auditHook(channel: AuditChannel, timeoutMs = AUDIT_TIMEOUT_MS): HookCallbackMatcher {
  return {
    onFailure: 'block',
    timeout: AUDIT_HOOK_TIMEOUT_S,
    hooks: [
      async (input: HookInput) => {
        if (input.hook_event_name !== 'PreToolUse') throw new AuditRefusedError(`audit hook got ${input.hook_event_name}`)
        await recordToolCall(channel, { toolUseId: input.tool_use_id, tool: input.tool_name, ...capInput(input.tool_input) }, timeoutMs)
        return {}
      },
    ],
  }
}

/** Until R1's audit transport lands: every call is refused, so nothing runs unrecorded. */
export const auditTransportMissing: AuditChannel = {
  send: async () => ({ ok: false, reason: 'closed', message: 'the audit transport is not wired yet' }),
}
