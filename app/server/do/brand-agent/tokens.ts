// Run tokens (p3-design section 5): the secret a turn's runner presents on every egress call. 32 random bytes,
// base64url; the BrandAgent keeps only its SHA-256 (hex) in `run_tokens`, never the token. A token lives 45 minutes
// (the runner ends a turn at 30), and its routes close in two steps: `model`, `mcp`, `files`, `audit` at the turn's
// terminal event or fence, `store` and `events` at `released` (section 4.2.8). Minted after the claim and before
// placement; never for an Inhouse principal (none submits a turn).

export type EgressRoute = 'model' | 'mcp' | 'store' | 'files' | 'events' | 'audit'
export const EGRESS_ROUTES: readonly EgressRoute[] = ['model', 'mcp', 'store', 'files', 'events', 'audit']

export interface RunGrant {
  turnId: string
  runId: string
  chatId: string
  memberId: string
  sessionId: string
  model: string
  sideModel: string
  /**
   * The helpers' model (Stage 1, N6), or null when the turn has no helpers. The egress allows it beside the two above.
   * A token read back always has it (null for none); a mint may leave it out (none).
   */
  subagentModel?: string | null
  expiresAtMs: number
}

/** `closed`: this route is closed for the turn (its other routes may still be open). */
export type TokenRefusal = 'unknown' | 'revoked' | 'expired' | 'closed'

export interface RunTokens {
  /** 32 random bytes; stores the SHA-256 only. Returns the token, which goes to the runner and nowhere else. */
  mint(grant: Omit<RunGrant, 'expiresAtMs'>, nowMs: number): Promise<string>
  check(tokenHash: string, route: EgressRoute, nowMs: number): RunGrant | { refused: TokenRefusal }
  closeRoutes(turnId: string, routes: EgressRoute[], why: string): void
  revokeTurn(turnId: string, why: string): void
  revokeMember(memberId: string, why: string): void
  revokeAll(why: string): void
  /** Revokes one attempt's token (a turn fenced while its token was minted; a placement retry's old token). */
  revokeToken(tokenHash: string, why: string): void
  /** Deletes rows expired more than `RUN_TOKEN_KEEP_MS` before `nowMs` (the table never grows without bound). */
  prune(nowMs: number): void
}

/** How long a token lives (CHOICE, Fable: above the runner's 30-minute turn). */
export const RUN_TOKEN_TTL_MS = 45 * 60_000
/** How long an expired token's row is kept (its refusal stays `expired`, not `unknown`, for a day of logs). */
export const RUN_TOKEN_KEEP_MS = 24 * 60 * 60_000

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A token's SHA-256 as lowercase hex: what the table keys on and what the egress sends `checkRunToken`. */
export async function hashRunToken(token: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
}

/** The table, created if absent (additive, so it runs on every start). */
export function createRunTokensTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS run_tokens (
    token_hash TEXT PRIMARY KEY, turn_id TEXT NOT NULL, run_id TEXT NOT NULL, chat_id TEXT NOT NULL, member_id TEXT NOT NULL,
    session_id TEXT NOT NULL, model TEXT NOT NULL, side_model TEXT NOT NULL, subagent_model TEXT, routes_open TEXT NOT NULL,
    issued_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, revoke_reason TEXT)`)
  // Stage 1 M1-P: `subagent_model` on a table that predates it (NULL on an older token: no helper model allowed).
  const have = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('run_tokens')").toArray().map(r => r.name)
  if (!have.includes('subagent_model')) sql.exec('ALTER TABLE run_tokens ADD COLUMN subagent_model TEXT')
  sql.exec('CREATE INDEX IF NOT EXISTS run_tokens_turn ON run_tokens(turn_id)')
  sql.exec('CREATE INDEX IF NOT EXISTS run_tokens_member ON run_tokens(member_id)')
}

type Row = {
  turn_id: string; run_id: string; chat_id: string; member_id: string; session_id: string; model: string; side_model: string
  subagent_model: string | null; routes_open: string; expires_at_ms: number; revoked_at_ms: number | null
}

/** `routes_open` holds the open routes as `,model,mcp,…,` so one route is found as `,route,`. */
const routeList = (routes: readonly EgressRoute[]) => `,${routes.join(',')},`

/** The run tokens over the BrandAgent's SQLite. `now` stamps revocations (the interface's revokes take no time). */
export function createRunTokens(sql: SqlStorage, now: () => number): RunTokens {
  createRunTokensTable(sql)
  const revoke = (where: string, why: string, ...args: (string | number)[]) =>
    void sql.exec(`UPDATE run_tokens SET revoked_at_ms = ?, revoke_reason = ? WHERE revoked_at_ms IS NULL${where}`, now(), why, ...args)
  return {
    async mint(grant, nowMs) {
      const token = base64url(crypto.getRandomValues(new Uint8Array(32)))
      const hash = await hashRunToken(token)
      sql.exec(
        `INSERT INTO run_tokens (token_hash, turn_id, run_id, chat_id, member_id, session_id, model, side_model, subagent_model,
          routes_open, issued_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        hash, grant.turnId, grant.runId, grant.chatId, grant.memberId, grant.sessionId, grant.model, grant.sideModel, grant.subagentModel ?? null,
        routeList(EGRESS_ROUTES), nowMs, nowMs + RUN_TOKEN_TTL_MS,
      )
      return token
    },
    check(tokenHash, route, nowMs) {
      const row = sql.exec<Row>(
        `SELECT turn_id, run_id, chat_id, member_id, session_id, model, side_model, subagent_model, routes_open, expires_at_ms, revoked_at_ms
          FROM run_tokens WHERE token_hash = ?`, tokenHash,
      ).toArray()[0]
      if (!row) return { refused: 'unknown' }
      if (row.revoked_at_ms !== null) return { refused: 'revoked' }
      if (nowMs >= row.expires_at_ms) return { refused: 'expired' }
      if (!row.routes_open.includes(`,${route},`)) return { refused: 'closed' }
      return {
        turnId: row.turn_id, runId: row.run_id, chatId: row.chat_id, memberId: row.member_id, sessionId: row.session_id,
        model: row.model, sideModel: row.side_model, subagentModel: row.subagent_model, expiresAtMs: row.expires_at_ms,
      }
    },
    closeRoutes(turnId, routes, _why) {
      const rows = sql.exec<{ token_hash: string; routes_open: string }>('SELECT token_hash, routes_open FROM run_tokens WHERE turn_id = ?', turnId).toArray()
      for (const r of rows) {
        const open = EGRESS_ROUTES.filter(x => r.routes_open.includes(`,${x},`) && !routes.includes(x))
        sql.exec('UPDATE run_tokens SET routes_open = ? WHERE token_hash = ?', routeList(open), r.token_hash)
      }
    },
    revokeTurn(turnId, why) { revoke(' AND turn_id = ?', why, turnId) },
    revokeMember(memberId, why) { revoke(' AND member_id = ?', why, memberId) },
    revokeAll(why) { revoke('', why) },
    revokeToken(tokenHash, why) { revoke(' AND token_hash = ?', why, tokenHash) },
    prune(nowMs) { sql.exec('DELETE FROM run_tokens WHERE expires_at_ms < ?', nowMs - RUN_TOKEN_KEEP_MS) },
  }
}
