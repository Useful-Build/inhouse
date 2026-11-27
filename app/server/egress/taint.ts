// Fetch leak check (M1-G, N8): one defence-in-depth layer against data exfiltration through WebFetch URLs.
//
// How it works:
//  - Capture: after `/hub/` and `/mcp/` respond, and when `/files/` serves a text-like file to a session, extract
//    every high-signal token of the result and store their keyed HMAC-SHA-256 digests (first 16 bytes, 32-char
//    lowercase hex, keyed with `AUDIT_HASH_KEY` over a domain-separated input) in `egress_taint` before returning. A
//    result with more than 5,000 tokens fails the read closed (`TaintOverflowError`, a plain reason to the agent), so
//    junk earlier in a result can't push the real tokens out. A JSON result is parsed and its string and number leaves
//    and object keys walked (a JSON string inside a string, such as the hub's `result.content[].text`, is unwrapped),
//    so JSON escapes never glue characters onto a token; anything that isn't JSON is read as raw text.
//  - What counts as private (decision L2, 2026-11-26): customer and order data is captured (names, emails, phones,
//    addresses, order numbers and ids, customer ids). Product catalogue data is not, decided by source and path: only
//    the fixed-shape Shopify tools (the hub tool name read from the request) and only their catalogue paths
//    (`CATALOG_SHAPES` in taint-tokens.ts): the product tools' titles, skus and product/variant ids, and the order
//    tools' line-item skus (and `order_get`'s line titles). There a title or sku gives up emails only, and an id path
//    is skipped when the whole leaf is one bare product or variant id (no query). So a storefront page, `?variant=<id>`
//    or a sku stays fetchable after the agent read the product or an order that sold it, while the order's own fields
//    stay tainted. Every other tool (`shopify_script_run`, Slack, anything new), `/mcp/` and `/files/` are read in full.
//  - Check: before DNS and on every redirect hop in `WebEgress`, percent-decode URL parts (two rounds), tokenize host
//    labels, the joined host, path segments, query names/values (also with `+` as a space) and the fragment as they
//    are, and base64url-/hex-decode runs (base64 at offsets 0-3 and with 0-3 trailing characters dropped, hex at
//    offsets 0-1 likewise) before lower-casing; decoded text is percent-decoded again. A URL token also yields its
//    sub-runs split on `-` and `_` (and an email its local-part suffixes and domain prefixes), so a token with
//    adjacent characters still matches. Any digest present in `egress_taint` (within 7 days) refuses the hop (`leak`).
//  - Brand-wide: the web intercept knows only the container (`EgressProps`), never the turn, so the store is brand-wide.
//  - Retention and cap: rows expire after 7 days and the table is capped at 50,000 rows (oldest evicted in bounded
//    deletes; an exact count runs only when the cheap rowid span says the table may be over). Under heavy re-sighting
//    churn the span stays loose and that count (over at most 50,000 rows) can run on every capture: accepted.
//  - Junk can't evict a recent token unseen (#427, M3-F): eviction goes by age (expired rows first, then the least
//    recently seen); one result adds at most 5,000 rows (more fails the read); and while the table is full and its
//    oldest row was seen under a day ago (`TAINT_FULL_GUARD_MS`), every URL that carries a candidate token is refused
//    (`leak`). So a flood of junk reads closes fetch rather than opening it: a row evicted while it was under a day old
//    leaves the table full of rows newer than it, which keeps fetch closed until that row would be a day old. A token
//    is protected for its full 7 days unless junk fills the table, and then for at least a day.
//  - Fail closed: a capture failure fails the tool/file response; a check failure refuses the fetch, and so does a URL
//    with more than `MAX_URL_CANDIDATES` candidate tokens.
//
// Known gaps (N8 and the review of PR #427):
//  - paraphrased data (rewritten or summarised facts without the original token);
//  - short numbers (fewer than 8 digits, except `#` order names with 3+ digits), phone numbers written with separators,
//    names and street addresses (plain words);
//  - data older than 7 days (expired from `egress_taint`), and a replayed transcript older than 7 days;
//  - a result with more than 5,000 tokens isn't stored at all: the read fails instead (fail closed; a run's file
//    restore leaves such a file out of the work folder rather than failing the run);
//  - JSON embedded in non-JSON text is read as raw text, so its escapes can still glue a character onto a token
//    (`\nalice@...` as `nalice@...`): a tool answer like `Result: {...}`, and a file of JSON or NDJSON the agent or a
//    person saved as `text/plain` or `text/csv`, which `/files/` serves today;
//  - the 50,000-row cap: after many large reads (junk ones included) the oldest real digests can be evicted before
//    their 7 days, but never before a day (see "Junk can't evict" above); a brand that reads 50,000 distinct tokens
//    in a day has fetch refused for URLs with candidate tokens until its oldest row is a day old;
//  - binary files (office documents, PDFs, images) are not read, so nothing in them is captured;
//  - a token split across URL parts (half in the path, half in the query), or across a `/` of a standard-base64 run;
//  - adjacent letters or digits with no separator (`xalice@example.com`, `55500000010019`), and a token buried among
//    more than 24 `-`/`_`-joined parts; encodings other than percent, base64/base64url and hex, or nested encodings
//    beyond base64/hex then percent;
//  - a base64 or hex run with 4 or more characters glued on before or after it at an unaligned offset.
import { AuditKeyMissingError } from '../db/audit.ts'
import { extractUrlTokens, resultTokens, type TaintSource } from './taint-tokens.ts'

export {
  decodePercentTwoRounds, extractTokens, extractUrlTokens, isTextLikeContentType, resultTokens, TAINT_MAX_TOKENS_PER_RESULT,
  TaintOverflowError, type CaptureTaint, type TaintSource,
} from './taint-tokens.ts'

export const TAINT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const TAINT_MAX_ROWS = 50_000
/** Bounded eviction size per capture write so one request never scans or deletes the whole table. */
export const TAINT_EVICT_BATCH = 500
/**
 * While the table is full, fetch stays closed (for URLs with candidate tokens) until its oldest row was seen this long
 * ago: what eviction took from a full table was never newer than that row.
 */
export const TAINT_FULL_GUARD_MS = 24 * 60 * 60 * 1000
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
  /** Stores the digests of every high-signal token of a result (throws `TaintOverflowError` past 5,000). Returns the count. */
  capture(body: string, source: TaintSource): Promise<number>
  /**
   * Returns true if any candidate token in `url` matches a non-expired digest in `egress_taint`, if `url` has too many,
   * or if it has any while the table is full and its oldest row is under `TAINT_FULL_GUARD_MS` old.
   */
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
   * Whether the table is full with its oldest row seen under `TAINT_FULL_GUARD_MS` ago. The oldest time is an index
   * edge read; the count runs only when that row is recent and the rowid span (an upper bound on the count) reaches the cap.
   */
  async function fullOfRecent(atMs: number): Promise<boolean> {
    const edge = await db
      .prepare('SELECT (SELECT min(seen_at_ms) FROM egress_taint) AS oldest, (SELECT max(rowid) FROM egress_taint) - (SELECT min(rowid) FROM egress_taint) + 1 AS span')
      .first<{ oldest: number | null; span: number | null }>()
    if (!edge || edge.oldest === null || edge.oldest <= atMs - TAINT_FULL_GUARD_MS || (edge.span ?? 0) < maxRows) return false
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM egress_taint').first<{ n: number }>())?.n ?? 0
    return count >= maxRows
  }

  /**
   * The row cap without a full count on every capture. `INSERT OR REPLACE` gives a re-sighted digest a new rowid, so
   * the rowid span (two b-tree edge reads) bounds the row count from above; only when it passes the cap does the
   * eviction run, as one statement that counts the table inside itself and deletes the oldest rows, by age (expired ones
   * are the oldest), down to exactly `maxRows`. Counting inside the delete keeps overlapping captures from each deleting
   * the same excess: the table never drops under the cap, so the full-table guard can't be switched off by two reads at
   * once (M3-F review). Each delete is bounded by what its capture inserted (at most 5,000) or `evictBatch`.
   */
  async function enforceCap(inserted: number): Promise<void> {
    const span = await db
      .prepare('SELECT (SELECT max(rowid) FROM egress_taint) - (SELECT min(rowid) FROM egress_taint) + 1 AS n')
      .first<{ n: number | null }>()
    if ((span?.n ?? 0) <= maxRows) return
    await db
      .prepare(
        'DELETE FROM egress_taint WHERE rowid IN (SELECT rowid FROM egress_taint ORDER BY seen_at_ms ASC, rowid ASC LIMIT max(0, min((SELECT COUNT(*) FROM egress_taint) - ?, ?)))',
      )
      .bind(maxRows, Math.max(evictBatch, inserted))
      .run()
  }

  return {
    async capture(body: string, source: TaintSource): Promise<number> {
      const tokens = resultTokens(body, source)
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
      await enforceCap(digests.length)
      return digests.length
    },

    async checkUrl(url: URL): Promise<boolean> {
      const tokens = extractUrlTokens(url)
      if (tokens.length === 0) return false
      if (tokens.length > MAX_URL_CANDIDATES) return true
      const digests = await Promise.all(tokens.map(t => digestToken(hashKey, t)))
      const at = now()
      const cutoff = at - ttlMs
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
      if (results.some(r => r.results.length > 0)) return true
      return fullOfRecent(at)
    },
  }
}
