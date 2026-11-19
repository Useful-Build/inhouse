// The local channel between the root runner and a session process (runner-internal; not the Worker wire protocol).
// The session process's own stdio carries NDJSON (its stdout to the root, its stdin from the root; src/protocol/ndjson.ts
// frames them); both ends parse every message through these schemas. A line that is unreadable, oversized or fails to parse ends that session
// with a `failed` event (reason `protocol`); it never crashes the root.
import { z } from 'zod'
import { RunEventBody, RunStartFields, checkRunStart } from '../../../shared/protocol/index.ts'

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
  /** The SIGTERM path: `interrupt()`, flush, then end the run with a `failed` event (reason `stopped`). */
  z.strictObject({ type: z.literal('stop') }),
])
export type RootMessage = z.infer<typeof RootMessage>

/** The event bodies a session may send. `started` is the root's own. */
export const SessionEventBody = RunEventBody.refine((e) => e.type !== 'started', { message: 'a session never sends started' })

/** Session -> root. */
export const SessionMessage = z.discriminatedUnion('type', [
  /** The session listens on the channel; the root sends `run` only after this. */
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({ type: z.literal('event'), event: z.unknown() }),
])
export type SessionMessage = z.infer<typeof SessionMessage>

export type ParsedSessionMessage = { type: 'ready' } | { type: 'event'; event: Exclude<RunEventBody, { type: 'started' }> }

/** Parses a message from a session, event body included. Returns the zod error's text on failure, never throws. */
export function parseSessionMessage(raw: unknown): { ok: true; message: ParsedSessionMessage } | { ok: false; error: string } {
  const outer = SessionMessage.safeParse(raw)
  if (!outer.success) return { ok: false, error: z.prettifyError(outer.error) }
  if (outer.data.type === 'ready') return { ok: true, message: { type: 'ready' } }
  const body = SessionEventBody.safeParse(outer.data.event)
  if (!body.success) return { ok: false, error: z.prettifyError(body.error) }
  return { ok: true, message: { type: 'event', event: body.data as Exclude<RunEventBody, { type: 'started' }> } }
}

/**
 * Caps an SDK message for an `sdk` event. A message over `maxBytes` (as JSON) becomes a stub with its `type`, `subtype`
 * and size. The root applies this to every `sdk` event, whatever the session sent.
 */
export function capSdkMessage(message: Record<string, unknown>, maxBytes: number): { message: Record<string, unknown>; truncated: boolean } {
  const bytes = Buffer.byteLength(JSON.stringify(message))
  if (bytes <= maxBytes) return { message, truncated: false }
  const stub: Record<string, unknown> = { bytes }
  if (typeof message.type === 'string') stub.type = message.type.slice(0, 64)
  if (typeof message.subtype === 'string') stub.subtype = message.subtype.slice(0, 64)
  return { message: stub, truncated: true }
}
