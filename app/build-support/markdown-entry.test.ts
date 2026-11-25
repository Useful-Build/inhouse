// Today's first load is held to a gzip budget (scripts/check-bundle.mjs) and Streamdown with its parsers is about 170 KB of
// it, so the renderer must stay its own chunk. Ways it comes back into the entry, written first: a screen or a component
// imports renderer.tsx (or streamdown, remark-breaks) at run time instead of going through the lazy index.tsx; or index.tsx
// itself imports it up front. Type imports are erased by the build and are fine.
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../src/', import.meta.url)
const files = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? files(new URL(`${e.name}/`, dir)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [new URL(e.name, dir)] : []))
/** The modules a file imports at run time (`import type` is erased by the build). A dynamic `import()` is not one. */
const runtimeImports = (src: string) => [...src.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^'";]*?\bfrom\s+)?'([^']+)'/gm)].map(m => m[1])
const DIR = 'screens/chat/markdown/'
/** What loads only with the renderer: Streamdown, remark-breaks, and the renderer's own files (as another file names them). */
const HEAVY_OUTSIDE = /markdown\/(renderer|components|plugins)$|^streamdown$|^remark-breaks$/
const HEAVY_INSIDE = /^\.\/(renderer|components|plugins)$|^streamdown$|^remark-breaks$/

describe('the markdown renderer is a chunk of its own', () => {
  it('only renderer.tsx imports the renderer, Streamdown and the files only it uses, at run time', () => {
    for (const file of files(SRC)) {
      const path = file.pathname.slice(SRC.pathname.length)
      if (path === `${DIR}renderer.tsx`) continue
      for (const i of runtimeImports(readFileSync(file, 'utf8'))) expect((path.startsWith(DIR) ? HEAVY_INSIDE : HEAVY_OUTSIDE).test(i), `${path} imports ${i} up front`).toBe(false)
    }
  })

  it('index.tsx loads it with a dynamic import', () => {
    const index = readFileSync(new URL(`${DIR}index.tsx`, SRC), 'utf8')
    expect(index).toMatch(/import\('\.\/renderer'\)/)
  })
})
