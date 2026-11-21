// The product target's memory door. No route makes or approves a memory fact (a person's saved fact counts at once, a team
// fact waits for an admin, and only the agent's tools write either), so the harness seeds each case's memory, and reads what a
// chat changed, through the eval deployment's own D1. Three rules bind it (A8, 2026-11-21):
//   (a) it is made only after the eval-brand check passed (createDoor is called by the product session setup after it);
//   (b) it refuses any database that isn't a sandbox one: the name must pass the sandbox name rule (`inhouse-sbx-...`, the
//       same pattern as scripts/sandbox/names.mjs, pinned by a test against that file) and CF_SANDBOX_ACCOUNT_ID must be set;
//   (c) its credentials come from the environment (wrangler reads CLOUDFLARE_API_TOKEN itself) and are never logged: wrangler's
//       stderr is dropped, and a failure names only the command's exit status.
// Statements are built here from invented case text with every string literal quoted; ids are checked against a pattern.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

export class DoorRefusal extends Error {
  override name = 'DoorRefusal'
}

/** The sandbox-wide name rule of scripts/sandbox/names.mjs (SANDBOX_WIDE): the shared candidate and every per-PR deployment. */
export const SANDBOX_DB = /^inhouse-sbx-[a-z0-9-]+$/
const MEMORY_ID = /^mem_[A-Za-z0-9_-]{22}$/
const MEMBER_ID = /^[A-Za-z0-9_-]{1,80}$/

export interface MemoryRow {
  id: string
  scope: 'brand' | 'person'
  ownerId: string | null
  text: string
  status: 'active' | 'waiting' | 'forgotten'
  rev: number
}
export interface NewMemory {
  id: string
  scope: 'brand' | 'person'
  ownerId: string | null
  text: string
}

export interface MemoryDoor {
  /** Every fact in the brand's memory, whatever its status. */
  rows(): Promise<MemoryRow[]>
  /** Puts facts in, active (the case's premise is that the agent knows them). */
  insert(facts: NewMemory[]): Promise<void>
  /** Empties the brand's memory: the eval brand holds nothing a case-repeat should carry over. */
  clear(): Promise<void>
}

export const newMemoryId = (): string => `mem_${randomBytes(16).toString('base64url')}`
export const sqlString = (s: string): string => `'${s.replaceAll("'", "''")}'`

/** Runs one SQL statement on the database and returns the rows it answered (none for a write). */
export type RunSql = (sql: string) => Promise<Record<string, unknown>[]>

export function assertSandboxDatabase(name: string | undefined, env: Record<string, string | undefined>): string {
  if (!name) throw new DoorRefusal('refusing: INHOUSE_EVAL_D1_NAME is not set (the eval deployment\'s D1 database)')
  if (!SANDBOX_DB.test(name)) throw new DoorRefusal(`refusing: ${JSON.stringify(name)} is not a sandbox database name (inhouse-sbx-...)`)
  if (!env.CF_SANDBOX_ACCOUNT_ID) throw new DoorRefusal('refusing: CF_SANDBOX_ACCOUNT_ID is not set, so the target is not known to be the sandbox account')
  return name
}

export function createDoor(run: RunSql): MemoryDoor {
  return {
    async rows() {
      const out = await run('SELECT id, scope, owner_id, text, status, rev FROM memories ORDER BY n')
      return out.map((r) => ({ id: String(r.id), scope: r.scope as MemoryRow['scope'], ownerId: r.owner_id === null ? null : String(r.owner_id), text: String(r.text), status: r.status as MemoryRow['status'], rev: Number(r.rev) }))
    },
    async insert(facts) {
      if (facts.length === 0) return
      const now = Date.now()
      const values = facts.map((f) => {
        if (!MEMORY_ID.test(f.id)) throw new DoorRefusal(`not a memory id: ${f.id}`)
        if (f.ownerId !== null && !MEMBER_ID.test(f.ownerId)) throw new DoorRefusal('not a member id')
        return `(${sqlString(f.id)}, ${sqlString(f.scope)}, ${f.ownerId === null ? 'NULL' : sqlString(f.ownerId)}, ${sqlString(f.text)}, 'active', 'eval', ${now}, ${now})`
      })
      await run(`INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES ${values.join(', ')}`)
    },
    async clear() {
      await run('DELETE FROM memories')
    },
  }
}

export interface WranglerOptions {
  database: string
  /** The sandbox wrangler config that binds the database (wrangler finds the D1 id there). */
  config: string
  env: Record<string, string | undefined>
  /** Replaces the process spawn (tests). Gets the argv after `wrangler`. */
  spawn?: (args: string[], env: Record<string, string | undefined>) => { status: number | null; stdout: string }
}

const defaultSpawn: NonNullable<WranglerOptions['spawn']> = (args, env) => {
  const r = spawnSync('npx', ['--no-install', 'wrangler', ...args], { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: env as NodeJS.ProcessEnv, maxBuffer: 16 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout ?? '' }
}

/** `wrangler d1 execute <name> --remote --json --command <sql>`, for a database that passes the sandbox rule only. */
export function wranglerRunner(o: WranglerOptions): RunSql {
  const database = assertSandboxDatabase(o.database, o.env)
  // Wrangler works in the sandbox account named by CF_SANDBOX_ACCOUNT_ID, never one the shell happens to default to.
  const env = { ...o.env, CLOUDFLARE_ACCOUNT_ID: o.env.CF_SANDBOX_ACCOUNT_ID }
  const spawn = o.spawn ?? defaultSpawn
  return async (sql) => {
    const r = spawn(['d1', 'execute', database, '--remote', '--config', o.config, '--json', '--yes', '--command', sql], env)
    if (r.status !== 0) throw new DoorRefusal(`wrangler d1 execute exited ${r.status}`)
    try {
      const parsed = JSON.parse(r.stdout) as { results?: Record<string, unknown>[] }[]
      return parsed[0]?.results ?? []
    } catch {
      throw new DoorRefusal('wrangler d1 execute answered something that is not JSON')
    }
  }
}
