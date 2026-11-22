// The granted-scope check, run in SignIn after every grant and before anything is stored. Passes only when every
// granted scope is in the connector's `read` list (exact, no prefixes) and every `required` scope is granted. A write
// scope also grants reads (Shopify access scopes, read 2026-11-20), so any `write_*` fails. A missing field fails.

export type ScopeCheck = { ok: true; scopes: string[] } | { ok: false; extra: string[]; missing: string[] }

export function checkGrantedScopes(
  granted: string | undefined | null,
  allowed: { read: readonly string[]; required: readonly string[] },
): ScopeCheck {
  if (typeof granted !== 'string') return { ok: false, extra: [], missing: [...allowed.required] }
  const scopes = [
    ...new Set(
      granted
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0),
    ),
  ]
  const read = new Set(allowed.read)
  const extra = scopes.filter(s => !read.has(s))
  const missing = allowed.required.filter(s => !scopes.includes(s))
  if (extra.length > 0 || missing.length > 0) return { ok: false, extra, missing }
  return { ok: true, scopes }
}

/** Scope handles for an error message: only handle-shaped values, so nothing odd from an upstream rides along. */
export function describeScopeMismatch(check: { extra: string[]; missing: string[] }): string {
  const safe = (list: string[]) => list.filter(s => /^[a-z_]{1,64}$/.test(s)).slice(0, 20)
  const parts: string[] = []
  const extra = safe(check.extra)
  const missing = safe(check.missing)
  if (extra.length) parts.push(`extra ${extra.join(',')}`)
  if (missing.length) parts.push(`missing ${missing.join(',')}`)
  return parts.join('; ')
}
