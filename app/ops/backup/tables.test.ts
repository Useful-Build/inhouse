// The backup's table rules for every canonical table (P8 C1's first PR: P3 and P4's tables). Ways it can fail, written
// down first:
//  1. a rule's `orderBy` isn't its table's primary key, so parts page or a restore matches rows by the wrong key;
//  2. a rule's `after` misses a table its foreign keys reference, so a restore inserts a child before its parent and
//     D1 refuses it;
//  3. an `r2KeyColumns` entry isn't a column, so a missing object goes unreported;
//  4. an `append_only` table is updated somewhere, or its key isn't one integer column, so the rows read after the
//     point batch aren't the rows at the point;
//  5. an `insert_only` table is updated somewhere, or its creation column isn't a column, so a row read after the point
//     batch may have changed since it;
//  6. a table with unbounded text columns is read 5,000 rows a page, so one page can pass D1's 50 MB result limit.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { READ_PAGE_ROWS } from './format.ts'
import { TABLE_RULES } from './tables.ts'

const db = env.DB
const serverSources = import.meta.glob<string>(['../../server/**/*.ts', '!../../server/**/*.test.ts', '!../../server/testing/**', '!../../server/**/test-*.ts'], { query: '?raw', import: 'default', eager: true })

type Column = { name: string; type: string; pk: number }
const columnsOf = async (table: string) => (await db.prepare(`PRAGMA table_info("${table}")`).all<Column>()).results

describe('the table rules (failures 1 to 3)', () => {
  it('orders every table by its whole primary key, in key order, and names only real R2 key columns', async () => {
    const wrong: string[] = []
    for (const r of TABLE_RULES) {
      const columns = await columnsOf(r.name)
      const pk = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name)
      if (JSON.stringify(pk) !== JSON.stringify(r.orderBy)) wrong.push(`${r.name}: orderBy [${r.orderBy.join(', ')}], key [${pk.join(', ')}]`)
      for (const k of r.r2KeyColumns ?? []) if (!columns.some(c => c.name === k)) wrong.push(`${r.name}: r2KeyColumns ${k}`)
    }
    expect(wrong).toEqual([])
  })

  it('restores every table after every table its foreign keys reference', async () => {
    const missing: string[] = []
    for (const r of TABLE_RULES) {
      const refs = (await db.prepare(`PRAGMA foreign_key_list("${r.name}")`).all<{ table: string }>()).results.map(f => f.table)
      for (const ref of new Set(refs)) if (ref !== r.name && !(r.after ?? []).includes(ref)) missing.push(`${r.name} after ${ref}`)
    }
    expect(missing).toEqual([])
  })
})

describe('append-only tables (failure 4)', () => {
  it('keys each append_only table by one integer column, and no product source updates or replaces its rows', async () => {
    const appendOnly = TABLE_RULES.filter(r => r.mode === 'append_only')
    expect(appendOnly.map(r => r.name).sort()).toEqual(['activity_lines', 'audit_log', 'chat_messages', 'egress_fetches'])
    const found: string[] = []
    for (const r of appendOnly) {
      const pk = (await columnsOf(r.name)).filter(c => c.pk > 0)
      if (pk.length !== 1 || pk[0].type.toUpperCase() !== 'INTEGER' || r.orderBy[0] !== pk[0].name) found.push(`${r.name}: key isn't one integer column`)
      const writes = new RegExp(`\\bUPDATE\\s+(?:OR\\s+\\w+\\s+)?"?${r.name}\\b|\\bREPLACE\\s+INTO\\s+"?${r.name}\\b|\\bINSERT\\s+OR\\s+REPLACE\\s+INTO\\s+"?${r.name}\\b|\\bINSERT\\s+INTO\\s+"?${r.name}\\b[^;]{0,2000}?\\bON\\s+CONFLICT\\b[^;]{0,200}?\\bDO\\s+UPDATE\\b`, 'i')
      for (const [path, source] of Object.entries(serverSources)) if (writes.test(source)) found.push(`${r.name}: ${path}`)
    }
    expect(Object.keys(serverSources).length).toBeGreaterThan(50)
    expect(found).toEqual([])
  })
})

describe('insert-only tables (failure 5)', () => {
  it('names a real creation column for each insert_only table, and no product source updates or replaces its rows', async () => {
    const insertOnly = TABLE_RULES.filter(r => r.mode === 'insert_only')
    expect(insertOnly.map(r => r.name).sort()).toEqual(['notice_reads', 'tool_calls'])
    const found: string[] = []
    for (const r of insertOnly) {
      if (!r.createdColumn || !(await columnsOf(r.name)).some(c => c.name === r.createdColumn)) found.push(`${r.name}: createdColumn`)
      const writes = new RegExp(`\\bUPDATE\\s+(?:OR\\s+\\w+\\s+)?"?${r.name}\\b|\\bREPLACE\\s+INTO\\s+"?${r.name}\\b|\\bINSERT\\s+OR\\s+REPLACE\\s+INTO\\s+"?${r.name}\\b|\\bINSERT\\s+INTO\\s+"?${r.name}\\b[^;]{0,2000}?\\bON\\s+CONFLICT\\b[^;]{0,200}?\\bDO\\s+UPDATE\\b`, 'i')
      for (const [path, source] of Object.entries(serverSources)) if (writes.test(source)) found.push(`${r.name}: ${path}`)
    }
    expect(found).toEqual([])
  })
})

describe('read pages (failure 6)', () => {
  it('reads the tables with unbounded text columns at most 500 rows a page, and no table more than 5,000', () => {
    for (const name of ['chat_messages', 'routine_slots', 'today_items', 'notices']) expect(TABLE_RULES.find(r => r.name === name)?.pageRows, name).toBeLessThanOrEqual(500)
    for (const r of TABLE_RULES) expect(r.pageRows ?? READ_PAGE_ROWS, r.name).toBeLessThanOrEqual(5_000)
  })
})
