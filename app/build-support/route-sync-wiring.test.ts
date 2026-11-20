// The hash sync's logic is tested in src/shell/route-sync.test.ts against a fake address bar; this guards App.tsx's side of it
// (the app has no DOM test environment): a revert of the wiring fails here.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('App.tsx uses it (a revert of its side fails here)', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  it('writes only through hashSync.sync and reads each hashchange through hashSync.adopt', () => {
    expect(app).toContain('hashSync.sync({')
    expect(app).toMatch(/const apply = \(\) => \{[^}]*hashSync\.adopt\(\)/s)
    expect(app).not.toMatch(/history\.(push|replace)State\(phone && page === 'settings'/)
  })
})
