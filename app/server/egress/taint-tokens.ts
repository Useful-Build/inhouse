// The fetch leak check's tokenizer (M1-G, N8): pure functions, no storage. What it reads, what it skips (decision L2)
// and its known gaps are in the header of taint.ts, which stores and checks the digests.

/** At most this many tokens are captured from one result, highest signal first. */
export const TAINT_MAX_TOKENS_PER_RESULT = 500
/** How deep a JSON string inside a JSON string is unwrapped (the hub's results are double-encoded). */
const MAX_NESTED_JSON = 4
/** A URL run's sub-runs span at most this many `-`/`_`-joined parts. */
const MAX_SPAN_PARTS = 24

const dec = new TextDecoder('utf-8', { fatal: false })

// Linear-time patterns (no nested quantifiers). Emails are scanned by hand from each `@` (`scanEmails`).
const ORDER_NAME_RE = /#\d{3,}/g
const LONG_DIGITS_RE = /\d{8,}/g
const MIXED_ID_RE = /[A-Za-z0-9_-]{12,}/g
const SEPARATOR_RE = /[-_]/
const BASE64_RUN_RE = /[A-Za-z0-9+/_-]{6,}={0,2}/g
const HEX_RUN_RE = /[0-9A-Fa-f]{8,}/g
/** An ISO date with an optional hour (`2026-11-20T10`, cut there by the `:`), or its basic form (`20261120T101500Z`). */
const DATE_SHAPED = [/^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2})?$/, /^\d{8}[Tt]\d{2,6}[Zz]?$/]
const BASIC_DATE_RE = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/

/** Shopify id types that are product catalogue data (decision L2): never captured. */
const CATALOG_GID_TYPES = new Set([
  'Product', 'ProductVariant', 'ProductOption', 'ProductOptionValue', 'ProductImage', 'MediaImage', 'Collection',
  'InventoryItem', 'InventoryLevel', 'Location',
])
const GID_RE = /^gid:\/\/shopify\/([A-Za-z0-9]+)\//
/** Catalogue fields of a hub result (decision L2): only emails are taken from them. */
const CATALOG_KEYS = new Set(['title', 'handle', 'sku', 'vendor', 'productType'])

/** Where a captured result came from: the catalogue fields rule applies to the hub's results only. */
export type TaintSource = { route: 'hub' } | { route: 'mcp' } | { route: 'files'; contentType: string }
/** Captures high-signal tokens from a result before it goes back to the container; throws when it can't (fail closed). */
export type CaptureTaint = (body: string, source: TaintSource) => Promise<void>

type Kind = 'email' | 'order' | 'digits' | 'mixed'
const KINDS: readonly Kind[] = ['email', 'order', 'digits', 'mixed']

/** Collects tokens by kind, each kind capped, so the result can be ordered highest signal first. */
class Sink {
  readonly by: Record<Kind, Set<string>> = { email: new Set(), order: new Set(), digits: new Set(), mixed: new Set() }
  readonly cap: number
  constructor(cap: number) {
    this.cap = cap
  }
  add(kind: Kind, token: string): void {
    const set = this.by[kind]
    if (set.size < this.cap) set.add(token.toLowerCase())
  }
  emailsFull(): boolean {
    return this.by.email.size >= this.cap
  }
  ordered(limit: number): string[] {
    const out = new Set<string>()
    for (const k of KINDS) {
      for (const t of this.by[k]) {
        if (out.size >= limit) return [...out]
        out.add(t)
      }
    }
    return [...out]
  }
  all(): string[] {
    return [...new Set(KINDS.flatMap(k => [...this.by[k]]))]
  }
}

const isAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
// local part: letters, digits, `.` `_` `%` `+` `-`; domain: letters, digits, `.` `-`.
const isLocalChar = (c: number) => isAlnum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45
const isDomainChar = (c: number) => isAlnum(c) || c === 46 || c === 45
const isLocalSeparator = (c: string) => c === '.' || c === '_' || c === '-' || c === '+' || c === '%'

/**
 * Finds emails in linear time: from each `@`, expand left over local-part characters (never past the previous `@`)
 * and right over domain characters (which stop at the next `@`), so each character is visited at most twice. The
 * domain is its leading non-empty labels; two or more make an email.
 */
function scanEmails(text: string, emit: (local: string, labels: string[]) => void): void {
  let floor = 0
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    let s = at
    while (s > floor && isLocalChar(text.charCodeAt(s - 1))) s--
    let e = at + 1
    while (e < text.length && isDomainChar(text.charCodeAt(e))) e++
    floor = at + 1
    if (s === at) continue
    const labels: string[] = []
    for (const l of text.slice(at + 1, e).split('.')) {
      if (!l) break
      labels.push(l)
    }
    if (labels.length >= 2) emit(text.slice(s, at), labels)
  }
}

const isDateShaped = (run: string) => DATE_SHAPED.some(re => re.test(run))
const isMixedToken = (run: string) => run.length >= 12 && /[A-Za-z]/.test(run) && /\d/.test(run) && !isDateShaped(run)

/** Every contiguous span of a run's `-`/`_`-joined parts (separators kept), at most `MAX_SPAN_PARTS` parts long. */
function spansOf(run: string, emit: (span: string) => void): void {
  if (!SEPARATOR_RE.test(run)) return
  const parts = run.split(/[-_]/)
  const seps = run.match(/[-_]/g)!
  for (let i = 0; i < parts.length; i++) {
    let span = parts[i]!
    for (let j = i; j < parts.length && j < i + MAX_SPAN_PARTS; j++) {
      if (j > i) span += seps[j - 1]! + parts[j]!
      emit(span)
    }
  }
}

/**
 * Tokenizes `text` into `sink`. `emailsOnly`: a catalogue field (only emails count). `variants`: the URL side, where a
 * token may have adjacent characters: add email local-part suffixes and domain prefixes, and the sub-runs of each run.
 */
function scanText(text: string, sink: Sink, opts: { emailsOnly?: boolean; variants?: boolean } = {}): void {
  if (!text) return
  scanEmails(text, (local, labels) => {
    sink.add('email', `${local}@${labels.join('.')}`)
    if (!opts.variants) return
    const locals = [local]
    for (let i = 0; i < local.length && locals.length < 16; i++) if (isLocalSeparator(local[i]!) && i + 1 < local.length) locals.push(local.slice(i + 1))
    const domains: string[] = []
    for (let n = 2; n <= labels.length && n <= 8; n++) domains.push(labels.slice(0, n).join('.'))
    // A last label with a glued `-x` or `_x` (`example.com-x`) also yields its part before the separator.
    for (const d of [...domains]) {
      const cut = /^(.*\.[A-Za-z0-9]+)[-_]/.exec(d)?.[1]
      if (cut && cut !== d) domains.push(cut)
    }
    for (const l of locals) for (const d of domains) sink.add('email', `${l}@${d}`)
  })
  if (opts.emailsOnly || sink.emailsFull()) return
  for (const m of text.matchAll(ORDER_NAME_RE)) sink.add('order', m[0])
  for (const m of text.matchAll(LONG_DIGITS_RE)) {
    // The date of a basic-form ISO timestamp (`20261120T101500Z`) is not an id.
    if (BASIC_DATE_RE.test(m[0]) && /^[Tt]\d/.test(text.slice(m.index + 8, m.index + 10))) continue
    sink.add('digits', m[0])
  }
  for (const m of text.matchAll(MIXED_ID_RE)) {
    const run = m[0]
    if (isMixedToken(run)) sink.add('mixed', run)
    if (opts.variants) spansOf(run, span => { if (isMixedToken(span)) sink.add('mixed', span) })
  }
}

/**
 * Extracts high-signal tokens from raw `text`, normalized to lowercase, deduplicated, highest signal first:
 *  1. email addresses
 *  2. `#` order names with 3+ digits
 *  3. digit runs of 8+ digits
 *  4. runs of 12+ `[A-Za-z0-9_-]` mixing letters and digits (not an ISO date with its hour)
 */
export function extractTokens(text: string, limit: number = TAINT_MAX_TOKENS_PER_RESULT): string[] {
  if (!text || limit <= 0) return []
  const sink = new Sink(limit)
  scanText(text, sink)
  return sink.ordered(limit)
}

/** A JSON number as written (`JSON.parse` would round an id past 2^53). */
class JsonNumber {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    // The reviver's third argument (JSON.parse source text access) keeps a number's digits exactly.
    const value: unknown = JSON.parse(text, (_k: string, v: unknown, ctx?: { source?: unknown }) =>
      typeof v === 'number' ? new JsonNumber(typeof ctx?.source === 'string' ? ctx.source : String(v)) : v,
    )
    return { ok: true, value }
  } catch {
    return { ok: false }
  }
}

const isJsonMime = (contentType: string) => {
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase()
  return mime === 'application/json' || mime.endsWith('+json')
}

/** Walks a parsed JSON value's leaves (iteratively, in document order) into `sink`. */
function walkJson(root: unknown, sink: Sink, catalogFields: boolean): void {
  const stack: { v: unknown; key: string | null; nest: number }[] = [{ v: root, key: null, nest: 0 }]
  while (stack.length > 0) {
    const { v, key, nest } = stack.pop()!
    if (typeof v === 'string') {
      const head = v.trimStart()[0]
      if (nest < MAX_NESTED_JSON && (head === '{' || head === '[')) {
        const inner = parseJson(v)
        if (inner.ok) {
          stack.push({ v: inner.value, key, nest: nest + 1 })
          continue
        }
      }
      const gid = GID_RE.exec(v)
      if (gid && CATALOG_GID_TYPES.has(gid[1]!)) continue
      scanText(v, sink, { emailsOnly: catalogFields && key !== null && CATALOG_KEYS.has(key) })
    } else if (v instanceof JsonNumber) {
      if (!(catalogFields && key !== null && CATALOG_KEYS.has(key))) scanText(v.text, sink)
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], key, nest })
    } else if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v)
      for (let i = entries.length - 1; i >= 0; i--) stack.push({ v: entries[i]![1], key: entries[i]![0], nest })
    }
  }
}

/**
 * The tokens a result captures (at most `limit`, highest signal first). `/hub/` and `/mcp/` bodies and JSON files are
 * parsed and their leaves walked; a body that isn't JSON, and any other text file, is read as raw text.
 */
export function resultTokens(body: string, source: TaintSource, limit: number = TAINT_MAX_TOKENS_PER_RESULT): string[] {
  if (!body || limit <= 0) return []
  const sink = new Sink(limit)
  const json = source.route !== 'files' || isJsonMime(source.contentType) ? parseJson(body) : { ok: false as const }
  if (json.ok) walkJson(json.value, sink, source.route === 'hub')
  else scanText(body, sink)
  return sink.ordered(limit)
}

/** Percent-decodes valid `%XX` runs without throwing on stray `%` characters. */
function decodePercentOnce(s: string): string {
  if (!s.includes('%')) return s
  try {
    return decodeURIComponent(s)
  } catch {
    // Decode each contiguous run of `%XX` bytes independently so one malformed `%` never blocks valid encodings.
    return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, run => {
      try {
        return decodeURIComponent(run)
      } catch {
        const bytes = new Uint8Array(run.length / 3)
        for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16)
        return dec.decode(bytes)
      }
    })
  }
}

/** Two rounds of percent-decoding, preserving original case. */
export function decodePercentTwoRounds(s: string): string {
  const r1 = decodePercentOnce(s)
  return r1 === s ? r1 : decodePercentOnce(r1)
}

/** Decodes base64 or base64url (with or without `=` padding) to UTF-8; a dangling sixth-bit character is dropped. */
function decodeBase64(s: string): string | null {
  let std = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  if (std.length % 4 === 1) std = std.slice(0, -1)
  if (std.length < 4) return null
  try {
    const bin = atob(std.padEnd(std.length + ((4 - (std.length % 4)) % 4), '='))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return dec.decode(bytes)
  } catch {
    return null
  }
}

/** Decodes a hex string to UTF-8; an odd last digit is dropped. */
function decodeHex(s: string): string | null {
  const even = s.length % 2 === 0 ? s : s.slice(0, -1)
  if (even.length < 8) return null
  const bytes = new Uint8Array(even.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(even.slice(i * 2, i * 2 + 2), 16)
  return dec.decode(bytes)
}

/** Every decoding of the base64 and hex runs in `text`, at each alignment (offset and trailing cut), then percent-decoded. */
function decodedRuns(text: string): Set<string> {
  const out = new Set<string>()
  const tryAll = (run: string, maxShift: number, decode: (s: string) => string | null) => {
    for (let off = 0; off <= maxShift; off++) {
      for (let cut = 0; cut <= maxShift; cut++) {
        if (run.length - off - cut < 6) continue
        const t = decode(run.slice(off, run.length - cut))
        if (!t) continue
        out.add(t)
        const p = decodePercentTwoRounds(t)
        if (p !== t) out.add(p)
      }
    }
  }
  for (const m of text.matchAll(BASE64_RUN_RE)) tryAll(m[0], 3, decodeBase64)
  for (const m of text.matchAll(HEX_RUN_RE)) tryAll(m[0], 1, decodeHex)
  return out
}

/**
 * Extracts every candidate token from a URL's host labels, path segments, query names and values, and fragment.
 * Runs two rounds of percent-decoding, tokenizes each part as-is (with adjacent-character variants), and base64url-/
 * hex-decodes runs before lower-casing and tokenizing.
 */
export function extractUrlTokens(url: URL): string[] {
  const segments: { raw: string; isQuery?: boolean }[] = []

  const host = url.hostname.replace(/\.$/, '')
  for (const label of host.split('.')) if (label) segments.push({ raw: label })
  // The labels joined: a hex run split across labels by the 63-character limit decodes whole.
  if (host.includes('.')) segments.push({ raw: host.replace(/\./g, '') })

  for (const seg of url.pathname.split('/')) if (seg) segments.push({ raw: seg })

  if (url.search.length > 1) {
    for (const pair of url.search.slice(1).split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq < 0) {
        segments.push({ raw: pair, isQuery: true })
      } else {
        const k = pair.slice(0, eq)
        const v = pair.slice(eq + 1)
        if (k) segments.push({ raw: k, isQuery: true })
        if (v) segments.push({ raw: v, isQuery: true })
      }
    }
  }

  if (url.hash.length > 1) {
    // Keep `#` in one copy so `#1042` matches order names, and strip `#` in another so base64url/hex decode cleanly.
    segments.push({ raw: url.hash })
    segments.push({ raw: url.hash.slice(1) })
  }

  const sink = new Sink(Number.MAX_SAFE_INTEGER)
  for (const { raw, isQuery } of segments) {
    const decoded = decodePercentTwoRounds(raw)
    // In a query `+` is a space: decode both ways so `?q=hi+<base64url>` aligns on the encoded run.
    const forms = isQuery && decoded.includes('+') ? [decoded, decoded.replace(/\+/g, ' ')] : [decoded]
    for (const form of forms) {
      scanText(form, sink, { variants: true })
      // Decode before lower-casing: base64url is case-sensitive.
      for (const text of decodedRuns(form)) scanText(text, sink, { variants: true })
    }
  }
  return sink.all()
}

/** Whether a file's content type is text-like and should be scanned for tokens when served to a session. */
export function isTextLikeContentType(contentType: string): boolean {
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase()
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')
}
