// Fetch leak check (M1-G, N8): one defence-in-depth layer against data exfiltration through WebFetch URLs.
//
// How it works:
//  - Capture: after `/hub/` and `/mcp/` respond, and when `/files/` serves a text-like file to a session, extract
//    high-signal tokens (at most 500 per result, highest signal first) and store their keyed HMAC-SHA-256 digests
//    (first 16 bytes, 32-char lowercase hex, keyed with `AUDIT_HASH_KEY`) in `egress_taint` before returning.
//  - Check: before DNS and on every redirect hop in `WebEgress`, percent-decode URL parts (two rounds), tokenize
//    host labels, path segments, query names/values and fragment as-is, and also base64url- and hex-decode segments
//    before lower-casing and tokenizing. Any digest present in `egress_taint` (within 7 days) refuses the hop (`leak`).
//  - Brand-wide: the web intercept knows only the container (`EgressProps`), never the turn, so the store is brand-wide.
//  - Retention and cap: rows expire after 7 days and the table is capped at 50,000 rows (oldest evicted in bounded deletes).
//  - Fail closed: a capture failure fails the tool/file response; a check failure refuses the fetch.
//
// Known gaps (N8):
//  - paraphrased data (rewritten or summarised facts without the original token);
//  - short numbers (fewer than 8 digits, except `#` order names with 3+ digits);
//  - data older than 7 days (expired from `egress_taint`);
//  - a replayed transcript older than 7 days.
import { AuditKeyMissingError } from '../db/audit.ts'

export const TAINT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const TAINT_MAX_ROWS = 50_000
export const TAINT_MAX_TOKENS_PER_RESULT = 500
/** Bounded eviction size per capture write so one request never scans or deletes the whole table. */
export const TAINT_EVICT_BATCH = 500
/** Chunk sizes stay under D1's 100 bind-parameter limit per statement. */
const INSERT_CHUNK_ROWS = 40
const SELECT_CHUNK_DIGESTS = 90

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: false })
const hmacKeys = new Map<string, Promise<CryptoKey>>()

// Linear-time patterns (no nested quantifiers or backtracking):
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
const ORDER_NAME_RE = /#\d{3,}\b/g
const LONG_DIGITS_RE = /\d{8,}/g
const MIXED_ID_RE = /[A-Za-z0-9_-]{12,}/g

const BASE64_RUN_RE = /[A-Za-z0-9+/_-]{6,}={0,2}/g
const HEX_RUN_RE = /[0-9A-Fa-f]{8,}/g

/**
 * Extracts high-signal tokens from `text`, normalized to lowercase, deduplicated, highest signal first:
 *  1. email addresses
 *  2. `#` order names with 3+ digits
 *  3. digit runs of 8+ digits
 *  4. runs of 12+ `[A-Za-z0-9_-]` mixing letters and digits
 */
export function extractTokens(text: string, limit: number = TAINT_MAX_TOKENS_PER_RESULT): string[] {
  if (!text || limit <= 0) return []
  const seen = new Set<string>()
  const add = (tok: string): boolean => {
    const norm = tok.toLowerCase()
    if (seen.has(norm)) return false
    seen.add(norm)
    return seen.size >= limit
  }

  for (const m of text.matchAll(EMAIL_RE)) if (add(m[0])) return [...seen]
  for (const m of text.matchAll(ORDER_NAME_RE)) if (add(m[0])) return [...seen]
  for (const m of text.matchAll(LONG_DIGITS_RE)) if (add(m[0])) return [...seen]
  for (const m of text.matchAll(MIXED_ID_RE)) {
    const v = m[0]
    if (/[A-Za-z]/.test(v) && /\d/.test(v) && add(v)) return [...seen]
  }
  return [...seen]
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

/** Decodes base64 or base64url (with or without `=` padding) to UTF-8, preserving case before decode. */
function decodeBase64Url(s: string): string | null {
  const std = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (std.length < 4 || std.length % 4 === 1) return null
  const padded = std.padEnd(std.length + ((4 - (std.length % 4)) % 4), '=')
  try {
    const bin = atob(padded)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return dec.decode(bytes)
  } catch {
    return null
  }
}

/** Decodes an even-length hex string to UTF-8. */
function decodeHex(s: string): string | null {
  if (s.length < 8 || s.length % 2 !== 0) return null
  const bytes = new Uint8Array(s.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const b = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(b)) return null
    bytes[i] = b
  }
  return dec.decode(bytes)
}

/**
 * Extracts every candidate token from a URL's host labels, path segments, query names and values, and fragment.
 * Runs two rounds of percent-decoding, tokenizes each part as-is, and base64url-/hex-decodes segments before
 * lower-casing and tokenizing.
 */
export function extractUrlTokens(url: URL): string[] {
  const segments: { raw: string; isQuery?: boolean }[] = []

  const host = url.hostname.replace(/\.$/, '')
  for (const label of host.split('.')) if (label) segments.push({ raw: label })

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

  const out = new Set<string>()
  const collect = (text: string) => {
    for (const t of extractTokens(text, Number.MAX_SAFE_INTEGER)) out.add(t)
  }

  for (const { raw, isQuery } of segments) {
    const decoded = decodePercentTwoRounds(raw)
    collect(decoded)
    if (isQuery && decoded.includes('+')) collect(decoded.replace(/\+/g, ' '))

    // Decode before lower-casing: base64url is case-sensitive.
    for (const m of decoded.matchAll(BASE64_RUN_RE)) {
      const text = decodeBase64Url(m[0])
      if (text) collect(text)
    }
    for (const m of decoded.matchAll(HEX_RUN_RE)) {
      const text = decodeHex(m[0])
      if (text) collect(text)
    }
  }

  return [...out]
}

/** First 16 bytes of HMAC-SHA-256(hashKey, token) as 32-char lowercase hex. */
export async function digestToken(hashKey: string, token: string): Promise<string> {
  if (!hashKey) throw new AuditKeyMissingError()
  let key = hmacKeys.get(hashKey)
  if (!key) {
    key = crypto.subtle.importKey('raw', enc.encode(hashKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    hmacKeys.set(hashKey, key)
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key, enc.encode(token)))
  return [...mac.subarray(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Whether a file's content type is text-like and should be scanned for tokens when served to a session. */
export function isTextLikeContentType(contentType: string): boolean {
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase()
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')
}

export interface TaintStoreOptions {
  ttlMs?: number
  maxRows?: number
  evictBatch?: number
}

export interface TaintStore {
  /** Extracts up to 500 high-signal tokens from `text` and stores their digests. Returns the count stored. */
  capture(text: string): Promise<number>
  /** Returns true if any candidate token in `url` matches a non-expired digest in `egress_taint`. */
  checkUrl(url: URL): Promise<boolean>
}

export function taintStore(
  db: D1Database,
  hashKey: string,
  now: () => number = () => Date.now(),
  opts: TaintStoreOptions = {},
): TaintStore {
  const ttlMs = opts.ttlMs ?? TAINT_TTL_MS
  const maxRows = opts.maxRows ?? TAINT_MAX_ROWS
  const evictBatch = opts.evictBatch ?? TAINT_EVICT_BATCH

  return {
    async capture(text: string): Promise<number> {
      const tokens = extractTokens(text, TAINT_MAX_TOKENS_PER_RESULT)
      if (tokens.length === 0) return 0
      const digests = await Promise.all(tokens.map(t => digestToken(hashKey, t)))
      const at = now()
      const cutoff = at - ttlMs

      const stmts: D1PreparedStatement[] = []
      for (let i = 0; i < digests.length; i += INSERT_CHUNK_ROWS) {
        const chunk = digests.slice(i, i + INSERT_CHUNK_ROWS)
        const placeholders = chunk.map(() => '(?, ?)').join(', ')
        const params: (string | number)[] = []
        for (const d of chunk) params.push(d, at)
        stmts.push(
          db
            .prepare(`INSERT INTO egress_taint (digest, seen_at_ms) VALUES ${placeholders} ON CONFLICT(digest) DO UPDATE SET seen_at_ms = excluded.seen_at_ms`)
            .bind(...params),
        )
      }
      // Bounded expiry delete in the same batch.
      stmts.push(
        db
          .prepare('DELETE FROM egress_taint WHERE digest IN (SELECT digest FROM egress_taint WHERE seen_at_ms < ? ORDER BY seen_at_ms ASC LIMIT ?)')
          .bind(cutoff, evictBatch),
      )
      await db.batch(stmts)

      // Enforce the row cap with a bounded delete of the oldest rows.
      const row = await db.prepare('SELECT COUNT(*) AS n FROM egress_taint').first<{ n: number }>()
      const count = row?.n ?? 0
      if (count > maxRows) {
        const drop = Math.min(count - maxRows, evictBatch)
        await db
          .prepare('DELETE FROM egress_taint WHERE digest IN (SELECT digest FROM egress_taint ORDER BY seen_at_ms ASC, digest ASC LIMIT ?)')
          .bind(drop)
          .run()
      }

      return digests.length
    },

    async checkUrl(url: URL): Promise<boolean> {
      const tokens = extractUrlTokens(url)
      if (tokens.length === 0) return false
      const digests = await Promise.all(tokens.map(t => digestToken(hashKey, t)))
      const cutoff = now() - ttlMs

      for (let i = 0; i < digests.length; i += SELECT_CHUNK_DIGESTS) {
        const chunk = digests.slice(i, i + SELECT_CHUNK_DIGESTS)
        const placeholders = chunk.map(() => '?').join(', ')
        const hit = await db
          .prepare(`SELECT 1 AS hit FROM egress_taint WHERE seen_at_ms >= ? AND digest IN (${placeholders}) LIMIT 1`)
          .bind(cutoff, ...chunk)
          .first<{ hit: number }>()
        if (hit) return true
      }
      return false
    },
  }
}
