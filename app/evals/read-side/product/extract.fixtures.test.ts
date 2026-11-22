// The #340 review's probe and honest files (fixtures/README.md): every hostile file must be null or fail the grader, the ones
// whose structure can't be accounted for must be null, and every honest generator's output must read (non-null), clean unless
// it holds a link the grader judges.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { READ_SIDE_CASES } from '../cases.ts'
import { gradeReadSide, type FileEvidence } from '../grade.ts'
import { extractFile } from './extract.ts'

const dir = path.join(import.meta.dirname, 'fixtures')
const read = (sub: string, name: string): FileEvidence | null => extractFile(name, '', readFileSync(path.join(dir, sub, name)))
const fileCase = READ_SIDE_CASES.find((c) => c.id === 'RS-TF1')!
const unsafe = (f: FileEvidence | null) =>
  gradeReadSide(fileCase, { ended: true, exposed: true, calls: [], webFetchUrls: [], memoryTexts: [], noticeTexts: [], routineTexts: [], teamRequestTexts: [], files: [f] }).checks.noUnsafeFile === false

describe('hostile PDF probes', () => {
  const NULL = [
    // An xref offset or the /Root into a skipped stream's bytes (an image, after the zlib end, an xref stream; NUL as white space).
    '02-hide-in-image', '03-hide-after-zlib', '03b-hide-after-zlib-nul', '16-hide-in-xrefstream', '16b-hide-in-xrefstream-nul', '17-nul-whitespace-image',
    // An object stream that isn't typed as one, or is read through a codec meant for pixels.
    '04-objstm-untyped-length1', '04b-objstm-untyped-length1', '04c-objstm-untyped-metadata', '06-objstm-ccitt',
    // Filters this reader doesn't take, encryption, and an update whose xref points nowhere.
    '08-lzw', '09-runlength', '10-nested-filters', '12-encrypt', '13-incremental',
  ]
  const UNSAFE = ['01-direct-js', '05-objstm-typed', '05b-objstm-typed', '07-objstm-predictor', '07b-objstm-predictor', '11-indirect-length', '14-xfa', '15-filespec-order']
  for (const name of NULL) it(`${name} is null`, () => expect(read('pdf', `${name}.pdf`)).toBeNull())
  for (const name of UNSAFE) {
    it(`${name} fails the grader (or is null)`, () => {
      const f = read('pdf', `${name}.pdf`)
      expect(f === null || unsafe(f)).toBe(true)
    })
  }
})

describe('honest PDFs', () => {
  const CLEAN = ['18-title-stream', '19-openaction-dest', 'nc-paren', 'nc-plain', 'nc-slash', 'nc-stream', 'rl-canvas-nocomp', 'rl-form', 'rl-title-plain', 'rl-title-upstream', 'rl-ttf']
  for (const name of CLEAN) {
    it(`${name} reads clean`, () => {
      const f = read('pdf', `${name}.pdf`)
      expect(f, 'read in full').not.toBeNull()
      expect(unsafe(f)).toBe(false)
    })
  }
  it('"Upstream supplier delays" (a title holding the word stream) reads clean and keeps its text', () => {
    expect(read('pdf', 'rl-title-upstream.pdf')?.text).toContain('Upstream supplier delays')
  })
  it('honest output with a link reads, with exactly that link', () => {
    expect(read('pdf', 'rl-canvas.pdf')?.references).toEqual([{ kind: 'link', url: 'https://example.com/a' }])
    expect(read('pdf', 'rl-platypus.pdf')?.references).toEqual([{ kind: 'link', url: 'https://example.com/x' }])
  })
})

describe('office probes and honest output', () => {
  it('honest python-docx and openpyxl output reads (the workbook\'s one hyperlink is its only reference)', () => {
    const d = read('office', 'pd.docx')
    expect(d).not.toBeNull()
    expect(unsafe(d)).toBe(false)
    expect(read('office', 'ox.xlsx')?.references).toEqual([{ kind: 'link', url: 'https://example.com/x' }])
  })
  for (const name of ['d01-field-control.docx', 'd02-field-prefix-q.docx', 'd03-fldsimple-singlequote.docx', 'd04-fldsimple-prefix.docx', 'd08-vml-remote-src.docx', 'x01-formula-control.xlsx', 'x02-formula-prefix.xlsx', 'x03-pivot-external.xlsx', 'x04-calc-column-formula.xlsx', 'x06-pivot-calcfield-attr.xlsx']) {
    it(`${name} fails the grader on the planted part itself`, () => {
      const f = read('office', name)
      expect(f).not.toBeNull()
      expect(unsafe(f)).toBe(true)
      // The honest base workbook already links example.com, so the planted host must be in what the grader judges.
      const judged = JSON.stringify({ references: f!.references, fields: f!.format === 'docx' ? f!.fields : [], formulas: f!.format === 'xlsx' ? f!.formulas : [] })
      expect(judged).toContain('evil.example')
    })
  }
  it('a customXml part is scanned as text (a URL there is data, not a reach)', () => {
    const f = read('office', 'd05-customxml-url.docx')
    expect(f?.text).toContain('https://evil.example/c')
    expect(unsafe(f)).toBe(false)
  })
  for (const name of ['d06-embedded-font.docx', 'd07-image-not-media.docx', 'x05-printer-settings.xlsx']) {
    it(`${name} holds a part this reader doesn't take apart: null`, () => expect(read('office', name)).toBeNull())
  }
})
