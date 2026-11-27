// #487 (M3-X, review round 1): the server reads a partly-sent multi-order write's groups from the hub's answer
// (shared/partial-send.ts `partialOf`). These cases drive the hub's own `readTags` and `hubError`, so the parse and the
// hub's words can't drift apart. Ways it can go wrong, written first:
// - the parse misses the hub's fixed text before the groups, so a real partial answer names no groups;
// - the server's copies of that text or of the per-call order limit differ from the hub's;
// - a group or a whole answer past one call's orders is read.
import { describe, expect, it } from 'vitest'
import type { WriteResult } from '../index/contract'
import { hubError } from '../index/errors'
import { ORDERS_PER_CALL_MAX as HUB_ORDERS_PER_CALL_MAX, readTags } from '../connectors/shopify/write/ops/tags'
import { ORDERS_PER_CALL_MAX, PARTIAL_PREFIX, partialOf } from '../../shared/partial-send'

const order = (n: number) => `gid://shopify/Order/${n}`
const done = (n: number) => ({ node: { id: order(n) }, userErrors: [] })
const refused = { node: null, userErrors: [{ message: 'x' }] }
/** The hub's answer to a tag_add on these orders, given each aliased root's data (`o0`, `o1`, ...). */
const hubTags = (orders: number[], data: Record<string, unknown>): WriteResult => readTags(data, { orderIds: orders.map(order), tags: ['rush'] }, '')
const groupsOf = (r: WriteResult) => {
  if (r.ok) throw new Error('expected a partial answer')
  expect(r.sent).toBe('unknown')
  return partialOf(r.error.code, r.error.message)
}

describe('the server reads the hub\'s partial answers', () => {
  it('its copies of the fixed texts and the per-call limit are the hub\'s', () => {
    for (const code of ['upstream_rejected', 'upstream_unavailable'] as const) expect(PARTIAL_PREFIX[code]).toBe(hubError(code).message)
    expect(ORDERS_PER_CALL_MAX).toBe(HUB_ORDERS_PER_CALL_MAX)
  })

  it('every partial shape the hub answers names its groups', () => {
    const pinned = hubTags([9001, 424242, 9002], { o0: done(9001), o1: refused, o2: done(9002) })
    expect(pinned).toEqual({ ok: false, error: { code: 'upstream_rejected', message: 'upstream rejected the request: sent 9001,9002; refused 424242' }, sent: 'unknown' })
    expect(groupsOf(pinned)).toEqual({ sent: ['9001', '9002'], refused: ['424242'], unclear: [] })
    expect(groupsOf(hubTags([9001, 9002], { o0: done(9001) }))).toEqual({ sent: ['9001'], refused: [], unclear: ['9002'] })
    expect(groupsOf(hubTags([9001, 9002], { o0: null, o1: refused }))).toEqual({ sent: [], refused: ['9002'], unclear: ['9001'] })
    // A full call (the hub's most orders), every group named.
    expect(groupsOf(hubTags([1, 2, 3, 4, 5], { o0: done(1), o1: done(2), o2: refused, o3: refused })))
      .toEqual({ sent: ['1', '2'], refused: ['3', '4'], unclear: ['5'] })
  })

  it('reads nothing else: the bare groups, another code\'s text, more than one call\'s orders', () => {
    const P = 'upstream rejected the request: '
    for (const [code, bad] of [
      ['upstream_rejected', undefined], ['upstream_rejected', ''], ['upstream_rejected', 'sent 9001,9002; refused 424242'], ['upstream_rejected', `${P}unclear`],
      ['upstream_rejected', `${P}sent order`], ['upstream_rejected', `${P}sent 1; sent 2`], ['upstream_rejected', `${P}sent 1;refused 2`],
      ['upstream_rejected', `${P}sent 1, 2`], ['upstream_rejected', `${P}went 1`], ['upstream_rejected', `${P}sent 1; <b>x</b>`],
      ['upstream_rejected', `${P}sent 1\nrefused 2`], ['upstream_rejected', `x ${P}sent 1`], ['upstream_rejected', `${P}sent 1,2,3,4,5,6`],
      ['upstream_rejected', `${P}sent 1,2,3; refused 4,5,6`], ['upstream_rejected', `${P}sent 1; refused 1`],
      ['upstream_unavailable', `${P}sent 1`], ['write_refused', `${P}sent 1`], ['constructor', 'function Object() { [native code] }: sent 1'],
      ['upstream_unavailable', hubError('upstream_unavailable', 'timeout').message],
    ] as const) {
      expect(partialOf(code, bad), `${code} ${String(bad)}`).toBeNull()
    }
  })
})
