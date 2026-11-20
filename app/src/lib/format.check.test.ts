// scripts/check-format.mjs (P1, C1): every way around the old line scan that the PR #66 review found has a probe file in
// scripts/check-format-probes/, and each must fail the check where it would sit in src/. clean.ts (the same names in
// comments, strings, types and the UTC getters) must pass.
import { describe, expect, test } from 'vitest'

type Check = (rel: string, source: string) => { line: number; name: string }[]
const { check } = (await import(new URL('../../scripts/check-format.mjs', import.meta.url).href)) as { check: Check }
// Each probe's source, as text (Vite's `?raw`): never run, only checked.
const PROBE_SOURCES = import.meta.glob<string>('../../scripts/check-format-probes/*.ts', { query: '?raw', import: 'default', eager: true })
const probe = (name: string) => {
  const src = PROBE_SOURCES[`../../scripts/check-format-probes/${name}`]
  if (src === undefined) throw new Error(`No probe file ${name}`)
  return src
}
const linesHit = (rel: string, source: string) => [...new Set(check(rel, source).map(p => p.line))].sort((a, b) => a - b)

describe('check-format catches each probe where it would sit in src/', () => {
  const PROBES: [file: string, lines: number[]][] = [
    ['bracket-access.ts', [2, 3]],
    ['destructured-intl.ts', [2, 3, 5]],
    ['split-lines.ts', [3, 5]],
    ['slash-in-string.ts', [2]],
    ['comment-before-paren.ts', [2]],
    ['relative-time.ts', [2, 3]],
    ['hand-built.ts', [3, 4, 5, 6, 7, 8]],
  ]
  for (const [file, lines] of PROBES) {
    test(file, () => {
      expect(linesHit(`src/screens/${file}`, probe(file))).toEqual(lines)
      expect(linesHit(`shared/contract/${file}`, probe(file))).toEqual(lines)
    })
  }
  test('clean.ts: names in comments, strings and types, and the UTC getters, pass', () => {
    expect(check('src/screens/clean.ts', probe('clean.ts'))).toEqual([])
  })
  test('a .tsx file is parsed as TSX', () => {
    expect(linesHit('src/ui/x.tsx', 'export const A = () => <b>{new Date().toLocaleString()}</b>\n')).toEqual([1])
  })
})

describe('the allowances', () => {
  test('format.ts may use Intl, toLocale* and the getters', () => {
    expect(check('src/lib/format.ts', probe('relative-time.ts') + probe('hand-built.ts'))).toEqual([])
  })
  test('the demo clock may use the getters, but not a locale formatter', () => {
    expect(check('src/agent/clock.ts', probe('hand-built.ts'))).toEqual([])
    expect(linesHit('src/agent/clock.ts', probe('comment-before-paren.ts'))).toEqual([2])
  })
})
