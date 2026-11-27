// One hub call and what its answer means (N11), shared by a single action's send (dispatch.ts) and a batch item's
// (batch/send.ts). Only the dispatcher's modules import this; the binding itself is read in dispatch.ts alone.
import { z } from 'zod'
import type { WriteGateway, WriteRequest } from '../../hub/index/contract.ts'
import { ActionFailCodeSchema } from '../../shared/contract/audit.ts'
import type { NeedsCheckWhySchema } from '../../shared/contract/audit.ts'
import { plainAnswer } from '../../shared/rpc-answer.ts'
import { safeError } from '../safe-error.ts'
import { operationEntry } from './operations/index.ts'
import type { WriteOperationKey } from './operations/types.ts'

type NeedsCheckWhy = z.infer<typeof NeedsCheckWhySchema>

/**
 * The hub's answer, as the dispatcher trusts it: a safe ref, or a closed error code with what the hub knows was sent.
 * `retryAfterMs` (Stage 1 M3, N22): how long a throttled call (`rate_limited`, nothing ran) asks to wait.
 */
const ResultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.object({ ref: z.string().max(500) }) }),
  z.object({
    ok: z.literal(false), error: z.object({ code: ActionFailCodeSchema, retryAfterMs: z.number().int().min(0).max(86_400_000).optional() }),
    sent: z.enum(['no', 'unknown']),
  }),
])

export type SendOutcome =
  | { kind: 'not_claimed' }
  | { kind: 'sent'; ref: string }
  | { kind: 'failed'; code: string; retryAfterMs?: number }
  | { kind: 'needs_check'; why: NeedsCheckWhy }

/** A safe ref as the card shows it: no control characters, at most 200 characters. */
const safeRef = (ref: string) => ref.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 200)

export type HubAnswer = { value: unknown } | { thrown: true } | { timeout: true }

/** What the hub's answer (or its absence) means. Anything the dispatcher can't read as sure is a check for a person. */
export function outcomeOf(answer: HubAnswer): SendOutcome {
  if ('thrown' in answer) return { kind: 'needs_check', why: 'thrown' }
  if ('timeout' in answer) return { kind: 'needs_check', why: 'timeout' }
  const parsed = ResultSchema.safeParse(answer.value)
  if (!parsed.success) return { kind: 'needs_check', why: 'bad_result' }
  const r = parsed.data
  if (r.ok) return { kind: 'sent', ref: safeRef(r.value.ref) }
  if (r.sent !== 'no') return { kind: 'needs_check', why: 'unknown' }
  return { kind: 'failed', code: r.error.code, ...(r.error.retryAfterMs !== undefined ? { retryAfterMs: r.error.retryAfterMs } : {}) }
}

/**
 * The write's arguments as the hub's strict schema takes them. A Slack post names the listed channel's id the claim just
 * checked (N13), in the shape the hub's strict schema takes (hub/connectors/slack/outbox.ts `SlackChannelPostArgsSchema`:
 * `channelId`, `text` and, when the action has one, `title`: M2-N, a `notification_send` headline).
 */
export function requestArgs(operation: WriteOperationKey, scope: Record<string, string>, args: Record<string, unknown>): unknown {
  return operation === 'slack.channel.post'
    ? { channelId: scope.channelId, text: args.text, ...(typeof args.title === 'string' ? { title: args.title } : {}) }
    : args
}

/**
 * What the hub is asked to check: the account generation the write was approved on and, for every Shopify operation, the
 * store it was approved for (`expect.shop`, its scope; M2-G): the hub refuses when its write app points at another store.
 */
export function expectOf(operation: WriteOperationKey, accountGen: number, scope: Record<string, string>, id: string): WriteRequest['expect'] {
  const entry = operationEntry(operation)
  if (!entry) throw new Error(`outbox: a stored action names no operation (${id})`)
  if (entry.connector !== 'shopify') return { connectedAtMs: accountGen }
  if (typeof scope.shop !== 'string') throw new Error(`outbox: a Shopify action with no shop in its scope (${id})`)
  return { connectedAtMs: accountGen, shop: scope.shop }
}

/**
 * Starts the hub call synchronously (an async function runs up to its first await, so the call starts here; a
 * synchronous throw becomes its rejection) and races it against `timeoutMs`. `settled` is the call's own answer, for a
 * late result after a timeout.
 *
 * The binding's answer is copied out, then released (shared/rpc-answer.ts): an answer that carried a disposer kept the
 * call open, and the object then never went idle. An answer that isn't data (a function or a stub in it) is logged loud
 * and read as no result: `ResultSchema` then refuses it, a check for a person (`bad_result`).
 */
export function startCall(hub: WriteGateway, req: WriteRequest, timeoutMs: number, log: Record<string, unknown>): {
  answer: Promise<HubAnswer>; settled: Promise<HubAnswer>
} {
  const call = (async () => hub.runAction(req))()
  const settled: Promise<HubAnswer> = call.then(value => {
    try {
      return { value: plainAnswer(value) as unknown }
    } catch (err) {
      console.error({ event: 'outbox_answer_not_data', ...log, error: safeError(err) })
      return { value: undefined as unknown }
    }
  }, (err: unknown) => {
    console.error({ event: 'outbox_send_threw', ...log, error: safeError(err) })
    return { thrown: true as const }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ timeout: true }>(r => { timer = setTimeout(() => r({ timeout: true }), timeoutMs) })
  const answer = Promise.race([settled, timeout]).finally(() => clearTimeout(timer))
  return { answer, settled }
}
