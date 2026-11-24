// P6a's brand skills (0471_brand_skills.sql): skills a brand's people make in a chat. C1's person-deletion rule is
// keep (decision 1): the skill stays, `created_by` and `updated_by` are cleared to NULL (`members.pseudonymise`), and
// only admins can edit or delete it after. Exported with the brand's data (`export: true`).
import type { TableEntry } from './types.ts'

export const brandSkillTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'brand_skills', retention: 'config', personKeys: ['created_by', 'updated_by'], export: true },
]
