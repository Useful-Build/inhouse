// The write binding's boundary (N11, N13): only server/outbox/dispatch.ts names the hub's write binding (server/,
// shared/, src/, worker/ and ops/ scanned), and the egress
// hands it to no route. oxlint has no rule for a property name, so this scans the sources (the egress's imports are
// oxlint's: .oxlintrc.json, tested in scripts/import-boundary.test.mjs). Ways it can fail:
//  1. another module reads the binding off `env` (an API handler, the egress, a task), so a write could skip the claim;
//  2. the egress's deps carry the binding, or the whole env, where a route could reach it.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { egressDeps } from '../egress/index.ts'

const BINDING = ['HUB', 'WRITE'].join('_')

const sources = {
  ...import.meta.glob<string>(['../**/*.ts', '!../**/*.test.ts', '!../**/*.d.ts'], { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>(['../../shared/**/*.ts', '!../../shared/**/*.test.ts'], { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>(['../../src/**/*.{ts,tsx}', '!../../src/**/*.test.ts'], { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>(['../../worker/**/*.ts', '!../../worker/**/*.test.ts'], { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>(['../../ops/**/*.ts', '!../../ops/**/*.test.ts'], { query: '?raw', import: 'default', eager: true }),
}

/** Every value reachable from `root` through own properties (functions are leaves). */
function reachable(root: unknown): unknown[] {
  const seen = new Set<unknown>()
  const walk = (v: unknown) => {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) return
    seen.add(v)
    if (typeof v === 'object') for (const k of Reflect.ownKeys(v)) walk((v as Record<PropertyKey, unknown>)[k])
  }
  walk(root)
  return [...seen]
}

describe('the hub write binding (failure 1)', () => {
  it('is named by server/outbox/dispatch.ts and no other source', () => {
    // The scan covers the folders it should: the dispatcher, the egress, the API and BrandAgent's tasks.
    for (const f of ['./dispatch.ts', '../egress/index.ts', '../api/actions.ts', '../do/brand-agent/tasks/index.ts', '../../ops/tables/outbox.ts']) {
      expect(Object.keys(sources)).toContain(f)
    }
    expect(Object.keys(sources).some(f => f.startsWith('../../worker/'))).toBe(true)
    const naming = Object.entries(sources).filter(([, text]) => text.includes(BINDING)).map(([f]) => f)
    expect(naming).toEqual(['./dispatch.ts'])
  })
})

describe("the egress's deps (failure 2)", () => {
  it('never hold the write binding or the env', () => {
    const write = { trap: BINDING }
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
    for (const testBuild of [undefined, '1']) {
      const fakeEnv = { ...(env as unknown as Record<string, unknown>), [BINDING]: write, INHOUSE_TEST_BUILD: testBuild } as unknown as Env
      const all = reachable(egressDeps(fakeEnv, ctx, { runner: 'runner-test' } as never))
      expect(all).not.toContain(write)
      expect(all).not.toContain(fakeEnv)
    }
  })
})
