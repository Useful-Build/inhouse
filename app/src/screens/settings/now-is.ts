// The record a stale save found, as a short phrase for "Someone changed this. It's now X." (pure, so it is tested alone).
const ROLES: Record<string, string> = { admin: 'Admin', member: 'Member' }

/** The current record as a short phrase, or null when it has no value to name. */
export function nowIs(current: Record<string, unknown>): string | null {
  if ('value' in current) {
    const v = current.value
    return v === null ? 'the default' : typeof v === 'boolean' ? (v ? 'on' : 'off') : typeof v === 'string' && v ? v : null
  }
  if (typeof current.role === 'string' && current.role in ROLES) return ROLES[current.role]
  if (typeof current.live === 'boolean') return current.live ? 'on' : 'off'
  return null
}
