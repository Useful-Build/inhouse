// The server's copy of the hub contract's throttle wait (hub-call.ts): the product build takes only types from the
// hub's contract, so the value is copied, and this keeps the copy equal.
import { describe, expect, it } from 'vitest'
import { THROTTLE_WAIT_MS as HUB } from '../../hub/index/contract.ts'
import { expectFor, expectOf, THROTTLE_WAIT_MS } from './hub-call.ts'
import { WriteRequestSchema } from '../../hub/index/schemas.ts'

describe('the throttle wait', () => {
  it('equals the hub contract\'s', () => {
    expect(THROTTLE_WAIT_MS).toEqual(HUB)
  })
})

// Stage 1 M4 (#673): what the hub is asked to check, by connector. Ways it can go wrong, written first: a connection's
// write falls into Slack's branch and goes out with no pins; a Shopify write loses its store.
describe('expectOf by connector', () => {
  it('a compiled operation gets its generation, and Shopify its store', () => {
    expect(expectOf('slack.channel.post', 7, { channelId: 'C0123ABCD' }, 'ac_1')).toEqual({ connectedAtMs: 7 })
    expect(expectOf('shopify.order.tag_add', 7, { shop: 'store-a' }, 'ac_1')).toEqual({ connectedAtMs: 7, shop: 'store-a' })
    expect(() => expectOf('shopify.order.tag_add', 7, {}, 'ac_1')).toThrow(/no shop/)
  })
  it("refuses a connection's write until its pins are built, never Slack's expect", () => {
    expect(() => expectFor('mcp', 7, {}, 'ac_1')).toThrow(/no pins until M4-W1/)
    // Control: the same generation for Slack is the bare expect the hub's schema still takes.
    const bare = expectFor('slack', 7, {}, 'ac_1')
    expect(WriteRequestSchema.safeParse({ actionId: 'ac_1', attempt: 1, requestId: 'ac_1', accountId: 'slack:workspace', expect: bare, operation: 'slack.channel.post', args: {} }).success).toBe(true)
  })
})
