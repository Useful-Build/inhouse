// Scrubbing for client error reports. Shared: the client scrubs before it sends, the Worker again before it logs
// (a report can come from anything that can POST, not only our client).

export const REPORT_KINDS = ['error', 'rejection', 'boundary', 'route'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

export interface ClientErrorReport {
  message: string
  stack: string
  url: string
  release: string
  kind: ReportKind | 'unknown'
}

const LIMITS = { message: 500, stack: 4000, url: 300, release: 64 } as const

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>()]+/gi
const EMAIL = /[\w.+%-]+@[\w-]+(?:\.[\w-]+)+/g
// key=value or key: value where the key names a credential.
const SECRET_PAIR = /\b(token|access_token|id_token|api[_-]?key|key|secret|password|passwd|pwd|auth|authorization|session|sig|signature|code)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi
const BEARER = /\b(bearer|basic)\s+[\w.~+/=-]+/gi
const JWT = /\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g
// A long run of token characters (API keys, hex digests, session ids). Asset hashes are shorter.
const LONG_TOKEN = /\b[A-Za-z0-9_-]{24,}\b/g

/** A URL without its query string and hash; anything that doesn't parse becomes `[url]`. */
export function stripUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return u.origin + u.pathname
  } catch {
    return '[url]'
  }
}

/** Removes query strings, hashes, emails and anything that looks like a credential from free text. */
export function scrubText(text: string): string {
  return text
    .replace(URL_IN_TEXT, m => stripUrl(m))
    .replace(EMAIL, '[email]')
    .replace(JWT, '[token]')
    .replace(BEARER, (_m, scheme: string) => `${scheme} [token]`)
    .replace(SECRET_PAIR, (_m, key: string, sep: string) => `${key}${sep}[token]`)
    .replace(LONG_TOKEN, '[token]')
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** A report with every field a capped, scrubbed string. Takes anything (a parsed request body included). */
export function scrubReport(input: unknown): ClientErrorReport {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const kind = str(o.kind)
  return {
    // Cap first so the patterns never run over a huge string, then again after (a replacement can lengthen it).
    message: cap(scrubText(cap(str(o.message), LIMITS.message * 2)), LIMITS.message),
    stack: cap(scrubText(cap(str(o.stack), LIMITS.stack * 2)), LIMITS.stack),
    url: cap(o.url ? stripUrl(str(o.url)) : '', LIMITS.url),
    release: cap(str(o.release).replace(/[^\w.-]/g, ''), LIMITS.release),
    kind: (REPORT_KINDS as readonly string[]).includes(kind) ? (kind as ReportKind) : 'unknown',
  }
}
