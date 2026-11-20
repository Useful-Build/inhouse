// The registry is complete (P2 plan, "The table registry"; P8 acceptance 2). Ways it can fail, written down first:
//  1. a migration creates a D1 table that has no entry;
//  2. wrangler.product.jsonc binds a Durable Object class that has no entry;
//  3. server/db/r2-keys.ts names an R2 prefix that has no entry;
//  4. an entry names nothing (a dropped table, a renamed class, a typo), or two entries name one store.
import { describe, expect, it } from 'vitest'
import productConfig from '../../wrangler.product.jsonc?raw'
import { R2_PREFIXES } from '../../server/db/r2-keys.ts'
import { tables } from './index.ts'
import type { TableEntry } from './types.ts'

const registry = tables as readonly TableEntry[]
// Read through Vite (no node types in this program): every migration file's text, by path.
const migrations = import.meta.glob<string>('../../server/migrations/*.sql', { query: '?raw', import: 'default', eager: true })

/** Every `CREATE TABLE` across the migrations (comments stripped), D1's own `d1_*` and `sqlite_*` tables aside. */
function d1Tables(): string[] {
  const names: string[] = []
  for (const file of Object.keys(migrations).sort()) {
    const sql = migrations[file].replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of sql.matchAll(/CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)/gi)) names.push(m[1])
  }
  return names.filter(n => !/^(d1|sqlite)_/i.test(n))
}

/** Every Durable Object class the product config binds or migrates (comments stripped). */
function doClasses(): string[] {
  const text = productConfig.replace(/^\s*\/\/[^\n]*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const names = new Set<string>()
  for (const m of text.matchAll(/"class_name"\s*:\s*"(\w+)"/g)) names.add(m[1])
  for (const m of text.matchAll(/"new_(?:sqlite_)?classes"\s*:\s*\[([^\]]*)\]/g)) for (const c of m[1].matchAll(/"(\w+)"/g)) names.add(c[1])
  return [...names]
}

const sources = (): Record<TableEntry['kind'], string[]> => ({ d1: d1Tables(), do: doClasses(), r2: [...R2_PREFIXES] })

describe('the table registry', () => {
  it('finds the stores it checks (the parsers still read the files)', () => {
    expect(d1Tables()).toEqual(expect.arrayContaining(['members', 'settings', 'support_grants', 'audit_log']))
    expect(R2_PREFIXES).toContain('photos/')
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
