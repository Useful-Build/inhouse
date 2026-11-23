// P6a's brand skills (0471_brand_skills.sql): skills a brand's people make in a chat. `created_by` and `updated_by` are
// person keys; the table is the brand's own configuration of its agent (config), exported with the brand's data.
import type { TableEntry } from './types.ts'

export const brandSkillTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'brand_skills', retention: 'config', personKeys: ['created_by', 'updated_by'], export: true },
]
