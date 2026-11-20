// The table registry's person keys against the schema as migrated (ops/tables/completeness.test.ts checks the names).
// Ways it can fail, written down first:
//  1. a person key names a column its table doesn't have (a typo, a renamed column): P8's export and deletion miss it;
//  2. a member id the audit log holds (target_id, an argument such as memberId or replaces) isn't listed as a key.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { AuditArgsSchema } from '../../shared/contract/audit.ts'
import { MemberIdSchema } from '../../shared/contract/members.ts'
import { tables } from '../../ops/tables/index.ts'

const columns = async (table: string) => (await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map(c => c.name)

describe('person keys', () => {
  it('every d1 person key is a column of its table (failure 1)', async () => {
    const bad: string[] = []
    for (const e of tables.filter(t => t.kind === 'd1')) {
      const cols = await columns(e.name)
      expect(cols.length, e.name).toBeGreaterThan(0)
      for (const key of e.personKeys) if (!cols.includes(key.split(':')[0])) bad.push(`${e.name}.${key}`)
    }
    expect(bad).toEqual([])
  })

  it("audit_log lists target_id and every argument that holds a member id (failure 2)", () => {
    const audit = tables.find(t => t.kind === 'd1' && t.name === 'audit_log')!
    const memberArgs = new Set<string>()
    for (const option of AuditArgsSchema.options) {
      for (const [field, schema] of Object.entries(option.shape)) {
        const inner = (schema as { unwrap?: () => unknown }).unwrap?.() ?? schema
        if (inner === MemberIdSchema) memberArgs.add(field)
      }
    }
    expect([...memberArgs].sort()).toEqual(['memberId', 'replaces'])
    expect(audit.personKeys).toEqual(expect.arrayContaining(['actor_id', 'target_id', ...[...memberArgs].map(f => `args_json:$.${f}`)]))
  })
})
