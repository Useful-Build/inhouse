// The local channel between the root runner and a session process (runner-internal; not the Worker wire protocol).
// Two sockets carry NDJSON, one per direction: session -> root on the session process's fd 3, root -> session on its fd 4
// (src/session/channel.ts; src/protocol/ndjson.ts frames them); both ends parse every message through these schemas. A line that is unreadable, oversized or fails to parse ends that session
// with a `failed` event (reason `protocol`); it never crashes the root.
import { z } from 'zod'
import { AuditEntry, RunEventBody, RunStartFields, checkRunStart } from '../../../shared/protocol/index.ts'

/**
 * What a session process gets for its run: the run start without the run token. Strict, so a `runToken` field is a
 * parse error on both ends, and the token can't ride along by accident.
 */
export const RunConfig = RunStartFields.omit({ runToken: true }).superRefine(checkRunStart)
export type RunConfig = z.infer<typeof RunConfig>

/** Root -> session. */
export const RootMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('run'), config: RunConfig }),
  z.strictObject({ type: z.literal('interrupt') }),
  /**
   * The SIGTERM path: `interrupt()`, flush, then end the run with a `failed` event (reason `stopped`). `endWithinMs`
   * is the session's deadline for its end phase (the checkpoint first, then files if time allows), counted from when
   * the stop arrives; it is below the root's grace period, after which the root kills the session.
   */
  z.strictObject({ type: z.literal('stop'), endWithinMs: z.int().positive() }),
  /** The audit entry `id` is on the Worker's stream. */
  z.strictObject({ type: z.literal('audit_ack'), id: z.int().nonnegative() }),
  /** It isn't, and won't be (the run has ended, or the Worker has gone): the hook must not let the call run. */
  z.strictObject({ type: z.literal('audit_nack'), id: z.int().nonnegative(), error: z.string().max(500) }),
])
export type RootMessage = z.infer<typeof RootMessage>

/**
 * The event bodies a session may send. `started`, `heartbeat` and `released` are the root's own; `audit` comes only as
 * an `audit` message (acked).
 */
const ROOT_ONLY = new Set(['started', 'audit', 'heartbeat', 'released'])
export const SessionEventBody = RunEventBody.refine((e) => !ROOT_ONLY.has(e.type), { message: 'a session never sends started, audit, heartbeat or released as an event' })

/** Session -> root. */
export const SessionMessage = z.discriminatedUnion('type', [
  /** The session listens on the channel; the root sends `run` only after this. */
  z.strictObject({ type: z.literal('ready') }),
  /** The session is about to call `query()`: from here the run may change the transcript (`released.queryRan`). */
  z.strictObject({ type: z.literal('query_started') }),
  z.strictObject({ type: z.literal('event'), event: z.unknown() }),
  /**
   * A blocking audit entry: the root writes it to the stream, then answers `audit_ack` or `audit_nack` with this id.
   * `expiresAt` (`monotonicMs()`, a clock both ends share) is when the session stops waiting, less a margin for the ack to
   * travel: an entry the root reads at or after it (it sat in the pipe while the root wasn't reading) is nacked and
   * never written, so the stream never says `allow` for a call that the hook refused on its timeout.
   */
  z.strictObject({ type: z.literal('audit'), id: z.int().nonnegative(), expiresAt: z.number().nonnegative(), entry: AuditEntry }),
])
export type SessionMessage = z.infer<typeof SessionMessage>

/**
 * Milliseconds on the host's monotonic clock: Node's `process.hrtime` (libuv's `uv_hrtime`) reads CLOCK_MONOTONIC on
 * Linux, one clock for every process on the host (clock_gettime(2)), and mach_absolute_time on macOS, likewise
 * system-wide. The root and its sessions share it, and unlike `Date.now()` it never steps (NTP, a clock set by hand), so
 * an audit entry's expiry means the same thing on both ends of the local channel.
 */
export const monotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n)

export type SessionEvent = Exclude<RunEventBody, { type: 'started' | 'audit' | 'heartbeat' | 'released' }>
export type ParsedSessionMessage = { type: 'ready' } | { type: 'query_started' } | { type: 'event'; event: SessionEvent } | { type: 'audit'; id: number; expiresAt: number; entry: AuditEntry }

/** Parses a message from a session, event body included. Returns the zod error's text on failure, never throws. */
export function parseSessionMessage(raw: unknown): { ok: true; message: ParsedSessionMessage } | { ok: false; error: string } {
  const outer = SessionMessage.safeParse(raw)
  if (!outer.success) return { ok: false, error: z.prettifyError(outer.error) }
  if (outer.data.type === 'ready') return { ok: true, message: { type: 'ready' } }
  if (outer.data.type === 'query_started') return { ok: true, message: { type: 'query_started' } }
  if (outer.data.type === 'audit') return { ok: true, message: { type: 'audit', id: outer.data.id, expiresAt: outer.data.expiresAt, entry: outer.data.entry } }
  const body = SessionEventBody.safeParse(outer.data.event)
  if (!body.success) return { ok: false, error: z.prettifyError(body.error) }
  return { ok: true, message: { type: 'event', event: body.data as SessionEvent } }
}

/**
 * Caps an SDK message for an `sdk` event. A message over `maxBytes` (as JSON) becomes a stub with its `type`, `subtype`
 * and size. The root applies this to every `sdk` event, whatever the session sent. Never throws: a message JSON can't
 * encode (a BigInt, a cycle, or nesting past the stack) gives null, and the caller ends the session.
 */
export function capSdkMessage(message: Record<string, unknown>, maxBytes: number): { message: Record<string, unknown>; truncated: boolean } | null {
  let text: string
  try {
    text = JSON.stringify(message)
  } catch {
    return null
  }
  const bytes = Buffer.byteLength(text)
  if (bytes <= maxBytes) return { message, truncated: false }
  const stub: Record<string, unknown> = { bytes }
  if (typeof message.type === 'string') stub.type = message.type.slice(0, 64)
  if (typeof message.subtype === 'string') stub.subtype = message.subtype.slice(0, 64)
  return { message: stub, truncated: true }
}
