// The registry is complete (P2 plan, "The table registry"; P8 acceptance 2). Ways it can fail, written down first:
//  1. a migration creates a D1 table that has no entry;
//  2. wrangler.product.jsonc binds a Durable Object class that has no entry;
//  3. server/db/r2-keys.ts names an R2 prefix that has no entry, or the code writes R2 keys that don't go through it
//     (a module using the bucket without r2-keys.ts, a key builder whose key is under no listed prefix);
//  4. an entry names nothing (a dropped table, a renamed class, a typo), or two entries name one store;
//  5. a migration creates a virtual table (FTS5) that isn't registered, or whose entry isn't `derived` (P8: the backup
//     skips a derived table and a restore rebuilds it; anything else must be backed up, which a virtual table can't be);
//     or a `derived` entry names a table the migrations create as a plain table (it would never be backed up).
import { describe, expect, it } from 'vitest'
import productConfig from '../../wrangler.product.jsonc?raw'
import * as r2Keys from '../../server/db/r2-keys.ts'
import { R2_PREFIXES } from '../../server/db/r2-keys.ts'
import { tables } from './index.ts'
import type { TableEntry } from './types.ts'

const registry = tables as readonly TableEntry[]
// Read through Vite (no node types in this program): every migration file's text, by path.
const migrations = import.meta.glob<string>('../../server/migrations/*.sql', { query: '?raw', import: 'default', eager: true })
const serverSources = import.meta.glob<string>(['../../server/**/*.ts', '!../../server/**/*.test.ts'], { query: '?raw', import: 'default', eager: true })
// P8's jobs (ops/backup, retention, export, delete) write R2 too: the same rule covers every non-test module under ops/.
const opsSources = import.meta.glob<string>(['../../ops/**/*.ts', '!../../ops/**/*.test.ts'], { query: '?raw', import: 'default', eager: true })

/**
 * Every `CREATE [VIRTUAL] TABLE` across the migrations (comments stripped), D1's own `d1_*` and `sqlite_*` tables
 * aside, with whether it's virtual. `files` defaults to the real migrations; the test plants fixtures through it.
 */
function d1TableDefs(files: Record<string, string> = migrations): { name: string; virtual: boolean }[] {
  const defs: { name: string; virtual: boolean }[] = []
  for (const file of Object.keys(files).sort()) {
    const sql = files[file].replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of sql.matchAll(/CREATE\s+(VIRTUAL\s+|TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)/gi)) {
      defs.push({ name: m[2], virtual: /^VIRTUAL/i.test(m[1] ?? '') })
    }
  }
  return defs.filter(d => !/^(d1|sqlite)_/i.test(d.name))
}
const d1Tables = (files?: Record<string, string>): string[] => d1TableDefs(files).map(d => d.name)

/** The `derived` entries whose table the migrations create as a plain table, not a virtual one (failure 5). */
const derivedNotVirtual = (files: Record<string, string>, reg: readonly TableEntry[]): string[] =>
  reg.filter(e => e.kind === 'd1' && e.derived && d1TableDefs(files).some(d => d.name === e.name && !d.virtual)).map(e => e.name)

/** The migrations' virtual tables whose registry entry is missing or isn't `derived` (failure 5). */
const virtualNotDerived = (files: Record<string, string>, reg: readonly TableEntry[]): string[] =>
  d1TableDefs(files).filter(d => d.virtual && !reg.some(e => e.kind === 'd1' && e.name === d.name && e.derived)).map(d => d.name)

/** Every Durable Object class a wrangler config binds or migrates (comments stripped). */
function doClasses(config: string = productConfig): string[] {
  const text = config.replace(/^\s*\/\/[^\n]*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const names = new Set<string>()
  for (const m of text.matchAll(/"class_name"\s*:\s*"(\w+)"/g)) names.add(m[1])
  for (const m of text.matchAll(/"new_(?:sqlite_)?classes"\s*:\s*\[([^\]]*)\]/g)) for (const c of m[1].matchAll(/"(\w+)"/g)) names.add(c[1])
  return [...names]
}

/**
 * Whether a module's text uses an R2 bucket (an `R2Bucket` value, or the `FILES` binding's methods). Exempt: the
 * binding's declaration (worker-configuration.d.ts) and the list that keeps it off handlers' env (routes.ts).
 */
const usesR2 = (text: string) => /\bR2Bucket\b|\bFILES\s*\.\s*(put|get|delete|list|head|createMultipartUpload)\b/.test(text)
const R2_EXEMPT = ['/server/worker-configuration.d.ts', '/server/routes.ts', '/server/db/r2-keys.ts']
const importsR2Keys = (text: string) => /from\s+['"][./]*(?:server\/)?(?:db\/)?r2-keys\.ts['"]/.test(text)

const sources = (): Record<TableEntry['kind'], string[]> => ({ d1: d1Tables(), do: doClasses(), r2: [...R2_PREFIXES] })

describe('the table registry', () => {
  it('finds the stores it checks (the parsers still read the files)', () => {
    expect(d1Tables()).toEqual(expect.arrayContaining(['members', 'settings', 'support_grants', 'audit_log']))
    expect(R2_PREFIXES).toContain('photos/')
  })

  it('reads Durable Object classes from a config that has them (the reader is proven, not vacuous)', () => {
    const fixture = `{
      // a comment with "class_name": "Commented"
      "durable_objects": { "bindings": [{ "name": "AGENT", "class_name": "BrandAgent" }] },
      "migrations": [{ "tag": "v1", "new_sqlite_classes": ["BrandAgent", "SessionStore"] }, { "tag": "v2", "new_classes": ["Legacy"] }]
    }`
    expect(doClasses(fixture).sort()).toEqual(['BrandAgent', 'Legacy', 'SessionStore'])
  })

  it('every module that writes R2 builds its keys through r2-keys.ts, under a listed prefix (failure 3)', () => {
    const files = Object.keys(serverSources)
    expect(files.length).toBeGreaterThan(10)
    const offenders = files.filter(f => !R2_EXEMPT.some(e => f.endsWith(e)) && usesR2(serverSources[f]) && !importsR2Keys(serverSources[f]))
    expect(offenders).toEqual([])
    // The detector itself, on fixtures.
    expect(usesR2("await env.FILES.put(`photos/${id}`, body)")).toBe(true)
    expect(usesR2('function store(bucket: R2Bucket) {}')).toBe(true)
    expect(usesR2("const k = 'FILES'")).toBe(false)
    expect(importsR2Keys("import { photoKey } from '../db/r2-keys.ts'")).toBe(true)
    expect(importsR2Keys("import { backupManifestKey } from '../../server/db/r2-keys.ts'")).toBe(true)
    // Every key builder's key sits under a listed prefix.
    const builders = Object.entries(r2Keys).filter(([, v]) => typeof v === 'function') as [string, (...a: string[]) => string][]
    expect(builders.map(([n]) => n)).toContain('photoKey')
    for (const [name, build] of builders) expect(R2_PREFIXES.some(p => build('m_x', 'r', 's').startsWith(p)), name).toBe(true)
  })

  it('every ops/ module that writes R2 builds its keys through r2-keys.ts (failure 3, P8)', () => {
    const files = Object.keys(opsSources)
    expect(files.length).toBeGreaterThan(3)
    const offenders = files.filter(f => usesR2(opsSources[f]) && !importsR2Keys(opsSources[f]))
    expect(offenders).toEqual([])
  })

  for (const kind of ['d1', 'do', 'r2'] as const) {
    it(`registers every ${kind} store (failures 1 to 3)`, () => {
      const missing = sources()[kind].filter(name => !registry.some(e => e.kind === kind && e.name === name))
      expect(missing, `not in ops/tables (add an entry with its retention class, person key and export flag)`).toEqual([])
    })
  }

  it('registers every virtual table as derived (failure 5, P8)', () => {
    expect(virtualNotDerived(migrations, registry)).toEqual([])
    // Red on a planted migration (test input only, never a real migration file): an FTS5 table with no entry fails
    // both the d1 check and this one; with a plain entry it still fails here; with a derived entry it passes.
    const planted = { ...migrations, '../../server/migrations/0699_planted.sql': 'CREATE VIRTUAL TABLE planted_search USING fts5(body);' }
    expect(d1Tables(planted)).toContain('planted_search')
    expect(d1Tables(planted).filter(n => !registry.some(e => e.kind === 'd1' && e.name === n))).toEqual(['planted_search'])
    expect(virtualNotDerived(planted, registry)).toEqual(['planted_search'])
    const plain: TableEntry = { kind: 'd1', name: 'planted_search', retention: 'config', personKeys: [], export: false }
    expect(virtualNotDerived(planted, [...registry, plain])).toEqual(['planted_search'])
    expect(virtualNotDerived(planted, [...registry, { ...plain, derived: { from: ['settings'] } }])).toEqual([])
    // Derived means virtual: a derived entry over a plain table fails, red on a planted plain-table migration.
    expect(derivedNotVirtual(migrations, registry)).toEqual([])
    const plantedPlain = { ...migrations, '../../server/migrations/0699_planted.sql': 'CREATE TABLE planted_index (body TEXT);' }
    const derivedPlain: TableEntry = { kind: 'd1', name: 'planted_index', retention: 'config', personKeys: [], export: false, derived: { from: ['settings'] } }
    expect(derivedNotVirtual(plantedPlain, [...registry, derivedPlain])).toEqual(['planted_index'])
    expect(derivedNotVirtual(planted, [...registry, { ...derivedPlain, name: 'planted_search' }])).toEqual([])
    // A plain CREATE TABLE is never taken for a virtual one.
    expect(d1TableDefs({ x: 'CREATE TABLE IF NOT EXISTS plain_t (id TEXT);' })).toEqual([{ name: 'plain_t', virtual: false }])
  })

  it('has no entry that names nothing, and none twice (failure 4)', () => {
    const src = sources()
    expect(registry.filter(e => !src[e.kind].includes(e.name)).map(e => `${e.kind} ${e.name}`)).toEqual([])
    const keys = registry.map(e => `${e.kind} ${e.name}`)
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
  })
})
