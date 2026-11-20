// The product client entry turns zod's code generation off before anything builds a schema (shared/contract/jitless.ts):
// the product's CSP has no `unsafe-eval`, and zod's probe (`new Function`) is reported as a violation. It fails if the
// jitless import stops being the entry's first import (or is dropped), so a schema could be built with the probe on.
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('the product client entry', () => {
  const entry = readFileSync(new URL('../src/agent/client.product.ts', import.meta.url), 'utf8')
  const imports = [...entry.matchAll(/^import\s+(?:type\s+)?(?:[^'\n]*from\s+)?'([^']+)'/gm)].map(m => m[1])

  it('imports jitless before anything else', () => {
    expect(imports[0]).toBe('../../shared/contract/jitless')
  })
  it('is the only importer of it outside tests: the demo bundle stays without it (Today budget)', () => {
    const dirs = ['../shared/contract/', '../src/agent/', '../src/agent/http/']
    const importers = dirs.flatMap(d => readdirSync(new URL(d, import.meta.url)).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'jitless.ts')
      .filter(f => /from '[^']*jitless[^']*'|^import '[^']*jitless[^']*'/m.test(readFileSync(new URL(d + f, import.meta.url), 'utf8'))))
    expect(importers).toEqual(['client.product.ts'])
  })
})
