// The hash sync's logic is tested in src/shell/route-sync.test.ts against a fake address bar; this guards the wiring (the app
// has no DOM test environment): App.tsx's side of it, and that nothing writes the hash behind its back. A raw
// `history.replaceState` or `history.pushState` leaves the sync's record of what the app wrote stale, and the sync then swallows
// the next real move (#112 review round 1). The one allowed place is the browser host in src/shell/hash-bar.ts.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../src', import.meta.url).pathname
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []))

describe('App.tsx uses the one writer (a revert of its side fails here)', () => {
  const app = readFileSync(join(SRC, 'App.tsx'), 'utf8')
  it('writes only through hashSync.sync and the hash bar, and reads each hashchange through hashBar.adopt', () => {
    expect(app).toContain('hashSync.sync({')
    expect(app).toMatch(/const apply = \(\) => \{[^}]*hashBar\.adopt\(\)/s)
  })
})

describe('no raw history writes', () => {
  it('appear in src outside the hash bar', () => {
    const raw = files(SRC).filter(f => !f.endsWith('/shell/hash-bar.ts') && !/\.test\.tsx?$/.test(f) && /history\.(replaceState|pushState)\(/.test(readFileSync(f, 'utf8')))
    expect(raw.map(f => f.slice(SRC.length + 1))).toEqual([])
  })
})
