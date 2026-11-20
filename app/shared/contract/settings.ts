// The settings registry (p2-design.md section 6, C9): every key's scope, its value schema, and whether its value may be
// stored in the audit log as it is. Values keep the strings the settings page saves (its option labels), and the
// switches stay booleans, so a demo's saved state still parses. W2 owns this file in P2.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { MemberIdSchema } from './members.ts'
import type { SettingRow, ValueRule } from './settings-table.ts'
import { capOk, settingRow } from './settings-table.ts'

export const SettingScopeSchema = z.enum(['personal', 'brand', 'technical'])
export type SettingScope = z.infer<typeof SettingScopeSchema>

/** A settings key as it travels in a path or an audit line: letters, digits, ':', '_' and '-'. */
export const SettingKeySchema = z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/)

/** Every value a setting holds: an option label or a short text, or a switch. */
export const SettingValueSchema = z.union([z.string(), z.boolean()])
export type SettingValue = z.infer<typeof SettingValueSchema>

export interface SettingSpec {
  scope: SettingScope
  value: z.ZodType<SettingValue>
  /** The value may be written to the audit log as it is; otherwise only its length and hash are (section 8). */
  auditSafe: boolean
}

/** The zod schema of a rule (settings-table.ts holds the rules as plain data). */
const zodOf = (rule: ValueRule): z.ZodType<SettingValue> => {
  switch (rule.t) {
    case 'bool': return z.boolean()
    case 'enum': return z.enum(rule.values as [string, ...string[]])
    case 'text': return z.string().trim().min(rule.min).max(rule.max)
    case 'cap': return z.string().regex(/^\$\d{1,6}(\.\d{2})?$/).refine(capOk, 'Out of range')
    case 'member': return z.union([MemberIdSchema, z.literal('anyone')])
  }
}
const specOf = (row: SettingRow): SettingSpec => ({ scope: row.scope, value: zodOf(row.rule), auditSafe: row.auditSafe })

/** Built once per row, so `settingSpec` returns the same object for the same key. */
const SPECS = new Map<SettingRow, SettingSpec>()
const specFor = (row: SettingRow): SettingSpec => { let s = SPECS.get(row); if (!s) { s = specOf(row); SPECS.set(row, s) } return s }

/**
 * The spec of a settings key, or null when it isn't a setting. `p:<id>` (a role), `photo:<id>` and `d:support` (a grant)
 * are never settings, so no role, photo or grant can be written through the settings routes; `r:<name>` waits for P4.
 */
export function settingSpec(key: string): SettingSpec | null {
  const row = settingRow(key)
  return row ? specFor(row) : null
}

/** A setting as the API serves it. Never set: `value` null, `rev` 0, no time or author. Reset to null: `rev` still counts up. */
export const SettingRecordSchema = z.object({
  key: SettingKeySchema,
  value: SettingValueSchema.nullable(),
  rev: z.number().int().min(0),
  updatedAt: InstantSchema.nullable(),
  updatedBy: MemberIdSchema.nullable(),
})
export type SettingRecord = z.infer<typeof SettingRecordSchema>
