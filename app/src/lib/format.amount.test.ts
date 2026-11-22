// The problem panel and the Today card show a cost only when there is one: the server serves an unknown cost (the item's
// cost null, or its currency not the brand's) as `minor: 0`, and "$0.00" would read as a real figure. Ways it can fail: a
// zero cost passes as an amount; a real one (even 1 cent) is hidden.
import { expect, test } from 'vitest'
import { fc, test as prop } from '@fast-check/vitest'
import { hasAmount } from './format'

test('a null-cost item (served as minor 0) has no amount, so the panel and the card show no "$0"', () => {
  expect(hasAmount({ minor: 0, currency: 'USD' })).toBe(false)
})
prop.prop([fc.integer({ min: 1, max: 10_000_000_00 })])('any positive cost has an amount', minor => {
  expect(hasAmount({ minor, currency: 'USD' })).toBe(true)
})
