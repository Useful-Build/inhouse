// Today's first load has a 240 KB gzip budget (scripts/check-bundle.mjs), and zod's runtime is ~360 KB of source. The
// client files in the entry (the mock, the HTTP client, the types) therefore take only plain values from shared/contract:
// the lists in keys.ts, the settings table, the error constants. A schema (anything from a file that imports zod) belongs
// to the server and the tests. Fails when one of them imports a value from another contract file, or when a plain
// module starts importing something at run time.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
/** The modules a file imports at run time (`import type` is erased by the build). */
const runtimeImports = (src: string) => [...src.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^'";]*?\bfrom\s+)?'([^']+)'/gm)].map(m => m[1])
const PLAIN = ['keys', 'settings-table', 'error-codes', 'chat-codes']

describe('runtimeImports', () => {
  it('reads multi-line imports and re-exports, and skips type-only ones', () => {
    const src = ["import {", '  a,', '  b,', "} from '../x'", "export {", '  c', "} from '../y'", "import './side'", "import type {", ' T', "} from '../t'", "const s = 1"].join('\n')
    expect(runtimeImports(src)).toEqual(['../x', '../y', './side'])
  })
})

describe('the entry reaches no zod', () => {
  for (const file of ['src/agent/mock.ts', 'src/agent/http/client.ts', 'src/agent/types.ts', 'src/state/store.ts', 'src/state/derive.ts']) {
    it(`${file} takes only plain values from shared/contract`, () => {
      const contract = runtimeImports(read(file)).filter(i => i.includes('shared/contract'))
      for (const i of contract) expect(PLAIN, `${file} imports ${i}`).toContain(i.split('/').pop()!.replace(/\.ts$/, ''))
    })
  }
  for (const name of PLAIN) {
    it(`shared/contract/${name}.ts imports nothing at run time`, () => {
      expect(runtimeImports(read(`shared/contract/${name}.ts`))).toEqual([])
    })
  }
})
