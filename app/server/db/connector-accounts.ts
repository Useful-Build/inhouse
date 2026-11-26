// Connector accounts (P5 W1, p5-w1.md section 9): the product's lifecycle record of each hub connector account, for the
// Tools page. The hub's SignIn object is the truth for the token, its state, `paused` and `needsReconnect`; this table
// only says who connected or disconnected it and when, and that a connect is under way. Rows are created on first use
// (an upsert). Every change and its audit line go in one batch, the line guarded on the row this write stamped (the
// audit writer's rule), so a line is written exactly when its change applied. No token, code or verifier is stored.
// W3's ToolsAccounts adapter reads `list` and calls `recordPause` and `recordDisconnect` with its own audit lines.
import type { AuditArgs, ConnectOutcome } from '../../shared/contract/audit.ts'
import { auditInsert } from './audit.ts'
import type { AuditHook } from './audit.ts'
import { writeStamp } from './ids.ts'
import type { At } from './members.ts'
import { all, first, runBatch, stmt } from './sql.ts'
import type { Stmt } from './sql.ts'
import { revokeAccountGrantsStmts } from '../permissions/grants.ts'

export type ConnectorLastState = 'never' | 'connecting' | 'connected' | 'failed' | 'disconnected'

export interface ConnectorAccountRow {
  account_id: string
  connector: string
  last_state: ConnectorLastState
  last_state_at_ms: number
  connected_by: string | null
  connected_at_ms: number | null
  disconnected_by: string | null
  disconnected_at_ms: number | null
  rev: number
}

/** A row as the server hands it on (W3 merges it with the hub's AccountStatus). Member ids only. */
export interface ConnectorAccount {
  accountId: string
  connector: string
  lastState: ConnectorLastState
  lastStateAtMs: number
  connectedBy: string | null
  connectedAtMs: number | null
  disconnectedBy: string | null
  disconnectedAtMs: number | null
  rev: number
}

const record = (r: ConnectorAccountRow): ConnectorAccount => ({
  accountId: r.account_id,
  connector: r.connector,
  lastState: r.last_state,
  lastStateAtMs: r.last_state_at_ms,
  connectedBy: r.connected_by,
  connectedAtMs: r.connected_at_ms,
  disconnectedBy: r.disconnected_by,
  disconnectedAtMs: r.disconnected_at_ms,
  rev: r.rev,
})

export interface ConnectorAccountStoreDeps {
  db: D1Database
  hook?: AuditHook
}

/** The upsert's columns besides the key; each call sets the ones it changes, the rest keep their stored values. */
type Change = { last_state: ConnectorLastState } & Partial<Pick<ConnectorAccountRow, 'connected_by' | 'connected_at_ms' | 'disconnected_by' | 'disconnected_at_ms'>>

export function connectorAccountStore({ db, hook = s => s }: ConnectorAccountStoreDeps) {
  /** One upsert (rev + 1 on an existing row) and its audit line, in one batch. */
  /**
   * `lapses`: Stage 1 M2-A (N10), the grants this change ends, written in the same batch and only where the change
   * applied (given the condition that this write's row is stamped).
   */
  const change = async (accountId: string, connector: string, c: Change, line: AuditArgs, at: At, lapses?: (applied: { sql: string; params: string[] }) => Stmt[]): Promise<void> => {
    const stamp = writeStamp(at.requestId)
    const extra = Object.keys(c).filter(k => k !== 'last_state') as (keyof Change)[]
    const cols = ['account_id', 'connector', 'last_state', 'last_state_at_ms', ...extra, 'req_id']
    const values = [accountId, connector, c.last_state, at.nowMs, ...extra.map(k => c[k] ?? null), stamp]
    const updates = ['last_state = excluded.last_state', 'last_state_at_ms = excluded.last_state_at_ms', ...extra.map(k => `${k} = excluded.${k}`), 'rev = connector_accounts.rev + 1', 'req_id = excluded.req_id']
    await runBatch(db, [
      stmt(
        `INSERT INTO connector_accounts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
         ON CONFLICT (account_id) DO UPDATE SET ${updates.join(', ')}`,
        ...values,
      ),
      hook(auditInsert(
        { atMs: at.nowMs, actorId: at.actorId, args: line, target: { kind: 'connector', id: accountId }, requestId: at.requestId },
        { table: 'connector_accounts', where: 'account_id = ?', params: [accountId], stamp },
      )),
      ...(lapses ? lapses({ sql: 'SELECT 1 FROM connector_accounts WHERE account_id = ? AND req_id = ?', params: [accountId, stamp] }) : []),
    ])
  }

  return {
    /** Every row, by account id. */
    async list(): Promise<ConnectorAccount[]> {
      return (await all<ConnectorAccountRow>(db, stmt('SELECT * FROM connector_accounts ORDER BY account_id'))).map(record)
    },

    async get(accountId: string): Promise<ConnectorAccount | null> {
      const r = await first<ConnectorAccountRow>(db, stmt('SELECT * FROM connector_accounts WHERE account_id = ?', accountId))
      return r && record(r)
    },

    /** Route A: a connect started. `last_state = 'connecting'`, with its `tools.connect_start` line. */
    connectStarted(accountId: string, connector: string, at: At): Promise<void> {
      return change(accountId, connector, { last_state: 'connecting' }, { action: 'tools.connect_start', accountId }, at)
    },

    /**
     * Route B: how a connect ended, with its `tools.connect` line. On `ok`, `connected` with who and when; otherwise
     * `lastState` is what the hub says now (`connected` if still active, else `failed`, `disconnected` or `never`), so
     * an abandoned or refused connect never sticks on `connecting`.
     */
    connectEnded(accountId: string, connector: string, outcome: ConnectOutcome, lastState: Exclude<ConnectorLastState, 'connecting'>, at: At): Promise<void> {
      const c: Change = outcome === 'ok' ? { last_state: 'connected', connected_by: at.actorId, connected_at_ms: at.nowMs } : { last_state: lastState }
      // A connect that succeeded is a new generation (`connected_at_ms`): grants on any other generation end (N10).
      return change(accountId, connector, c, { action: 'tools.connect', accountId, outcome }, at,
        outcome === 'ok' ? applied => revokeAccountGrantsStmts(accountId, at.nowMs, at, applied) : undefined)
    },

    /** W3: a pause or resume is the hub's (SignIn `paused`); here only its audit line, unguarded (no row changes). */
    async recordPause(accountId: string, line: AuditArgs, at: At): Promise<void> {
      await runBatch(db, [hook(auditInsert({ atMs: at.nowMs, actorId: at.actorId, args: line, target: { kind: 'connector', id: accountId }, requestId: at.requestId }, null))])
    },

    /** W3: a disconnect, as one batch: `disconnected`, who and when, rev + 1, and W3's audit line. */
    recordDisconnect(accountId: string, connector: string, line: AuditArgs, at: At): Promise<void> {
      return change(accountId, connector, { last_state: 'disconnected', disconnected_by: at.actorId, disconnected_at_ms: at.nowMs }, line, at,
        applied => revokeAccountGrantsStmts(accountId, null, at, applied))
    },
  }
}

export type ConnectorAccountStore = ReturnType<typeof connectorAccountStore>
