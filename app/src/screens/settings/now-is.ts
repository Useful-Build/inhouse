// The record a stale save found, as a short phrase for "Someone changed this. It's now X." (pure, so it is tested alone).
const ROLES: Record<string, string> = { admin: 'Admin', member: 'Member' }

/** What the row calls a stored value: a member id its name, a time zone id its label. Never a raw id when the row knows better. */
export interface Words { labels?: Record<string, string>; defaultValue?: string }

/** The current record as a short phrase, or null when it has no value to name. */
export function nowIs(current: Record<string, unknown>, words: Words = {}): string | null {
  const say = (v: string) => words.labels?.[v] ?? v
  if ('value' in current) {
    const v = current.value
    if (v === null) return words.defaultValue ? say(words.defaultValue) : 'the default'
    return typeof v === 'boolean' ? (v ? 'on' : 'off') : typeof v === 'string' && v ? say(v) : null
  }
  if (typeof current.role === 'string' && current.role in ROLES) return ROLES[current.role]
  if (typeof current.live === 'boolean') return current.live ? 'on' : 'off'
  return null
}
