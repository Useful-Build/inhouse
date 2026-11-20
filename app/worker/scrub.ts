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
  /** Set only on reports raised by the `?demo&crash=` switches, so log queries can drop them. */
  demo?: true
}

const LIMITS = { message: 500, stack: 4000, url: 300, release: 64 } as const

// Any scheme with an authority (https:, wss:, chrome-extension:, file:), and blob: URLs around one.
const URL_IN_TEXT = /\b(?:blob:)?[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>()]+/gi
// Bounded parts, so a long run of word characters costs linear time, not quadratic (RFC 5321 caps: 64 and 63).
// Measured: scrubText on an 8 KB worst case (word runs, `a.` runs, `@` runs) under 4 ms in Node 24, was ~38 ms.
const EMAIL = /[\w.+%-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g
// key=value or key: value where the key names a credential.
const SECRET_PAIR = /\b(token|access_token|id_token|api[_-]?key|key|secret|password|passwd|pwd|auth|authorization|session|sig|signature|code)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi
const BEARER = /\b(bearer|basic)\s+[\w.~+/=-]+/gi
const JWT = /\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g
// A long run of token characters; `looksLikeToken` decides. Asset hashes are shorter.
const LONG_RUN = /\b[A-Za-z0-9_-]{24,}={0,2}/g

/**
 * A credential-shaped run (API keys, hex digests, base64 session ids), not a long identifier like
 * `handleSettingsTabChange`: hex only, or letters mixed with digits (3 or more of each, or upper, lower and a digit).
 */
function looksLikeToken(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run) || run.endsWith('=')) return true
  const digits = run.replace(/\D/g, '').length
  const letters = run.replace(/[^A-Za-z]/g, '').length
  return (digits >= 3 && letters >= 3) || (digits > 0 && /[a-z]/.test(run) && /[A-Z]/.test(run))
}

/**
 * A URL without its query string and hash, a file: URL as just its file name, a blob: URL with its inner URL
 * stripped; anything that doesn't parse becomes `[url]`.
 */
export function stripUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.protocol === 'blob:') return 'blob:' + stripUrl(u.pathname)
    if (u.protocol === 'file:') return 'file://…/' + (u.pathname.split('/').pop() ?? '')
    return `${u.protocol}//${u.host}${u.pathname}`
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
    .replace(LONG_RUN, m => (looksLikeToken(m) ? '[token]' : m))
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
    ...(o.demo === true ? { demo: true as const } : {}),
  }
}
