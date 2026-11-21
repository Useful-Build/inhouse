// The word reveal of a streamed answer. Ways it can fail, written first: it goes backwards or stands still (the answer
// never finishes), it cuts a word in half (a letter pops in later), it takes too many steps for a long answer (falls
// behind the stream), or it ends short of the text.
import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { MAX_STEPS, cutsMarkdown, nextShown } from './reveal'

const texts = fc.array(fc.oneof(fc.string({ minLength: 1, maxLength: 9 }), fc.constantFrom(' ', '  ', '\n', '\n\n', ' \t')), { maxLength: 400 }).map(a => a.join(''))

// Long answers: 50 to 2000 words (the default array size of fast-check stops near 10, which never reached the bound).
const longTexts = fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 50, maxLength: 2000 }).chain(ws =>
  fc.array(fc.constantFrom(' ', '  ', '\n'), { minLength: ws.length, maxLength: ws.length }).map(seps => ws.map((w, i) => w + seps[i]).join('')))

// Texts that hold real tables (a separator of three or more dashes) and code fences (some never closed), written apart from
// the code under test: `blocksOf` is a small parser of its own, giving each table's and fence's span [start, end), where
// end is the start of the line after it (or the text's end).
const cell = fc.stringMatching(/^[a-z0-9#]{1,6}( [a-z0-9]{1,5}){0,2}$/)
const table = fc.tuple(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 6 })).chain(([cols, nrows]) => {
  const row = fc.array(cell, { minLength: cols, maxLength: cols }).map(c => `| ${c.join(' | ')} |`)
  return fc.tuple(row, fc.constantFrom('---', '----', ':---:', '---:'), fc.array(row, { minLength: 1, maxLength: nrows }))
    .map(([head, dash, rows]) => [head, `| ${Array(cols).fill(dash).join(' | ')} |`, ...rows].join('\n'))
})
const fence = fc.tuple(fc.array(fc.stringMatching(/^[a-z =()|]{0,20}$/), { maxLength: 8 }), fc.boolean())
  .map(([body, closed]) => ['```js', ...body, ...(closed ? ['```'] : [])].join('\n'))
const prose = fc.array(fc.stringMatching(/^[a-z]{1,8}[.,]?$/), { minLength: 1, maxLength: 12 }).map(w => w.join(' '))
const docs = fc.array(fc.oneof(prose, table, fence), { minLength: 1, maxLength: 6 }).map(a => a.join('\n\n') + '\n')

function blocksOf(text: string): [number, number][] {
  const lines = text.split('\n')
  const at: number[] = []
  let pos = 0
  for (const l of lines) { at.push(pos); pos += l.length + 1 }
  const end = (i: number) => (i >= lines.length || at[i] >= text.length ? text.length : at[i])
  const out: [number, number][] = []
  for (let i = 0; i < lines.length;) {
    if (lines[i].trimStart().startsWith('```')) {
      let j = i + 1
      while (j < lines.length && !lines[j].trimStart().startsWith('```')) j++
      out.push([at[i], end(j + 1)])
      i = j + 1
    } else if (lines[i].startsWith('|') && /^\|( *:?-{3,}:? *\|)+$/.test(lines[i + 1] ?? '')) {
      let j = i + 2
      while (j < lines.length && lines[j].startsWith('|')) j++
      out.push([at[i], end(j)])
      i = j
    } else i++
  }
  return out
}

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
    fc.assert(fc.property(fc.oneof(texts, longTexts), text => {
      let shown = 0, steps = 0
      while (shown < text.length) { shown = nextShown(text, shown); steps++ }
      expect(shown).toBe(text.length)
      expect(steps).toBeLessThanOrEqual(MAX_STEPS)
    }), { numRuns: 60 })
  })

  test('never shows half of a bold, a code span, a link, or an italic with a star or an underscore', () => {
    const text = 'Sales were **up 12% on last week** and `fast` per [the report](https://x.test/a) today, _really_ and *very* so.\n'
    let shown = 0
    while (shown < text.length) { shown = nextShown(text, shown); expect(cutsMarkdown(text.slice(0, shown))).toBe(false) }
    expect(cutsMarkdown('a _half')).toBe(true)
    expect(cutsMarkdown('a _whole_ one')).toBe(false)
    expect(cutsMarkdown('a snake_case name')).toBe(false)
  })

  test('shows a table or a code fence in one piece: no prefix holds part of one', () => {
    fc.assert(fc.property(docs, text => {
      const blocks = blocksOf(text)
      let shown = 0
      while (shown < text.length) {
        shown = nextShown(text, shown)
        for (const [s, e] of blocks) expect(s < shown && shown < e, `cut at ${shown} inside block ${s}-${e}`).toBe(false)
      }
    }), { numRuns: 200 })
  })

  test('a short answer comes a few words at a time', () => {
    expect(nextShown('one two three four five six', 0)).toBe('one two three '.length)
  })
})
