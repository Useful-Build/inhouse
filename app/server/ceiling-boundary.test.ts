// The ceiling's one writer (Stage 1 M3-C, N26; #439 P9). Writes stay off (N2): an operation exists for a brand only
// through its `permission_ceiling` row, so only permissions/ceiling.ts may write that table, only the Inhouse team's
// route (api/ceiling.ts, through its store), the test build's hook (ops/test-fakes.ts) and the eval door may import
// that writer, and no migration inserts a row. oxlint has no rule for SQL in a string, so this scans the sources, as outbox/boundary.test.ts
// does for the write binding. Ways it can fail:
//  1. another module writes the table with its own SQL (an INSERT, UPDATE, DELETE or REPLACE), so a change skips
//     `lowered_rev`, the `rev` check or the audit line;
//  2. another module imports the writer, so a new path could turn an operation on;
//  3. a migration seeds a row, so a deployable build has an operation on from its first boot;
//  4. the tests' own row helper (permissions/test-support.ts) reaches a non-test module.
import { describe, expect, it } from 'vitest'

const glob = {
  ...import.meta.glob<string>(['./**/*.ts', '!./**/*.d.ts'], { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>('../shared/**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>('../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>('../worker/**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>('../ops/**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>('../evals/**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>('../hub/**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>('../test/**/*.ts', { query: '?raw', import: 'default', eager: true }),
}
const migrations = import.meta.glob<string>('./migrations/*.sql', { query: '?raw', import: 'default', eager: true })

/** A test, or a test's helper: these write rows directly by design (N2). */
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || f.endsWith('/test-support.ts') || f.endsWith('/test-arbitraries.ts')
const sources = Object.fromEntries(Object.entries(glob).filter(([f]) => !isTest(f) && !f.includes('/node_modules/')))

const WRITER = './permissions/ceiling.ts'
/**
 * The modules that may import the writer (N26): the route's store (api/ceiling-store.ts, split from api/ceiling.ts so
 * the stores load in plain Node) and the test build's hook.
 */
const IMPORTERS = ['./api/ceiling-store.ts', './ops/test-fakes.ts']
/**
 * The eval door (M3-R, Q3 = D): the harness seeds and resets the eval deployment's ceiling through `wrangler d1 execute`
 * from Node, so it can't import the Worker's writer and writes its own SQL. It is the one named exception (N26 lets the
 * eval door set rows), and only it.
 */
const EVAL_DOOR = '../evals/targets/write-door.ts'

/** SQL that changes the table, in any case and spacing. */
const WRITES = /\b(INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?permission_ceiling\b/i
/** An import (static or dynamic) of server/permissions/ceiling.ts, from wherever the importer sits. */
const importsWriter = (f: string, text: string) => {
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1]!)
  return specs.some(s => resolve(f, s) === WRITER)
}
/** `spec` from `from` as a path relative to server/ (the glob's keys), with `.ts` added when it has no extension. */
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const parts = from.split('/').slice(0, -1)
  for (const seg of spec.split('/')) {
    if (seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  const path = parts.join('/')
  return /\.[cm]?[jt]sx?$/.test(path) ? path : `${path}.ts`
}

describe('the ceiling has one writer', () => {
  it('the scan covers the folders it should', () => {
    const keys = Object.keys(sources)
    for (const f of [WRITER, ...IMPORTERS, './api/ceiling.ts', './notify-slack/alerts-grant.ts', './api/tools-accounts.ts', '../shared/contract/ceiling.ts', '../src/screens/settings/Ceiling.tsx']) {
      expect(keys).toContain(f)
    }
    for (const dir of ['../worker/', '../ops/', '../evals/', '../hub/', '../test/']) expect(keys.some(f => f.startsWith(dir)), dir).toBe(true)
    expect(Object.keys(migrations).length).toBeGreaterThan(10)
  })

  it('only permissions/ceiling.ts writes permission_ceiling (failure 1)', () => {
    expect(WRITES.test('INSERT INTO permission_ceiling (operation)')).toBe(true)
    expect(WRITES.test('update  Permission_Ceiling set enabled = 0')).toBe(true)
    expect(WRITES.test('SELECT per_day_max FROM permission_ceiling')).toBe(false)
    const writing = Object.entries(sources).filter(([f, text]) => f !== EVAL_DOOR && WRITES.test(text)).map(([f]) => f)
    expect(writing).toEqual([WRITER])
  })

  it('only the route, the test build hook and the eval door import the writer (failure 2)', () => {
    expect(resolve('./api/ceiling.ts', '../permissions/ceiling.ts')).toBe(WRITER)
    expect(resolve('./permissions/x.ts', './ceiling')).toBe(WRITER)
    const importing = Object.entries(sources).filter(([f, text]) => f !== EVAL_DOOR && importsWriter(f, text)).map(([f]) => f).sort()
    expect(importing).toEqual([...IMPORTERS].sort())
  })

  it('no migration inserts a ceiling row (failure 3)', () => {
    const seeding = Object.entries(migrations).filter(([, sql]) => /\b(INSERT|REPLACE)\b[^;]*\bpermission_ceiling\b/i.test(sql)).map(([f]) => f)
    expect(seeding).toEqual([])
  })

  it("the tests' row helper is imported by tests only (failure 4)", () => {
    const helper = './permissions/test-support.ts'
    const importing = Object.entries(sources).filter(([f, text]) =>
      [...text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].some(m => resolve(f, m[1]!) === helper)).map(([f]) => f)
    expect(importing).toEqual([])
  })
})
