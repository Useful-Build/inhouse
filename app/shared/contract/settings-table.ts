// The settings registry as plain data: each key's scope, the rule its value must meet and whether the audit log may hold
// it as it is (p2-design.md section 6). This file has NO imports, so a client that only needs to check a value (the mock)
// doesn't pull zod's runtime into its bundle; settings.ts builds its zod schemas from these rows, so the rules are
// defined once, and settings-table.test.ts compares the two on the same inputs.
export type SettingScopeName = 'personal' | 'brand' | 'technical'
/** What a value must be: one of a list, a switch, text of a length (after trimming), the money field's saved text, or a member id or `anyone`. */
export type ValueRule =
  | { t: 'enum'; values: readonly string[] }
  | { t: 'bool' }
  | { t: 'text'; min: number; max: number }
  | { t: 'cap' }
  | { t: 'member' }
export interface SettingRow { scope: SettingScopeName; rule: ValueRule; auditSafe: boolean }

// ---------- the option lists, copied exactly from src/screens/settings/content.ts and src/state/derive.ts ----------
export const THEMES = ['System', 'Light', 'Dark'] as const
export const LANGUAGES = ['English (US)', 'English (UK)', 'Español', 'Français', 'Deutsch'] as const
export const TEXT_SIZES = ['90%', '100%', '110%', '125%'] as const
export const TIME_ZONE_IDS = [
  'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'Australia/Sydney',
] as const
export const WAIT_ALERTS = ['Right away', 'Once an hour', 'Once a day'] as const
export const ALERT_AT = ['50%', '70%', '80%', '90%', '100%'] as const
export const CURRENCIES = ['USD ($)', 'GBP (£)', 'EUR (€)', 'CAD ($)', 'AUD ($)'] as const
export const STAGES = ['Watch', 'Act', 'Run'] as const
export const TONES = ['Friendly and short', 'Warm and detailed', 'Formal and brief', 'Plain and direct'] as const
export const EFFORT_LABELS = ['Low', 'Medium', 'High', 'Extra high', 'Highest'] as const
export const DAILY_LIMITS = ['10 actions', '25 actions', '50 actions', '100 actions', '200 actions'] as const
export const RESTOCK_LIMITS = ['25 units', '50 units', '100 units', '250 units', '500 units'] as const
/** The retention classes the Data and access page offers (and the P8 table registry's terms). */
export const RETENTION = ['3 months', '6 months', '12 months', '24 months', 'Until deleted'] as const

/** The money field's saved text: whole US dollars or two-digit cents, no grouping, above $0 and up to $100,000 ("$320", "$300.50"). */
export const CAP_PATTERN = /^\$\d{1,6}(\.\d{2})?$/
export const capOk = (v: string) => CAP_PATTERN.test(v) && Number(v.slice(1)) > 0 && Number(v.slice(1)) <= 100_000
/** A member id: 'm_' and a random or fixed suffix (members.ts `MemberIdSchema`). */
export const MEMBER_ID_PATTERN = /^m_[A-Za-z0-9_-]{1,64}$/

const bool: ValueRule = { t: 'bool' }
const text = (min: number, max: number): ValueRule => ({ t: 'text', min, max })
const oneOf = (values: readonly string[]): ValueRule => ({ t: 'enum', values })
/** A setting logged redacted (`{ len, hash }`): the default, so a new key is never logged verbatim by accident. */
const spec = (scope: SettingScopeName, rule: ValueRule): SettingRow => ({ scope, rule, auditSafe: false })
/** A setting logged verbatim: only for a closed enum or a switch, which can never hold a name or an email. */
const safe = (scope: SettingScopeName, rule: ValueRule): SettingRow => ({ scope, rule, auditSafe: true })

/** Keys matched exactly. */
export const EXACT_ROWS: Record<string, SettingRow> = {
  // personal
  'g:name': spec('personal', text(1, 80)),
  'g:theme': safe('personal', oneOf(THEMES)),
  'g:lang': safe('personal', oneOf(LANGUAGES)),
  'g:size': safe('personal', oneOf(TEXT_SIZES)),
  'n:wait': safe('personal', oneOf(WAIT_ALERTS)),
  // Free text until the server holds a closed list of channel names (a later phase makes it an enum): redacted in the log.
  'n:channel': spec('personal', text(1, 80)),
  'n:slack': safe('personal', bool),
  'n:weekly': safe('personal', bool),
  'm:learn': safe('personal', bool),
  // brand
  'g:tz': safe('brand', oneOf(TIME_ZONE_IDS)),
  'm:ask': safe('brand', bool),
  's:cap': safe('brand', { t: 'cap' }),
  's:alert': safe('brand', oneOf(ALERT_AT)),
  's:currency': safe('brand', oneOf(CURRENCIES)),
  // technical
  'stage': safe('technical', oneOf(STAGES)),
  't:tone': safe('technical', oneOf(TONES)),
  't:signs': spec('technical', text(1, 80)),
  // Free text until the server holds a closed list of model mode labels (a later phase makes it an enum): redacted in the log.
  'g:mode': spec('technical', text(1, 80)),
  'l:daily': safe('technical', oneOf(DAILY_LIMITS)),
  'l:restock': safe('technical', oneOf(RESTOCK_LIMITS)),
  'd:chats': safe('technical', oneOf(RETENTION)),
  'd:steps': safe('technical', oneOf(RETENTION)),
  'd:2fa': safe('technical', bool),
}

/** An id inside a key (a model, a run-limit job). */
const ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}'
/** Keys with an id in them, tried after the exact keys (so `l:daily` is never read as the job `daily`). */
export const PATTERN_ROWS: [RegExp, SettingRow][] = [
  [new RegExp(`^tm:${ID}:effort$`), safe('technical', oneOf(EFFORT_LABELS))],
  [new RegExp(`^tm:${ID}:on$`), safe('technical', oneOf(['off', 'on']))],
  [new RegExp(`^l:${ID}$`), safe('technical', bool)],
  // An approval rule's approver: a member id or anyone (P6 builds the page).
  [/^a:(0|[1-9]\d{0,3})$/, safe('brand', { t: 'member' })],
]

/** The row of a settings key, or null when it isn't a setting (see `settingSpec` in settings.ts). */
export function settingRow(key: string): SettingRow | null {
  if (Object.hasOwn(EXACT_ROWS, key)) return EXACT_ROWS[key]
  for (const [re, row] of PATTERN_ROWS) if (re.test(key)) return row
  return null
}

/** Whether `value` meets `rule`: the same answer as the zod schema settings.ts builds from it. */
export function meetsRule(rule: ValueRule, value: unknown): boolean {
  switch (rule.t) {
    case 'bool': return typeof value === 'boolean'
    case 'enum': return typeof value === 'string' && rule.values.includes(value)
    case 'text': { if (typeof value !== 'string') return false; const n = value.trim().length; return n >= rule.min && n <= rule.max }
    case 'cap': return typeof value === 'string' && capOk(value)
    case 'member': return typeof value === 'string' && (value === 'anyone' || MEMBER_ID_PATTERN.test(value))
  }
}
