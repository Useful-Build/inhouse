// The word reveal of a streamed answer. Ways it can fail, written first: it goes backwards or stands still (the answer
// never finishes), it cuts a word in half (a letter pops in later), it takes too many steps for a long answer (falls
// behind the stream), or it ends short of the text.
import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { MAX_STEPS, nextShown } from './reveal'

const texts = fc.array(fc.oneof(fc.string({ minLength: 1, maxLength: 9 }), fc.constantFrom(' ', '  ', '\n', '\n\n', ' \t')), { maxLength: 400 }).map(a => a.join(''))

describe('nextShown', () => {
  test('moves forward, never past the text, and cuts only at the start of a word', () => {
    fc.assert(fc.property(texts, fc.nat(), (text, from) => {
      const shown = Math.min(from, text.length)
      const n = nextShown(text, shown)
      expect(n).toBeGreaterThanOrEqual(shown)
      expect(n).toBeLessThanOrEqual(text.length)
      if (shown < text.length) expect(n).toBeGreaterThan(shown)
      if (n > 0 && n < text.length) { expect(/\s/.test(text[n - 1])).toBe(true); expect(/\s/.test(text[n])).toBe(false) }
    }))
  })

  test('reaches the whole text in a bounded number of steps, however long it is', () => {
    fc.assert(fc.property(texts, text => {
      let shown = 0, steps = 0
      while (shown < text.length) { shown = nextShown(text, shown); steps++ }
      expect(shown).toBe(text.length)
      expect(steps).toBeLessThanOrEqual(MAX_STEPS + 1)
    }))
  })

  test('a short answer comes a few words at a time', () => {
    expect(nextShown('one two three four five six', 0)).toBe('one two three '.length)
  })
})
