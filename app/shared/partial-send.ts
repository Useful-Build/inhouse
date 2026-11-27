// #487: the groups a multi-order Shopify write names when only part of it went out, read back from the hub's answer.
// The hub's `readTags` (hub/connectors/shopify/write/ops/tags.ts) answers `sent: 'unknown'` with the detail
// `sent 9001,9002; refused 424242` (and `unclear ...`), which `hubError` (hub/index/errors.ts) puts after the code's fixed
// text: `upstream rejected the request: sent 9001,9002; refused 424242`. The outbox keeps the order numbers for the person
// who checks the send. No imports: the server and the hub's own test (hub/outbox-entry/partial-send.test.ts, which drives
// the hub's real answers through this) share it.

/** Which orders of one call went out, were refused or are unclear, by order number (digits only). */
export interface PartialGroups { sent: string[]; refused: string[]; unclear: string[] }

/** The hub's fixed text for the two codes a partly-sent call answers with (hub/index/errors.ts `TEXT`). */
export const PARTIAL_PREFIX: Readonly<Partial<Record<string, string>>> = {
  upstream_rejected: 'upstream rejected the request',
  upstream_unavailable: 'upstream unavailable',
}

/** The most orders one hub call holds (hub/connectors/shopify/write/ops/tags.ts `ORDERS_PER_CALL_MAX`). */
export const ORDERS_PER_CALL_MAX = 5

/** One group of the detail: a word and 1 to 5 order numbers (digits only). */
const GROUP = /^(sent|refused|unclear) (\d{1,20}(?:,\d{1,20}){0,4})$/

/**
 * The groups, or null. The message must be the code's fixed text, ": ", then the groups and nothing else; each word at
 * most once, each order once, at most 5 orders in all. Any other message names no groups (the card then says only that
 * it's unclear), so nothing but digits ever reaches a card.
 */
export function partialOf(code: string, message: string | undefined): PartialGroups | null {
  const prefix = Object.hasOwn(PARTIAL_PREFIX, code) ? `${PARTIAL_PREFIX[code]}: ` : undefined
  if (message === undefined || prefix === undefined || !message.startsWith(prefix)) return null
  const g: PartialGroups = { sent: [], refused: [], unclear: [] }
  const seen = new Set<string>()
  for (const part of message.slice(prefix.length).split('; ')) {
    const m = GROUP.exec(part)
    if (!m) return null
    const word = m[1] as keyof PartialGroups
    if (seen.has(word)) return null
    seen.add(word)
    g[word] = m[2]!.split(',')
  }
  const orders = [...g.sent, ...g.refused, ...g.unclear]
  return seen.size > 0 && orders.length <= ORDERS_PER_CALL_MAX && new Set(orders).size === orders.length ? g : null
}
