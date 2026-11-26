// Fetch leak check (M1-G, N8): one defence-in-depth layer against data exfiltration through WebFetch URLs.
//
// How it works:
//  - Capture: after `/hub/` and `/mcp/` respond, and when `/files/` serves a text-like file to a session, extract
//    high-signal tokens (at most 500 per result, highest signal first) and store their keyed HMAC-SHA-256 digests
//    (first 16 bytes, 32-char lowercase hex, keyed with `AUDIT_HASH_KEY` over a domain-separated input) in
//    `egress_taint` before returning. A JSON result is parsed and its string leaves walked (a JSON string inside a
//    string, such as the hub's `result.content[].text`, is unwrapped), so JSON escapes never glue characters onto a
//    token; anything that isn't JSON is read as raw text.
//  - What counts as private (decision L2, 2026-11-26): customer and order data is captured (names, emails, phones,
//    addresses, order numbers and ids, customer ids). Product catalogue data is not: a Shopify id of a catalogue type
//    (product, variant, inventory item, location...) is skipped wherever it appears, and in a hub result the catalogue
//    fields (`title`, `handle`, `sku`, `vendor`, `productType`) give up emails only. So a storefront page or
//    `?variant=<id>` stays fetchable after the agent read the product.
//  - Check: before DNS and on every redirect hop in `WebEgress`, percent-decode URL parts (two rounds), tokenize host
//    labels, the joined host, path segments, query names/values (also with `+` as a space) and the fragment as they
//    are, and base64url-/hex-decode runs (base64 at offsets 0-3 and with 0-3 trailing characters dropped, hex at
//    offsets 0-1 likewise) before lower-casing; decoded text is percent-decoded again. A URL token also yields its
//    sub-runs split on `-` and `_` (and an email its local-part suffixes and domain prefixes), so a token with
//    adjacent characters still matches. Any digest present in `egress_taint` (within 7 days) refuses the hop (`leak`).
//  - Brand-wide: the web intercept knows only the container (`EgressProps`), never the turn, so the store is brand-wide.
//  - Retention and cap: rows expire after 7 days and the table is capped at 50,000 rows (oldest evicted in bounded
//    deletes; an exact count runs only when the cheap rowid span says the table may be over).
//  - Fail closed: a capture failure fails the tool/file response; a check failure refuses the fetch, and so does a URL
//    with more than `MAX_URL_CANDIDATES` candidate tokens.
//
// Known gaps (N8 and the review of PR #427):
//  - paraphrased data (rewritten or summarised facts without the original token);
//  - short numbers (fewer than 8 digits, except `#` order names with 3+ digits), phone numbers written with separators,
//    names and street addresses (plain words);
//  - data older than 7 days (expired from `egress_taint`), and a replayed transcript older than 7 days;
//  - the 500-token cut per result: a result with more tokens stores only the 500 highest-signal ones;
//  - the 50,000-row cap: after many large reads the oldest digests are evicted before their 7 days;
//  - binary files (office documents, PDFs, images) are not read, so nothing in them is captured;
//  - a token split across URL parts (half in the path, half in the query), or across a `/` of a standard-base64 run;
//  - adjacent letters or digits with no separator (`xalice@example.com`, `55500000010019`), and a token buried among
//    more than 24 `-`/`_`-joined parts; encodings other than percent, base64/base64url and hex, or nested encodings
//    beyond base64/hex then percent;
//  - a base64 or hex run with 4 or more characters glued on before or after it at an unaligned offset.
import { AuditKeyMissingError } from '../db/audit.ts'
import { extractUrlTokens, resultTokens, TAINT_MAX_TOKENS_PER_RESULT, type TaintSource } from './taint-tokens.ts'

export {
  decodePercentTwoRounds, extractTokens, extractUrlTokens, isTextLikeContentType, resultTokens, TAINT_MAX_TOKENS_PER_RESULT,
  type CaptureTaint, type TaintSource,
} from './taint-tokens.ts'

export const TAINT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const TAINT_MAX_ROWS = 50_000
/** Bounded eviction size per capture write so one request never scans or deletes the whole table. */
export const TAINT_EVICT_BATCH = 500
/** More candidate tokens than this in one URL refuses it (fail closed) rather than hashing and looking up all of them. */
export const MAX_URL_CANDIDATES = 4096
/** The MAC input's domain separator, so a digest here can't be linked to the audit log's hashes under the same key. */
const DIGEST_DOMAIN = 'egress-taint/v1\0'
/** Chunk sizes stay under D1's 100 bind-parameter limit per statement. */
const INSERT_CHUNK_ROWS = 40
const SELECT_CHUNK_DIGESTS = 90

const enc = new TextEncoder()
const hmacKeys = new Map<string, Promise<CryptoKey>>()

/** First 16 bytes of HMAC-SHA-256(hashKey, `egress-taint/v1\0` + token) as 32-char lowercase hex. */
export async function digestToken(hashKey: string, token: string): Promise<string> {
  if (!hashKey) throw new AuditKeyMissingError()
  let key = hmacKeys.get(hashKey)
  if (!key) {
    key = crypto.subtle.importKey('raw', enc.encode(hashKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    hmacKeys.set(hashKey, key)
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key, enc.encode(`${DIGEST_DOMAIN}${token}`)))
  return [...mac.subarray(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface TaintStoreOptions {
  ttlMs?: number
  maxRows?: number
  evictBatch?: number
}

export interface TaintStore {
  /** Extracts up to 500 high-signal tokens from a result and stores their digests. Returns the count stored. */
  capture(body: string, source: TaintSource): Promise<number>
  /** Returns true if any candidate token in `url` matches a non-expired digest in `egress_taint` (or `url` has too many). */
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

  /**
   * The row cap without a full count on every capture. `INSERT OR REPLACE` gives a re-sighted digest a new rowid, so
   * the rowid span (two b-tree edge reads) bounds the row count from above; only when it passes the cap does an exact
   * count run, and then the oldest rows go in one bounded delete.
   */
  async function enforceCap(): Promise<void> {
    const span = await db
      .prepare('SELECT (SELECT max(rowid) FROM egress_taint) - (SELECT min(rowid) FROM egress_taint) + 1 AS n')
      .first<{ n: number | null }>()
    if ((span?.n ?? 0) <= maxRows) return
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM egress_taint').first<{ n: number }>())?.n ?? 0
    if (count <= maxRows) return
    await db
      .prepare('DELETE FROM egress_taint WHERE rowid IN (SELECT rowid FROM egress_taint ORDER BY seen_at_ms ASC, rowid ASC LIMIT ?)')
      .bind(Math.min(count - maxRows, evictBatch))
      .run()
  }

  return {
    async capture(body: string, source: TaintSource): Promise<number> {
      const tokens = resultTokens(body, source, TAINT_MAX_TOKENS_PER_RESULT)
      if (tokens.length === 0) return 0
      const digests = await Promise.all(tokens.map(t => digestToken(hashKey, t)))
      const at = now()
      const cutoff = at - ttlMs

      // Bounded expiry delete first, then the digests (a re-sighted one is replaced: fresh time, fresh rowid).
      const stmts: D1PreparedStatement[] = [
        db
          .prepare('DELETE FROM egress_taint WHERE rowid IN (SELECT rowid FROM egress_taint WHERE seen_at_ms < ? ORDER BY seen_at_ms ASC LIMIT ?)')
          .bind(cutoff, evictBatch),
      ]
      for (let i = 0; i < digests.length; i += INSERT_CHUNK_ROWS) {
        const chunk = digests.slice(i, i + INSERT_CHUNK_ROWS)
        const params: (string | number)[] = []
        for (const d of chunk) params.push(d, at)
        stmts.push(db.prepare(`INSERT OR REPLACE INTO egress_taint (digest, seen_at_ms) VALUES ${chunk.map(() => '(?, ?)').join(', ')}`).bind(...params))
      }
      await db.batch(stmts)
      await enforceCap()
      return digests.length
    },

    async checkUrl(url: URL): Promise<boolean> {
      const tokens = extractUrlTokens(url)
      if (tokens.length === 0) return false
      if (tokens.length > MAX_URL_CANDIDATES) return true
      const digests = await Promise.all(tokens.map(t => digestToken(hashKey, t)))
      const cutoff = now() - ttlMs
      const stmts: D1PreparedStatement[] = []
      for (let i = 0; i < digests.length; i += SELECT_CHUNK_DIGESTS) {
        const chunk = digests.slice(i, i + SELECT_CHUNK_DIGESTS)
        stmts.push(
          db
            .prepare(`SELECT 1 AS hit FROM egress_taint WHERE seen_at_ms >= ? AND digest IN (${chunk.map(() => '?').join(', ')}) LIMIT 1`)
            .bind(cutoff, ...chunk),
        )
      }
      const results = await db.batch<{ hit: number }>(stmts)
      return results.some(r => r.results.length > 0)
    },
  }
}
