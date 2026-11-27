// Card details (Stage 1 M3, #488), read inside BrandAgent: the egress holds no hub binding but ReadGateway (P5), so the
// outbox's request asks the object (`BrandAgentRpc.cardFacts`), as it does for the accounts (hub-accounts.ts). The hub
// reads the write store (ConnectGateway.cardFacts); the answer is copied out and released (shared/rpc-answer.ts), its
// private data captured for the fetch leak check like any other Shopify read (egress/taint.ts), then cleaned and handed
// back as plain data (outbox/detail.ts). Display only: the caller stores it beside the card, never in words the agent
// reads.
//
// Fail closed to "no facts": a slow hub (past `CARD_FACTS_TIMEOUT_MS`), an error, an answer that doesn't read, or a
// capture that fails answers null, and the card shows its ids only. A card is never refused for want of them.
import type { CallerScope, CardFactsRequest, ConnectGateway } from '../../../hub/index/contract.ts'
import { readCardFacts } from '../../outbox/detail.ts'
import type { CleanCardFacts } from '../../outbox/detail.ts'
import { safeError } from '../../safe-error.ts'
import { settledAnswer } from '../../../shared/rpc-answer.ts'

/** How long a request waits for the store's facts before it makes the card without them. */
export const CARD_FACTS_TIMEOUT_MS = 5_000

export interface CardFactsDeps {
  connect: Pick<ConnectGateway, 'cardFacts'>
  requestId: string
  /** Stores the answer's private tokens (egress/taint.ts `capture`, source `hub` with no tool: read in full). */
  captureTaint(body: string): Promise<void>
  log(e: Record<string, unknown>): void
  timeoutMs?: number
}

const TIMED_OUT = Symbol('timed out')

/** The store's facts for one request, cleaned, or null (logged with a closed reason only: never a name or an id). */
export async function cardFactsVia(d: CardFactsDeps, req: CardFactsRequest): Promise<CleanCardFacts | null> {
  const scope: CallerScope = { kind: 'server', job: 'actions.card_facts', requestId: d.requestId }
  let timer: ReturnType<typeof setTimeout> | undefined
  let raw: unknown
  try {
    const deadline = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), d.timeoutMs ?? CARD_FACTS_TIMEOUT_MS) })
    raw = await Promise.race([settledAnswer(d.connect.cardFacts(scope, req)), deadline])
  } catch (err) {
    d.log({ event: 'card_facts_unread', why: 'threw', error: safeError(err) })
    return null
  } finally {
    clearTimeout(timer)
  }
  if (raw === TIMED_OUT) {
    d.log({ event: 'card_facts_unread', why: 'timeout' })
    return null
  }
  const read = readCardFacts(raw, req)
  if (read.facts === null) {
    d.log({ event: 'card_facts_unread', why: read.why })
    return null
  }
  try {
    // The hub's answer as it came (before cleaning), so every token the store sent is captured.
    await d.captureTaint(JSON.stringify((raw as { value: unknown }).value))
  } catch (err) {
    d.log({ event: 'card_facts_unread', why: 'taint', error: safeError(err) })
    return null
  }
  return read.facts
}
