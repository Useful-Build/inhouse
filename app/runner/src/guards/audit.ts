// The blocking audit hook: every tool call is recorded before it runs, or it doesn't run.
//
// The transport is R1's (src/session/core.ts): `RunContext.audit(entry)` sends the entry to the root over the local
// channel, the root writes it as an `audit` run event on the Worker's open stream and acks. It resolves only on that
// ack; a nack (a gone Worker, an ended run, an expired entry), a closed channel or R1's own timeout rejects it. The hook
// lets the call go only once it resolved: any rejection, or no answer within our backstop timeout, throws, and
// `onFailure: 'block'` turns the throw into a blocked call.
import { createHash } from 'node:crypto'
import type { HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk'
import { AUDIT_INPUT_MAX_BYTES, auditInputSha256, type AuditEntry } from '../../../shared/protocol/index.ts'
import { LOCAL_MAX_DEPTH, deeperThan } from '../protocol/ndjson.ts'
import type { RunContext } from '../session/seam.ts'

export class AuditRefusedError extends Error {}

/**
 * How much of the start and of the end of an over-cap input is kept, in characters of its JSON text. Each kept
 * character costs at most 3 bytes once the edges are encoded again (a non-ASCII one; an escaped `"` or `\` costs 2),
 * so both edges with the hash and the size stay well inside the shared `AUDIT_INPUT_MAX_BYTES` (16 KB).
 */
export const AUDIT_EDGE_CHARS = 2 * 1024
/**
 * The deepest input sent as is. The root refuses a local line nested past `LOCAL_MAX_DEPTH` (which would end the run),
 * and the audit message's envelope (`{type:'audit', entry:{input}}`) adds two levels; two more are spare. A deeper input
 * goes in the over-cap form, whose edges are flat strings.
 */
export const AUDIT_INPUT_MAX_DEPTH = LOCAL_MAX_DEPTH - 5
/** What `{ "cut": false, "value": ... }` adds around an input. */
const WRAP_BYTES = Buffer.byteLength('{"cut":false,"value":}')
/**
 * Our backstop for an answer that never comes. Above R1's own audit timeout (10 s, src/session/core.ts), so R1's
 * timeout and the entry's `expiresAt` are what normally end a wait; this one only fires if the transport never settles.
 */
export const AUDIT_TIMEOUT_MS = 12_000
/** The engine's own hook timeout, in seconds, above ours so our timeout is the one that fires. */
export const AUDIT_HOOK_TIMEOUT_S = 15
/**
 * What the audit hook decided: it lets the call go once the entry is on the stream. The entry is written before the
 * call runs, so another guard (the permission rules, the WebFetch hook, the sandbox) may still refuse the call.
 */
export const AUDIT_DECISION = 'allow'

/**
 * The recorded input, always wrapped so a reader can't mistake an input shaped like the cut form for a cut record:
 * `{ cut: false, value }` within the shared cap (and the depth cap); otherwise `{ cut: true, bytes, sha256, head, tail }`
 * (its size, a hash of the whole and its start and end), or `{ cut: true, unencodable: true }` when JSON can't encode it.
 * A missing input (`undefined`, which JSON drops) is recorded as `{ cut: false, value: null }`, so the entry keeps its
 * `input` key on the wire.
 */
export function capInput(input: unknown): unknown {
  let text: string | undefined
  try {
    text = JSON.stringify(input)
  } catch {
    return { cut: true, unencodable: true }
  }
  if (text === undefined) return { cut: false, value: null }
  const bytes = Buffer.byteLength(text)
  if (bytes <= AUDIT_INPUT_MAX_BYTES - WRAP_BYTES && !deeperThan(input, AUDIT_INPUT_MAX_DEPTH)) return { cut: false, value: input }
  // Padding at either end can't hide a command: the start and end are kept, and the hash pins the whole input. What
  // sat in the middle is gone, so the record says it was cut and how big the whole was: a reader never takes the
  // start and end for the whole call.
  const sha256 = createHash('sha256').update(text).digest('hex')
  return { cut: true, bytes, sha256, head: text.slice(0, AUDIT_EDGE_CHARS), tail: text.slice(-AUDIT_EDGE_CHARS) }
}

/**
 * The entry for one PreToolUse call, in the shared shape the root checks. With `agentId` (the hook input's `agent_id`:
 * the helper that made the call, or null for the main agent) and `inputSha256` (N14), the hash of the hook's raw
 * `tool_input`, never of the wrapped or cut `input` beside it: the egress hashes the raw call when it admits a write.
 * A call with no input hashes as `{}`. The root drops both for a Worker below v4 (`auditEntryForPeer`).
 */
export async function auditEntry(input: HookInput & { hook_event_name: 'PreToolUse' }): Promise<AuditEntry> {
  return {
    hook: input.hook_event_name,
    toolName: input.tool_name,
    toolUseId: input.tool_use_id,
    decision: AUDIT_DECISION,
    input: capInput(input.tool_input),
    agentId: input.agent_id ?? null,
    inputSha256: await auditInputSha256(input.tool_input === undefined ? {} : input.tool_input),
  }
}

/**
 * The entry a guard records when it denies a call (the WebFetch hook, p3-eval-observability rev 2 rec 6): the same
 * entry with `decision: 'deny'`, so the trace can say which call a hook refused (by its tool_use id).
 */
export async function deniedEntry(input: HookInput & { hook_event_name: 'PreToolUse' }): Promise<AuditEntry> {
  return { ...(await auditEntry(input)), decision: 'deny' }
}

/** A rejection's reason as text. Never throws: a value that can't be turned into a string mustn't change the error. */
function describe(e: unknown): string {
  if (e instanceof Error) return e.message
  try {
    return String(e)
  } catch {
    return 'a refusal with no readable reason'
  }
}

/**
 * Records one call and resolves only once `run.audit` resolved (the root's ack). Throws on anything else: a rejection,
 * a `run.audit` that throws, or no answer after `timeoutMs`.
 */
export async function recordToolCall(run: RunContext, entry: AuditEntry, timeoutMs = AUDIT_TIMEOUT_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
  })
  try {
    await Promise.race([Promise.resolve().then(() => run.audit(entry)), timeout])
  } catch (e) {
    throw new AuditRefusedError(`audit not recorded (${describe(e)}); the tool call is blocked`)
  } finally {
    clearTimeout(timer)
  }
}

/** The PreToolUse matcher: every tool (no `matcher`), blocking on failure. */
export function auditHook(run: RunContext, timeoutMs = AUDIT_TIMEOUT_MS): HookCallbackMatcher {
  return {
    onFailure: 'block',
    timeout: AUDIT_HOOK_TIMEOUT_S,
    hooks: [
      async (input: HookInput) => {
        if (input.hook_event_name !== 'PreToolUse') throw new AuditRefusedError(`audit hook got ${input.hook_event_name}`)
        await recordToolCall(run, await auditEntry(input), timeoutMs)
        return {}
      },
    ],
  }
}
