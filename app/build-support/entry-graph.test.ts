// Today's first load has a 257 KB gzip budget (scripts/check-bundle.mjs) with little room. Walks the static import graph
// from the entry (src/main.tsx, both clients) and checks what must stay out of it: the command palette and cmdk (loaded
// when the palette first opens, or on idle) and the base Code Block (only the trace window's drawer and the markdown
// renderer use it, both lazy). Ways they come back, written first: App.tsx or another file imports CommandPalette at run
// time instead of the lazy route; a file in the entry imports `cmdk` or `components/ui/command`; trace.tsx (in the entry
// through the steps line) or the `src/ui/agent` barrel names the Code Block again. A dynamic `import()` is not an edge.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const APP = fileURLToPath(new URL('..', import.meta.url))
/** The modules a file imports at run time (`import type` is erased by the build). A dynamic `import()` is not one. */
const runtimeImports = (src: string) => [...src.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^'";]*?\bfrom\s+)?'([^']+)'/gm)].map(m => m[1])
/** vite.config.ts's aliases the client uses: `@client` is either client, so both are walked. */
const ALIAS: Record<string, string[]> = {
  '@client': ['src/agent/client.demo.ts', 'src/agent/client.product.ts'],
}
const EXT = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
const file = (base: string) => {
  const hit = EXT.map(e => base + e).find(p => existsSync(p) && /\.tsx?$/.test(p))
  if (!hit) throw new Error(`entry-graph: cannot resolve ${base}`)
  return hit
}

/** Every source file and package the entry reaches through static imports. */
function entryGraph() {
  const files = new Set<string>()
  const packages = new Set<string>()
  const queue = [join(APP, 'src/main.tsx')]
  while (queue.length) {
    const f = queue.pop()!
    if (files.has(f)) continue
    files.add(f)
    for (const i of runtimeImports(readFileSync(f, 'utf8'))) {
      if (i.endsWith('.css') || i.endsWith('.json') || i.startsWith('@sample/')) continue
      if (ALIAS[i]) queue.push(...ALIAS[i].map(p => join(APP, p)))
      else if (i.startsWith('@/')) queue.push(file(join(APP, 'src', i.slice(2))))
      else if (i.startsWith('.')) queue.push(file(resolve(dirname(f), i)))
      else packages.add(i)
    }
  }
  return { files: [...files].map(f => f.slice(APP.length)), packages }
}

describe("what stays out of Today's first load", () => {
  const { files, packages } = entryGraph()

  it('walks the real entry (the shell, Today, Chats and the steps line are in it)', () => {
    for (const f of ['src/App.tsx', 'src/screens/Today.tsx', 'src/screens/Chats.tsx', 'src/ui/agent/trace.tsx', 'src/shell/shortcuts.ts']) expect(files).toContain(f)
  })

  it('the command palette and cmdk load on first open, not with the entry', () => {
    expect(files).not.toContain('src/overlays/CommandPalette.tsx')
    expect(files).not.toContain('src/components/ui/command.tsx')
    expect([...packages]).not.toContain('cmdk')
    // ...and it is still a lazy route, prefetched on idle.
    expect(readFileSync(join(APP, 'src/App.tsx'), 'utf8').split("import('./overlays/CommandPalette')").length - 1).toBe(2)
  })

  it('the base Code Block loads with the trace window or the markdown renderer, not with the entry', () => {
    expect(files).not.toContain('src/components/ui/code-block.tsx')
    expect(files).not.toContain('src/ui/agent/code.tsx')
  })
})
