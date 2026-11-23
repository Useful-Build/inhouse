// The read-side readers' two text patterns stay linear on hostile input (CodeQL js/redos on PR #372) and still match
// what they're for. A file or answer the agent writes is untrusted: a pattern that backtracks exponentially on it would
// hang the grader instead of failing the case.
import { describe, expect, it } from 'vitest'
import { MD_LINK } from './grade.ts'
import { PDF_TJ_ARRAY } from './product/pdf.ts'

/** Runs `fn` and fails if it takes longer than `ms` (the old patterns took minutes on these inputs). */
const fast = (fn: () => unknown, ms = 500) => {
  const t0 = performance.now()
  fn()
  expect(performance.now() - t0).toBeLessThan(ms)
}

describe('MD_LINK', () => {
  it('stays linear on many nested brackets with no closing link', () => {
    fast(() => [...('[' + '[[]'.repeat(20_000)).matchAll(MD_LINK)])
    fast(() => [...('![' + '[x]'.repeat(20_000) + '(').matchAll(MD_LINK)])
  })
  it('still finds links and images, with one level of nested brackets in the text', () => {
    const got = (s: string) => [...s.matchAll(MD_LINK)].map(m => [m[1], m[2]])
    expect(got('See [the guide](https://docs.example.test/a).')).toEqual([['', 'https://docs.example.test/a']])
    expect(got('![pixel](https://px.evil-example.test/a.gif)')).toEqual([['!', 'https://px.evil-example.test/a.gif']])
    expect(got('[a [b] c](<https://x.test/y>)')).toEqual([['', 'https://x.test/y']])
    expect(got('[stray [ bracket](https://x.test/z)')).toEqual([['', 'https://x.test/z']])
  })
})

describe('PDF_TJ_ARRAY', () => {
  it('stays linear on many backslashes with no closing bracket', () => {
    fast(() => [...('[' + '\\\\'.repeat(20_000)).matchAll(PDF_TJ_ARRAY)])
    fast(() => [...('[' + '\\]'.repeat(20_000) + ' Tx').matchAll(PDF_TJ_ARRAY)])
  })
  it('still reads a TJ array, escaped brackets and backslashes included', () => {
    const got = (s: string) => [...s.matchAll(PDF_TJ_ARRAY)].map(m => m[1])
    expect(got('[(Hello) -250 (World)] TJ')).toEqual(['(Hello) -250 (World)'])
    expect(got('[(a\\]b) (c\\\\)]TJ')).toEqual(['(a\\]b) (c\\\\)'])
  })
})
