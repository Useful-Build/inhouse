// The table registry's person keys against the schema as migrated (ops/tables/completeness.test.ts checks the names).
// Ways it can fail, written down first:
//  1. a person key names a column its table doesn't have (a typo, a renamed column): P8's export and deletion miss it;
//  2. a member id the audit log holds (target_id, an argument such as memberId or replaces) isn't listed as a key;
//  3. a setting whose value can be a member id (an approver) isn't covered: settings.value_json and the
//     setting.changed line's args_json:$.value must be keys whenever any setting spec accepts a member id.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { AuditArgsSchema } from '../../shared/contract/audit.ts'
import { MemberIdSchema } from '../../shared/contract/members.ts'
import { SETTING_KEY_EXAMPLES, settingSpec } from '../../shared/contract/settings.ts'
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
    // P8a R adds `approvedBy` (restore.confirmed: the approving Admin), registered in ops/tables/core.ts and kept by ops/delete/rules.ts.
    expect([...memberArgs].sort()).toEqual(['approvedBy', 'memberId', 'replaces'])
    expect(audit.personKeys).toEqual(expect.arrayContaining(['actor_id', 'target_id', ...[...memberArgs].map(f => `args_json:$.${f}`)]))
  })

  it('every setting whose value can be a member id is covered by value_json and args_json:$.value (failure 3)', () => {
    const memberValued = SETTING_KEY_EXAMPLES.filter(key => {
      const spec = settingSpec(key)
      if (!spec) throw new Error(`${key} has no spec`)
      // A value that names a member: takes a member id but not free text (g:name, n:channel, t:signs and g:mode take
      // any short text, member ids included, and are logged redacted; they aren't member references).
      return spec.value.safeParse('m_abc123').success && !spec.value.safeParse('Some free text').success
    })
    expect(memberValued).toEqual(['a:0'])
    const settings = tables.find(t => t.kind === 'd1' && t.name === 'settings')!
    const audit = tables.find(t => t.kind === 'd1' && t.name === 'audit_log')!
    expect(settings.personKeys).toContain('value_json')
    expect(audit.personKeys).toContain('args_json:$.value')
  })
})
