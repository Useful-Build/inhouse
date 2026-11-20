// The test build's local D1, read from the spec's side: the audit log's stored arguments are not in any API answer
// (names and emails must not be in them), so the specs read the SQLite file `wrangler dev --persist-to` keeps.
// `writeSql` is for the one thing no request can do: put a tab or a carriage return first in a stored name (the API
// trims names), to see the CSV export defuse it. Both open the file fresh per call and wait for a busy lock.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { expect } from '@playwright/test'

const persist = fileURLToPath(new URL('../../.wrangler/test-build/v3/d1', import.meta.url))
// Looked up on every call: a reset may recreate the persist folder, so a path kept from before could be gone.
function dbFile(): string {
  const files = readdirSync(persist, { recursive: true, withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.sqlite')).map(d => join(d.parentPath, d.name))
  for (const f of files) {
    const db = new DatabaseSync(f, { readOnly: true })
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get() !== undefined) return f
    } finally {
      db.close()
    }
  }
  throw new Error(`No local D1 with an audit_log under ${persist}.`)
}

function open(readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(dbFile(), { readOnly })
  db.exec('PRAGMA busy_timeout = 10000')
  return db
}

type Param = string | number | null

export function readSql<T = Record<string, unknown>>(query: string, ...params: Param[]): T[] {
  const db = open(true)
  try {
    return db.prepare(query).all(...params) as T[]
  } finally {
    db.close()
  }
}

export function writeSql(query: string, ...params: Param[]): void {
  const db = open(false)
  try {
    db.prepare(query).run(...params)
  } finally {
    db.close()
  }
}

export interface AuditRow {
  id: number
  at_ms: number
  actor_id: string
  action: string
  target_kind: string | null
  target_id: string | null
  args_json: string
}

const COLUMNS = 'id, at_ms, actor_id, action, target_kind, target_id, args_json'

/** The newest line's id (0 for an empty log). */
export const auditMax = (): number => readSql<{ n: number }>('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log')[0].n

/** Every line after `id`, oldest first. */
export const auditAfter = (id: number): AuditRow[] => readSql<AuditRow>(`SELECT ${COLUMNS} FROM audit_log WHERE id > ? ORDER BY id`, id)

export const auditWhere = (action: string): AuditRow[] => readSql<AuditRow>(`SELECT ${COLUMNS} FROM audit_log WHERE action = ? ORDER BY id`, action)

/** What one write must leave: exactly one line since `mark`, of this action, by this member (a member id), with none of `avoid` (nor an email) in its arguments. */
export function expectOneLine(mark: number, action: string, actorId: string, avoid: string[] = []): AuditRow {
  const lines = auditAfter(mark)
  expect(lines.map(l => l.action), 'a write adds exactly one line').toEqual([action])
  const [line] = lines
  expect(line.actor_id).toBe(actorId)
  expect(line.actor_id).toMatch(/^m_/)
  for (const text of ['@', 'example.test', ...avoid]) expect(line.args_json, `args hold no "${text}"`).not.toContain(text)
  return line
}
