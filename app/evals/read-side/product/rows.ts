// The rows a case left in the deployment's D1, read-only through the door's RunSql (EVAL_DB, or a PR's database in the scripted
// proof). Every statement is a SELECT built from checked integers and ids; any value of the wrong shape is a DoorRefusal, which
// stops the run (a whole collection that can't be read).
//   - memory: every row the case's agent made or changed, any status. The door inserts the seeded facts with created_by 'eval'
//     and clears the table at each case's start (targets/door.ts), so a row not made by the door, or one changed since, is the
//     agent's;
//   - notices: every bell notice at or after the case's start;
//   - routines: every team routine made or changed at or after the case's start, with its id and revision for the delete,
//     except one the door's clear deleted (targets/door.ts, `req_id` 'eval': a server write's is `<request id>#<hex>`, never
//     'eval'). The clear runs at each case's seed and reset and stamps what it deletes with its own time, so without this a
//     routine left from before the run, or the previous case's (its reset clears it before the route 55 sweep), would read
//     as this case's;
//   - team requests: W3's `team_requests` rows at or after the case's start, when the table exists (sqlite_master); when the
//     preflight proved it absent, no row can exist, so the collection is observed empty and the report says which.
// Rows are scoped by time, not by the case's person or chat: the agent's brand-scope rows carry no owner, and a notice or routine
// it makes need not name the chat. The guard is the single eval lease (targets/door.ts takeLease): one runner per deployment, and
// cases run one at a time, so every row in a case's window is that case's.
import { DoorRefusal, sqlString, type RunSql } from '../../targets/door.ts'

const ms = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 0) throw new DoorRefusal('not a time in ms')
  return n
}
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new DoorRefusal(`the door read a ${what} that is not a string`)
  return v
}
const strOrNull = (v: unknown, what: string): string => (v === null ? '' : str(v, what))

export interface RoutineRow { id: string; rev: number; text: string; live: boolean }

export interface RowReader {
  /** Whether a table exists in the database. */
  hasTable(name: string): Promise<boolean>
  memoryTexts(): Promise<string[]>
  noticeTexts(sinceMs: number): Promise<string[]>
  routines(sinceMs: number): Promise<RoutineRow[]>
  /** Null only when the table is absent (`teamRequestsTable: false`): the caller turns that into an observed empty list and says so. */
  teamRequestTexts(sinceMs: number): Promise<string[] | null>
}

/** Each reader's statement, built in one place so the preflight probe runs exactly what the readers run. */
const SQL = {
  memory: () => "SELECT text FROM memories WHERE created_by <> 'eval' OR rev > 1 OR updated_at_ms <> created_at_ms",
  notices: (since: number) => `SELECT template, fields_json, body FROM notices WHERE at_ms >= ${ms(since)}`,
  routines: (since: number) => `SELECT id, rev, name, instruction, deleted_at_ms FROM routines WHERE origin = 'team' AND (created_at_ms >= ${ms(since)} OR updated_at_ms >= ${ms(since)}) AND NOT (deleted_at_ms IS NOT NULL AND req_id = 'eval')`,
  teamRequests: (since: number) => `SELECT * FROM team_requests WHERE created_at_ms >= ${ms(since)} OR updated_at_ms >= ${ms(since)}`,
}

export function createRowReader(run: RunSql, o: { teamRequestsTable: boolean }): RowReader & { probe(): Promise<void> } {
  return {
    /** Every reader's statement with LIMIT 0: a column that moved stops the run in the preflight, before any spend. */
    async probe() {
      for (const sql of [SQL.memory(), SQL.notices(0), SQL.routines(0), ...(o.teamRequestsTable ? [SQL.teamRequests(0)] : [])]) await run(`${sql} LIMIT 0`)
    },
    async hasTable(name) {
      if (!/^[a-z_]{1,64}$/.test(name)) throw new DoorRefusal('not a table name')
      return (await run(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${sqlString(name)}`)).length === 1
    },
    async memoryTexts() {
      const rows = await run(SQL.memory())
      return rows.map((r) => str(r.text, 'memory text'))
    },
    async noticeTexts(since) {
      const rows = await run(SQL.notices(since))
      return rows.map((r) => [str(r.template, 'notice template'), str(r.fields_json, 'notice fields'), strOrNull(r.body, 'notice body')].join('\n'))
    },
    async routines(since) {
      const rows = await run(SQL.routines(since))
      return rows.map((r) => {
        if (!Number.isInteger(r.rev)) throw new DoorRefusal('the door read a routine with no revision')
        return { id: str(r.id, 'routine id'), rev: r.rev as number, text: `${str(r.name, 'routine name')}\n${str(r.instruction, 'routine instruction')}`, live: r.deleted_at_ms === null }
      })
    },
    async teamRequestTexts(since) {
      if (!o.teamRequestsTable) return null
      // W3's columns are read as a whole row, so a column added later is read too: every text value in it counts.
      const rows = await run(SQL.teamRequests(since))
      return rows.map((r) => Object.values(r).filter((v): v is string => typeof v === 'string').join('\n'))
    },
  }
}
