// The name rule a chip is checked against before it is added: the server's (route 39), so a file the server would refuse is
// refused at once, on its chip.
import { describe, expect, test } from 'vitest'
import { attachmentNameTooLong } from './notes'

describe('attachmentNameTooLong', () => {
  test.each([
    ['a.csv', false],
    ['x'.repeat(200), false],
    ['x'.repeat(201), true],
    ['é'.repeat(115), false],
    ['é'.repeat(116), true],
    ['\ud800.csv', true],
    ['\udc00x', true],
    ['😀.csv', false],
  ])('%j is too long: %s', (name, want) => { expect(attachmentNameTooLong(name)).toBe(want) })
})
