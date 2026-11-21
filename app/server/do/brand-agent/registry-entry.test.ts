// The BrandAgent's `do` registry entry (ops/tables/chat.ts; P8 builds retention and person deletion on it). Ways it can
// fail: a person key names a table or column the object's SQLite doesn't have (a rename the entry missed), or a column
// that holds a member id isn't listed. The expected list is written here by hand from the schema (p3-design 4.1).
import { describe, expect, it } from 'vitest'
import { chatTables } from '../../../ops/tables/chat.ts'
import { inAgent } from '../../testing/brand-agent/core-harness.ts'

describe('the BrandAgent registry entry', () => {
  const entry = chatTables.find(e => e.kind === 'do' && e.name === 'BrandAgent')!
  it('lists every place the object keeps a member id', () => {
    expect([...entry.personKeys].sort()).toEqual([
      'authority.id', 'chat_state.owner_id', 'events.json:$.by', 'flags.value', 'run_tokens.member_id', 'runs.owner_id', 'turns.owner_id',
    ])
  })
  it('names only tables and columns the object has', () => inAgent(async h => {
    for (const key of entry.personKeys) {
      const [table, rest] = key.split('.')
      const column = rest.split(':')[0]
      const cols = h.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().map(r => r.name)
      expect(cols, key).toContain(column)
    }
  }))
})
