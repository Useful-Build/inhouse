// The data map's store list (P8 C1, acceptance 11). Ways it can fail, written down first:
//  1. a registry entry has no row (a store the map doesn't mention), or a row lacks its kind, personal data, retention,
//     export or deletion;
//  2. docs/data-map.md's stores block drifts from the registry and rules (edited by hand, or not regenerated).
// Reads the doc through Vite (`?raw`), so it runs in the Workers project like the other coverage tests.
import { describe, expect, it } from 'vitest'
import dataMapDoc from '../../../../docs/data-map.md?raw'
import { tables } from '../../tables/index.ts'
import { TABLE_RULES } from '../../backup/tables.ts'
import { BACKUP_TEXT, NOTES, dataMapRows } from './data-map.ts'

const block = (doc: string) => {
  const m = /<!-- stores:start -->\n([\s\S]*?)\n?<!-- stores:end -->/.exec(doc)
  if (!m) throw new Error('docs/data-map.md has no stores markers')
  return m[1].trim()
}

describe('the data map', () => {
  it('every registry entry has a data map row with its kind, personal data, retention, export and deletion', () => {
    expect(tables.filter(e => !NOTES[e.name]).map(e => e.name)).toEqual([])
    expect(Object.keys(NOTES).filter(n => !tables.some(e => e.name === n))).toEqual([])
    const rows = dataMapRows(tables).split('\n').slice(2)
    expect(rows).toHaveLength(tables.length)
    for (const [i, row] of rows.entries()) {
      const cells = row.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim())
      expect(cells, tables[i].name).toHaveLength(9)
      for (const c of cells.slice(0, 8)) expect(c.length, `${tables[i].name}: ${row}`).toBeGreaterThan(0)
    }
    expect(() => dataMapRows([...tables, { kind: 'd1', name: 'later_store', retention: 'config', personKeys: [], export: false }])).toThrow(/later_store/)
  })

  it('says nothing internal: no people, review threads, decision codes, phase names or design-doc references (the doc is public)', () => {
    const banned = /Wasim|line [AB]\b|decision Q\d|\bQ\d+\b|p\d-design|p\d-w\d|section \d|\bon P\d|\bP\d\b|\bB\d\b|\b[CFG]\d\b|shapes\.md|#\d+|\d{4}-\d{2}-\d{2}/
    const hits = dataMapRows(tables).split('\n').filter(l => banned.test(l))
    expect(hits).toEqual([])
  })

  it('has a Backup column from the backup\'s own table rules: each canonical table\'s mode, each derived index rebuilt', () => {
    const rows = dataMapRows(tables).split('\n')
    expect(rows[0]).toContain('| Backup |')
    const cellOf = (name: string) => {
      const row = rows.find(r => r.startsWith(`| \`${name}\` |`))
      if (!row) throw new Error(`no row for ${name}`)
      const cells = row.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim())
      return cells[rows[0].split('|').slice(1, -1).map(c => c.trim()).indexOf('Backup')]
    }
    for (const r of TABLE_RULES) expect(cellOf(r.name), r.name).toBe(BACKUP_TEXT[r.mode])
    for (const e of tables.filter(t => t.derived)) expect(cellOf(e.name), e.name).toBe('Rebuilt from its source after a restore')
  })

  it('the block between the stores markers in docs/data-map.md equals dataMapRows(tables)', () => {
    expect(block(dataMapDoc)).toBe(dataMapRows(tables))
  })
})
