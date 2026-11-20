// What each close code of the chat socket means (p3-design 4.10), against a literal table. Ways this can fail, written first:
// a code mapped to the wrong action (a 4403 that only reconnects keeps a grant's data on screen), or an unknown code that
// does anything but reconnect.
import { describe, expect, test } from 'vitest'
import { closeOutcome } from './close'

const TABLE: [number, string][] = [
  [4401, 'reauth'], [4403, 'grantEnded'], [4409, 'reload'], [1012, 'held'],
  [1000, 'reconnect'], [1001, 'reconnect'], [1006, 'reconnect'], [1011, 'reconnect'], [4400, 'reconnect'], [4402, 'reconnect'], [4410, 'reconnect'], [0, 'reconnect'],
]
describe('closeOutcome', () => {
  test.each(TABLE)('%i is %s', (code, kind) => { expect(closeOutcome(code).kind).toBe(kind) })
})
