// The ceiling's one writer (Stage 1 M3-C, N26; #439 P9). Writes stay off (N2): an operation exists for a brand only
// through its `permission_ceiling` row, so only permissions/ceiling.ts may write that table, only the Inhouse team's
// route (api/ceiling.ts, through its store), the test build's hook (ops/test-fakes.ts) and the eval door may import
// that writer, only the route calls the store's `set`, and no migration inserts a row. oxlint has no rule for SQL in a
// string, so this scans every source file under app/ (the Worker, the hub, the runner, ops, evals, scripts, e2e kits and
// the client alike), as outbox/boundary.test.ts does for the write binding. Every path is resolved relative to app/, so
// an import from any folder into any other is seen. Ways it can fail:
//  1. another module writes the table with its own SQL (an INSERT, UPDATE, DELETE or REPLACE), so a change skips
//     `lowered_rev`, the `rev` check or the audit line;
//  2. another module imports the writer, so a new path could turn an operation on;
//  3. a migration seeds a row, so a deployable build has an operation on from its first boot;
//  4. the tests' own row helper (permissions/test-support.ts) reaches a non-test module;
//  5. another module calls the store's `set` (`Stores.ceiling.set`), a second path to the writer (#520; the store also
//     refuses while editing is off, server/api/ceiling.test.ts);
//  6. the scan itself goes blind: an import from another folder (app/ops, app/hub) isn't resolved to the file it names.
import { describe, expect, it } from 'vitest'

/** Every source file under app/, keyed as the glob gives it (relative to this file). Build output and installs aside. */
const glob = import.meta.glob<string>([
  '../**/*.{ts,tsx,mts,cts,js,mjs,cjs}',
  '!../**/node_modules/**', '!../**/dist/**', '!../**/*.d.ts',
  '!../e2e-artifacts/**', '!../test-results/**', '!../playwright-report/**', '!../coverage/**',
], { query: '?raw', import: 'default', eager: true })
const migrations = import.meta.glob<string>('./migrations/*.sql', { query: '?raw', import: 'default', eager: true })

/** `a/b/../c/./d` as `a/c/d`; a path that climbs out of app/ keeps its climb (it names nothing scanned). */
function normalise(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}
/** A glob key as a path relative to app/: `./x` is server/x, `../x` is x. */
const appPath = (key: string): string => normalise(`server/${key}`)

/** A test, or a test's helper: these write rows directly by design (N2). */
const isTest = (f: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || f.endsWith('/test-support.ts') || f.endsWith('/test-arbitraries.ts')
const all = Object.fromEntries(Object.entries(glob).map(([k, v]) => [appPath(k), v]))
const sources = Object.fromEntries(Object.entries(all).filter(([f]) => !isTest(f)))

const WRITER = 'server/permissions/ceiling.ts'
const HELPER = 'server/permissions/test-support.ts'
/**
 * The modules that may import the writer (N26): the route's store (api/ceiling-store.ts, split from api/ceiling.ts so
 * the stores load in plain Node) and the test build's hook.
 */
const IMPORTERS = ['server/api/ceiling-store.ts', 'server/ops/test-fakes.ts']
/**
 * The eval door (M3-R, Q3 = D): the harness seeds and resets the eval deployment's ceiling through `wrangler d1 execute`
 * from Node, so it can't import the Worker's writer and writes its own SQL. It is the one named exception (N26 lets the
 * eval door set rows), and only it.
 */
const EVAL_DOOR = 'evals/targets/write-door.ts'
/** The one caller of the store's `set` (route 151). */
const SET_CALLER = 'server/api/ceiling.ts'

/** SQL that changes the table, in any case and spacing. */
const WRITES = /\b(INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?permission_ceiling\b/i
/** A call of the ceiling store's `set`, however it is reached (`stores.ceiling.set(`, `ceiling .set (`, `ceiling?.set(`). */
const CALLS_SET = /\bceiling\s*\??\.\s*set\s*\(/

/** The specifiers a module imports: statically, dynamically, for its side effects or re-exported. */
const specifiers = (text: string) => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map(m => m[1]!)

/** `spec` imported by `from` (both relative to app/) as a path relative to app/, `.ts` added when it has no extension. */
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const path = normalise(`${from.split('/').slice(0, -1).join('/')}/${spec}`)
  return /\.[cm]?[jt]sx?$/.test(path) ? path : `${path}.ts`
}
/** The modules in `from` (the non-test sources unless given) that import `target`. */
const importersOf = (target: string, from: Record<string, string> = sources) =>
  Object.entries(from).filter(([f, text]) => specifiers(text).some(s => resolve(f, s) === target)).map(([f]) => f).sort()

describe('the scan sees all of app/ (failure 6)', () => {
  it('covers every folder, keyed relative to app/', () => {
    const keys = Object.keys(sources)
    for (const f of [WRITER, ...IMPORTERS, SET_CALLER, 'server/notify-slack/alerts-grant.ts', 'shared/contract/ceiling.ts', 'src/screens/settings/Ceiling.tsx']) {
      expect(keys).toContain(f)
    }
    for (const dir of ['server/', 'shared/', 'src/', 'worker/', 'ops/', 'evals/', 'hub/', 'runner/', 'test/', 'scripts/', 'e2e/']) {
      expect(keys.some(f => f.startsWith(dir)), dir).toBe(true)
    }
    expect(keys.some(f => f.includes('node_modules/'))).toBe(false)
    expect(Object.keys(all)).toContain(HELPER)
    expect(Object.keys(migrations).length).toBeGreaterThan(10)
  })

  it('resolves an import from any folder to the file it names', () => {
    expect(resolve('server/api/ceiling-store.ts', '../permissions/ceiling.ts')).toBe(WRITER)
    expect(resolve('server/permissions/x.ts', './ceiling')).toBe(WRITER)
    expect(resolve('ops/backup/x.ts', '../../server/permissions/ceiling.ts')).toBe(WRITER)
    expect(resolve('hub/connectors/x/y.ts', '../../../server/permissions/ceiling')).toBe(WRITER)
    expect(resolve('worker/index.ts', '../server/permissions/ceiling')).toBe(WRITER)
    expect(resolve('ops/x.ts', 'zod')).toBeNull()
  })

  it("finds a planted import of the writer or the tests' helper from ops, hub, evals, src, worker and test", () => {
    const planted: Record<string, string> = {
      'ops/planted/x.ts': "import { setCeilingStmt } from '../../server/permissions/ceiling.ts'\n",
      'hub/planted/x.ts': "const m = await import('../../server/permissions/ceiling.ts')\n",
      'evals/planted/x.ts': "export { setCeilingStmt } from '../../server/permissions/ceiling'\n",
      'src/planted/x.tsx': "import { ceiling } from '../../server/permissions/test-support.ts'\n",
      'worker/planted.ts': "import '../server/permissions/test-support.ts'\n",
      'test/planted/x.ts': "import { setCeilingStmt } from '../../server/permissions/ceiling.ts'\n",
    }
    expect(importersOf(WRITER, planted)).toEqual(['evals/planted/x.ts', 'hub/planted/x.ts', 'ops/planted/x.ts', 'test/planted/x.ts'])
    expect(importersOf(HELPER, planted)).toEqual(['src/planted/x.tsx', 'worker/planted.ts'])
  })
})

describe('the ceiling has one writer', () => {
  it('only permissions/ceiling.ts writes permission_ceiling (failure 1)', () => {
    expect(WRITES.test('INSERT INTO permission_ceiling (operation)')).toBe(true)
    expect(WRITES.test('update  Permission_Ceiling set enabled = 0')).toBe(true)
    expect(WRITES.test('SELECT per_day_max FROM permission_ceiling')).toBe(false)
    const writing = Object.entries(sources).filter(([f, text]) => f !== EVAL_DOOR && WRITES.test(text)).map(([f]) => f)
    expect(writing).toEqual([WRITER])
  })

  it("only the route's store, the test build hook and the eval door import the writer (failure 2)", () => {
    expect(importersOf(WRITER).filter(f => f !== EVAL_DOOR)).toEqual([...IMPORTERS].sort())
  })

  it('no migration inserts a ceiling row (failure 3)', () => {
    const seeding = Object.entries(migrations).filter(([, sql]) => /\b(INSERT|REPLACE)\b[^;]*\bpermission_ceiling\b/i.test(sql)).map(([f]) => f)
    expect(seeding).toEqual([])
  })

  it("the tests' row helper is imported by tests only (failure 4)", () => {
    expect(importersOf(HELPER)).toEqual([])
  })

  it("only route 151 calls the store's set (failure 5)", () => {
    expect(CALLS_SET.test('await storesOf(c).ceiling.set({ operation }, at)')).toBe(true)
    expect(CALLS_SET.test('stores.ceiling?.set(x)')).toBe(true)
    expect(CALLS_SET.test('ceilingRows.set(k, v)')).toBe(false)
    const calling = Object.entries(sources).filter(([, text]) => CALLS_SET.test(text)).map(([f]) => f)
    expect(calling).toEqual([SET_CALLER])
  })
})
