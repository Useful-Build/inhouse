// The settings registry (p2-design.md section 6, C9): every key's scope, its value schema, and whether its value may be
// stored in the audit log as it is. Values keep the strings the settings page saves (its option labels), and the
// switches stay booleans, so a demo's saved state still parses. W2 owns this file in P2.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { MemberIdSchema } from './members.ts'

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

// ---------- the option lists, copied exactly from src/screens/settings/content.ts and src/state/derive.ts ----------
const THEMES = ['System', 'Light', 'Dark'] as const
const LANGUAGES = ['English (US)', 'English (UK)', 'Español', 'Français', 'Deutsch'] as const
const TEXT_SIZES = ['90%', '100%', '110%', '125%'] as const
const TIME_ZONE_IDS = [
  'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'Australia/Sydney',
] as const
const WAIT_ALERTS = ['Right away', 'Once an hour', 'Once a day'] as const
const ALERT_AT = ['50%', '70%', '80%', '90%', '100%'] as const
const CURRENCIES = ['USD ($)', 'GBP (£)', 'EUR (€)', 'CAD ($)', 'AUD ($)'] as const
const STAGES = ['Watch', 'Act', 'Run'] as const
const TONES = ['Friendly and short', 'Warm and detailed', 'Formal and brief', 'Plain and direct'] as const
const EFFORT_LABELS = ['Low', 'Medium', 'High', 'Extra high', 'Highest'] as const
const DAILY_LIMITS = ['10 actions', '25 actions', '50 actions', '100 actions', '200 actions'] as const
const RESTOCK_LIMITS = ['25 units', '50 units', '100 units', '250 units', '500 units'] as const
/** The retention classes the Data and access page offers (and the P8 table registry's terms). */
const RETENTION = ['3 months', '6 months', '12 months', '24 months', 'Until deleted'] as const

const bool = z.boolean()
const text = (min: number, max: number) => z.string().trim().min(min).max(max)
/** The money field's saved text: whole US dollars or two-digit cents, no grouping, above $0 and up to $100,000 ("$320", "$300.50"). */
const capText = z.string().regex(/^\$\d{1,6}(\.\d{2})?$/).refine(v => { const n = Number(v.slice(1)); return n > 0 && n <= 100_000 }, 'Out of range')

/** A setting logged redacted (`{ len, hash }`): the default, so a new key is never logged verbatim by accident. */
const spec = (scope: SettingScope, value: z.ZodType<SettingValue>): SettingSpec => ({ scope, value, auditSafe: false })
/** A setting logged verbatim: only for a closed enum or a switch, which can never hold a name or an email. */
const safe = (scope: SettingScope, value: z.ZodType<SettingValue>): SettingSpec => ({ scope, value, auditSafe: true })

/** Keys matched exactly. */
const EXACT: Record<string, SettingSpec> = {
  // personal
  'g:name': spec('personal', text(1, 80)),
  'g:theme': safe('personal', z.enum(THEMES)),
  'g:lang': safe('personal', z.enum(LANGUAGES)),
  'g:size': safe('personal', z.enum(TEXT_SIZES)),
  'n:wait': safe('personal', z.enum(WAIT_ALERTS)),
  // Free text until the server holds a closed list of channel names (a later phase makes it an enum): redacted in the log.
  'n:channel': spec('personal', text(1, 80)),
  'n:slack': safe('personal', bool),
  'n:weekly': safe('personal', bool),
  'm:learn': safe('personal', bool),
  // brand
  'g:tz': safe('brand', z.enum(TIME_ZONE_IDS)),
  'm:ask': safe('brand', bool),
  's:cap': safe('brand', capText),
  's:alert': safe('brand', z.enum(ALERT_AT)),
  's:currency': safe('brand', z.enum(CURRENCIES)),
  // technical
  'stage': safe('technical', z.enum(STAGES)),
  't:tone': safe('technical', z.enum(TONES)),
  't:signs': spec('technical', text(1, 80)),
  // Free text until the server holds a closed list of model mode labels (a later phase makes it an enum): redacted in the log.
  'g:mode': spec('technical', text(1, 80)),
  'l:daily': safe('technical', z.enum(DAILY_LIMITS)),
  'l:restock': safe('technical', z.enum(RESTOCK_LIMITS)),
  'd:chats': safe('technical', z.enum(RETENTION)),
  'd:steps': safe('technical', z.enum(RETENTION)),
  'd:2fa': safe('technical', bool),
}

/** An id inside a key (a model, a run-limit job). */
const ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}'
/** Keys with an id in them, tried after the exact keys (so `l:daily` is never read as the job `daily`). */
const PATTERNS: [RegExp, SettingSpec][] = [
  [new RegExp(`^tm:${ID}:effort$`), safe('technical', z.enum(EFFORT_LABELS))],
  [new RegExp(`^tm:${ID}:on$`), safe('technical', z.enum(['off', 'on']))],
  [new RegExp(`^l:${ID}$`), safe('technical', bool)],
  // An approval rule's approver: a member id or anyone (P6 builds the page).
  [/^a:(0|[1-9]\d{0,3})$/, safe('brand', z.union([MemberIdSchema, z.literal('anyone')]))],
]

/**
 * The spec of a settings key, or null when it isn't a setting. `p:<id>` (a role), `photo:<id>` and `d:support` (a grant)
 * are never settings, so no role, photo or grant can be written through the settings routes; `r:<name>` waits for P4.
 */
export function settingSpec(key: string): SettingSpec | null {
  if (Object.hasOwn(EXACT, key)) return EXACT[key]
  for (const [re, s] of PATTERNS) if (re.test(key)) return s
  return null
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
