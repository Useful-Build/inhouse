// The registry is complete (P2 plan, "The table registry"; P8 acceptance 2). Ways it can fail, written down first:
//  1. a migration creates a D1 table that has no entry;
//  2. wrangler.product.jsonc binds a Durable Object class that has no entry;
//  3. server/db/r2-keys.ts names an R2 prefix that has no entry, or the code writes R2 keys that don't go through it
//     (a module using the bucket without r2-keys.ts, a key builder whose key is under no listed prefix);
//  4. an entry names nothing (a dropped table, a renamed class, a typo), or two entries name one store.
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

/** Every `CREATE TABLE` across the migrations (comments stripped), D1's own `d1_*` and `sqlite_*` tables aside. */
function d1Tables(): string[] {
  const names: string[] = []
  for (const file of Object.keys(migrations).sort()) {
    const sql = migrations[file].replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of sql.matchAll(/CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)/gi)) names.push(m[1])
  }
  return names.filter(n => !/^(d1|sqlite)_/i.test(n))
}

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
    // One argument list every builder accepts: an id or a number where each takes one (deletionLogKey checks its numbers).
    const builders = Object.entries(r2Keys).filter(([, v]) => typeof v === 'function') as [string, (...a: (string | number)[]) => string][]
    expect(builders.map(([n]) => n)).toContain('photoKey')
    for (const [name, build] of builders) expect(R2_PREFIXES.some(p => build(1, 'r', 1, 's').startsWith(p)), name).toBe(true)
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

  it('has no entry that names nothing, and none twice (failure 4)', () => {
    const src = sources()
    expect(registry.filter(e => !src[e.kind].includes(e.name)).map(e => `${e.kind} ${e.name}`)).toEqual([])
    const keys = registry.map(e => `${e.kind} ${e.name}`)
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
  })
})
