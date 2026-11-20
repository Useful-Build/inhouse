// The settings registry (p2-design.md section 6, C9): every key's scope, its value schema, and whether its value may be
// stored in the audit log as it is. Values keep the strings the settings page saves (its option labels), and the
// switches stay booleans, so a demo's saved state still parses. W2 owns this file in P2.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { MemberIdSchema } from './members.ts'
import type { SettingRow, ValueRule } from './settings-table.ts'
import { EXACT_ROWS, PATTERN_ROWS, capOk, settingRow } from './settings-table.ts'

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

/** One example key per key pattern of settings-table.ts (`PATTERN_ROWS`), in its order. */
const PATTERN_EXAMPLES = ['tm:fable:effort', 'tm:fable:on', 'l:returns', 'a:0'] as const
if (PATTERN_EXAMPLES.length !== PATTERN_ROWS.length || PATTERN_ROWS.some(([re], i) => !re.test(PATTERN_EXAMPLES[i]))) {
  throw new Error('settings.ts: PATTERN_EXAMPLES must name one key per PATTERN_ROWS entry, in order')
}

/** One key per registry entry: every exact key, and an example of each key pattern. */
export const SETTING_KEY_EXAMPLES: readonly string[] = [...Object.keys(EXACT_ROWS), ...PATTERN_EXAMPLES]

/** A setting as the API serves it. Never set: `value` null, `rev` 0, no time or author. Reset to null: `rev` still counts up. */
export const SettingRecordSchema = z.object({
  key: SettingKeySchema,
  value: SettingValueSchema.nullable(),
  rev: z.number().int().min(0),
  updatedAt: InstantSchema.nullable(),
  updatedBy: MemberIdSchema.nullable(),
})
export type SettingRecord = z.infer<typeof SettingRecordSchema>

/** `PUT /api/settings/<scope>/:key`: the value (checked against the key's spec, or null to reset) and the rev last read. */
export const SettingWriteInputSchema = z.object({ value: z.unknown(), ifRev: z.number().int().min(0).max(999_999_999) }).strict()
  .refine(v => v.value !== undefined, { path: ['value'], message: 'Required (null resets)' })

/** `GET /api/settings/<scope>`: every key of the scope that has a value or a history. A key not listed was never set (rev 0). */
export const SettingsListSchema = z.object({ items: z.array(SettingRecordSchema) })
export type SettingsList = z.infer<typeof SettingsListSchema>
