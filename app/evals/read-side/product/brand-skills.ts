import { randomUUID } from 'node:crypto'
import { deleteSkill, getSkill, saveSkill, type SkillDatabase, type SkillInput, type SkillQueryResult, type SkillStatement } from '../../../server/brand-skills/store.ts'
import { renderStmt, type SqlValue, type Stmt } from '../../../server/db/sql-statement.ts'
import type { wranglerQueries } from '../../targets/door.ts'

/** Use the store's statements and batch boundaries on the sandbox database. */
export function fixtureDatabase(query: ReturnType<typeof wranglerQueries>): SkillDatabase {
  async function execute<T>(statements: Stmt[]): Promise<SkillQueryResult<T>[]> {
    const results = await query(statements.map(renderStmt).join('\n'))
    if (!Array.isArray(results) || results.length !== statements.length ||
        results.some(r => r?.success !== true || !Array.isArray(r.results) || !Number.isSafeInteger(r.meta?.changes))) {
      throw new Error('read-side: D1 did not return a result for every fixture statement')
    }
    return results as SkillQueryResult<T>[]
  }
  class Statement implements SkillStatement {
    private readonly statement: Stmt
    constructor(statement: Stmt) { this.statement = statement }
    bind(...values: unknown[]) {
      const params = values.map((v): SqlValue => {
        if (typeof v === 'string' || typeof v === 'number' || v === null) return v
        throw new Error('read-side: unsupported fixture SQL parameter')
      })
      return new Statement({ sql: this.statement.sql, params })
    }
    async first<T>(): Promise<T | null> {
      return (await this.all<T>()).results[0] ?? null
    }
    async all<T>(): Promise<SkillQueryResult<T>> {
      return (await execute<T>([this.statement]))[0]!
    }
    static sql(statement: SkillStatement): Stmt {
      if (!(statement instanceof Statement)) throw new Error('read-side: foreign fixture statement')
      return statement.statement
    }
  }
  return {
    prepare: sql => new Statement({ sql, params: [] }),
    batch: statements => execute(statements.map(Statement.sql)),
  }
}

export interface SkillFixture {
  save(): Promise<void>
  remove(): Promise<void>
}

export function brandSkillFixture(db: SkillDatabase, actorId: string, input: SkillInput): SkillFixture {
  const requestId = `read-side-${randomUUID()}`
  const at = () => ({ actorId, requestId, nowMs: Date.now() })
  let id: string | undefined
  let saving: Promise<void> | undefined
  let removing: Promise<void> | undefined
  return {
    save: () => (saving ??= (async () => {
      const saved = await saveSkill(db, input, at(), { createOnly: true })
      if ('refused' in saved) throw new Error(`read-side: brand skill fixture could not be saved (${saved.refused})`)
      id = saved.ok.id
    })()),
    remove: () => (removing ??= (async () => {
      if (!saving) return
      // Wait for the write on a stop. If its reply was lost, only this request's stamped row is ours.
      await saving.catch(() => undefined)
      const row = await getSkill(db, input.name)
      if (!row || (id ? row.id !== id : !row.req_id?.startsWith(`${requestId}#`))) return
      const removed = await deleteSkill(db, { id: row.id, ifRev: row.rev }, at())
      if (!('ok' in removed) && !('refused' in removed && removed.refused === 'not_found')) {
        throw new Error('read-side: brand skill fixture could not be deleted')
      }
    })()),
  }
}
