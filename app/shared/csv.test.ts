// The audit export's CSV (shared/csv.ts). Ways it can fail, written down first:
//  1. a cell with a quote, comma, CR, LF or tab breaks the row apart, or comes back altered;
//  2. a cell starting with =, +, -, @, a tab or a CR reaches a spreadsheet as a formula (no leading ');
//  3. a cell gets a ' it didn't need, so its text changes;
//  4. the rows don't come back as the table that went in.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { AUDIT_CSV_HEADER, csvCell, csvRow } from './csv.ts'

/** RFC 4180 with every cell quoted (what csvRow writes): rows of cells. */
function parse(text: string): string[][] {
  const rows: string[][] = []
  let i = 0
  while (i < text.length) {
    const row: string[] = []
    for (;;) {
      if (text[i] !== '"') throw new Error(`unquoted cell at ${i}`)
      let cell = ''
      i++
      for (;;) {
        const q = text.indexOf('"', i)
        if (q < 0) throw new Error('unterminated cell')
        cell += text.slice(i, q)
        if (text[q + 1] === '"') { cell += '"'; i = q + 2 } else { i = q + 1; break }
      }
      row.push(cell)
      if (text[i] === ',') { i++; continue }
      if (text.startsWith('\r\n', i)) { i += 2; break }
      throw new Error(`bad separator at ${i}`)
    }
    rows.push(row)
  }
  return rows
}

const risky = fc.constantFrom('=', '+', '-', '@', '\t', '\r', '"', ',', '\n', '\r\n', "'", ' ', 'é', '\u{1F600}')
const cellArb = fc.array(fc.oneof(risky, fc.string({ unit: 'binary', maxLength: 3 })), { maxLength: 8 }).map(p => p.join(''))
const expected = (cell: string) => (/^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell)

describe('the CSV', () => {
  test.prop([fc.array(fc.array(cellArb, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 10 })], { numRuns: 300 })(
    'parses back to the table, each cell with a leading quote exactly when it started like a formula (failures 1 to 4)',
    rows => {
      const text = rows.map(csvRow).join('')
      expect(parse(text)).toEqual(rows.map(r => r.map(expected)))
    },
  )
  it('defuses each formula start and leaves others alone', () => {
    for (const c of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(c)).toBe(`"'${c}"`)
    for (const c of ['1', 'a=b', ' =x', "'x", '']) expect(csvCell(c)).toBe(`"${c}"`)
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
  })
  it('has the header row', () => expect(csvRow(AUDIT_CSV_HEADER)).toBe('"When","Who","What","Detail"\r\n'))
})
