// The server's copy of the hub contract's throttle wait (hub-call.ts): the product build takes only types from the
// hub's contract, so the value is copied, and this keeps the copy equal.
import { describe, expect, it } from 'vitest'
import { THROTTLE_WAIT_MS as HUB } from '../../hub/index/contract.ts'
import { THROTTLE_WAIT_MS } from './hub-call.ts'

describe('the throttle wait', () => {
  it('equals the hub contract\'s', () => {
    expect(THROTTLE_WAIT_MS).toEqual(HUB)
  })
})
