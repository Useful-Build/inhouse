// The release step's first-Admin SQL (server/seed/first-admin.ts) run the way `wrangler d1 execute --file` runs a file:
// the whole text at once, through SQLite itself (node:sqlite: this test needs the node project, and ops/ is the node
// project's folder whose typecheck has the Worker's types the seed code uses). Ways it can fail, written down first:
//  1. a name or title with quotes, newlines, CR, tabs, NBSP, emoji or other code points breaks the file or is stored
//     altered (a literal split on a newline or a `;`, a quote unescaped);
//  2. running the same file twice invites twice or logs twice.
import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { firstAdminSql } from '../../server/seed/first-admin.ts'

// Through a variable, so this program needs no Node types (tsconfig.server.json has none).
const sqliteModule = 'node:sqlite'
const { DatabaseSync } = (await import(/* @vite-ignore */ sqliteModule)) as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[] }; close(): void }
}
const migrations = import.meta.glob<string>('../../server/migrations/*.sql', { query: '?raw', import: 'default', eager: true })

const fresh = () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const file of Object.keys(migrations).sort()) db.exec(migrations[file])
  return db
}

const special = fc.constantFrom('\n', '\r', '\r\n', '\t', '\u00a0', '\u200b', '\u2028', "'", "''", '"', ';', '--', '/*', '?', '\u{1F600}', 'e\u0301', '\u202e')
const char = fc.oneof(special, fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }))
const textArb = fc.array(char, { minLength: 1, maxLength: 40 }).map(cs => cs.join(''))
  .filter(s => !s.includes('\0') && s.trim().length >= 1 && s.trim().length <= 80)

describe('the first Admin SQL file', () => {
  test.prop([textArb, fc.option(textArb, { nil: undefined })], { numRuns: 200 })('runs whole through SQLite, twice, and stores every value exactly once (failures 1, 2)', (name, title) => {
    const db = fresh()
    try {
      const file = firstAdminSql({ name, email: 'first@example.test', ...(title === undefined ? {} : { title }) }, 1_800_000_000_000).join('\n')
      db.exec(file)
      db.exec(file)
      const rows = db.prepare("SELECT id, name, title, role, status FROM members WHERE kind = 'person'").all()
      expect(rows).toEqual([{ id: expect.any(String), name: name.trim(), title: title === undefined ? null : title.trim(), role: 'admin', status: 'invited' }])
      const lines = db.prepare('SELECT action, actor_id, args_json FROM audit_log').all()
      expect(lines).toEqual([{ action: 'member.invited', actor_id: 'm_system', args_json: JSON.stringify({ memberId: rows[0].id, role: 'admin' }) }])
    } finally {
      db.close()
    }
  })
})
