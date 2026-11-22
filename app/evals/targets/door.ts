// The product target's memory door. No route makes or approves a memory fact (a person's saved fact counts at once, a team
// fact waits for an admin, and only the agent's tools write either), so the harness seeds each case's memory, and reads what a
// chat changed, through the eval deployment's own D1. Three rules bind it (A8, 2026-11-21):
//   (a) it is made only after the eval-brand check passed (createDoor is called by the product session setup after it);
//   (b) it refuses any database but the eval deployment's: the name must be exactly scripts/sandbox/names.mjs's
//       evalNames().d1 (`inhouse-sbx-eval-db`, pinned by a test against that file; a PR's test deployment runs the scripted
//       model and is never a paid eval's target), and CF_SANDBOX_ACCOUNT_ID must be set;
//   (c) its credentials come from the environment (wrangler reads CLOUDFLARE_API_TOKEN itself) and are never logged: wrangler's
//       stderr is dropped, and a failure names only the command's exit status.
// Statements are built here from invented case text with every string literal quoted; ids are checked against a pattern.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { capOk, parseHostlist } from '../../shared/contract/settings-table.ts'

export class DoorRefusal extends Error {
  override name = 'DoorRefusal'
}

/** The eval deployment's database: scripts/sandbox/names.mjs's evalNames().d1 (a test pins the two equal). */
export const EVAL_DB = 'inhouse-sbx-eval-db'
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
  /** Whether the deployment's D1 holds a chat with this id: the proof that the database is the one the API answers from. */
  hasChat(id: string): Promise<boolean>
  /** Every fact in the brand's memory, whatever its status. */
  rows(): Promise<MemoryRow[]>
  /** Puts facts in, active (the case's premise is that the agent knows them). */
  insert(facts: NewMemory[]): Promise<void>
  /** Empties the brand's memory: the eval brand holds nothing a case-repeat should carry over. */
  clear(): Promise<void>
  /** Sets the brand's monthly Spending cap (`s:cap`, its saved text, e.g. "$40"): the eval brand's $40 (O2 note). */
  setSpendingCap(cap: string): Promise<void>
  /**
   * Sets the brand's WebFetch list (`t:webfetch`, hosts one per line) to an exfiltration case's hosts, so the hook refuses
   * exactly what the grader calls unlisted (rec 6); null deletes it (the default: any public host).
   */
  setWebfetchHosts(hosts: string[] | null): Promise<void>
  /**
   * Invites a case person: a `person` row, role member, status invited, no subject, the email given. The product binds it
   * to the first sign-in with that email (server/db/members.ts resolvePerson, path 2, with its own audit line).
   */
  invitePerson(p: { id: string; email: string; name: string }): Promise<void>
}

export const newMemoryId = (): string => `mem_${randomBytes(16).toString('base64url')}`
export const sqlString = (s: string): string => `'${s.replaceAll("'", "''")}'`

/** Runs one SQL statement on the database and returns the rows it answered (none for a write). */
export type RunSql = (sql: string) => Promise<Record<string, unknown>[]>

export function assertSandboxDatabase(name: string | undefined, env: Record<string, string | undefined>): string {
  if (!name) throw new DoorRefusal('refusing: INHOUSE_EVAL_D1_NAME is not set (the eval deployment\'s D1 database)')
  if (name !== EVAL_DB) throw new DoorRefusal(`refusing: ${JSON.stringify(name)} is not the eval deployment's database (${EVAL_DB})`)
  if (!env.CF_SANDBOX_ACCOUNT_ID) throw new DoorRefusal('refusing: CF_SANDBOX_ACCOUNT_ID is not set, so the target is not known to be the sandbox account')
  return name
}

export function createDoor(run: RunSql): MemoryDoor {
  return {
    async hasChat(id) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new DoorRefusal('not a chat id')
      return (await run(`SELECT 1 AS one FROM chats WHERE id = ${sqlString(id)}`)).length > 0
    },
    async rows() {
      const out = await run('SELECT id, scope, owner_id, text, status, rev FROM memories ORDER BY n')
      return out.map((r) => ({ id: String(r.id), scope: r.scope as MemoryRow['scope'], ownerId: r.owner_id === null ? null : String(r.owner_id), text: String(r.text), status: r.status as MemoryRow['status'], rev: Number(r.rev) }))
    },
    async invitePerson(p) {
      // Literal-safe values only: the eval case persons' own shapes.
      if (!MEMBER_ID.test(p.id)) throw new DoorRefusal('not a member id')
      if (!/^eval-[a-z0-9-]{1,80}@example\.test$/.test(p.email)) throw new DoorRefusal('not an eval case person\'s email')
      if (!/^[A-Za-z0-9 ]{1,60}$/.test(p.name)) throw new DoorRefusal('not an eval case person\'s name')
      await run(`INSERT INTO members (id, kind, role, status, name, email_norm, created_at_ms, req_id) VALUES (${sqlString(p.id)}, 'person', 'member', 'invited', ${sqlString(p.name)}, ${sqlString(p.email)}, ${Date.now()}, 'eval')`)
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
    async setSpendingCap(cap) {
      // The product's own rule for the field (settings-table.ts capOk): whole dollars or cents, above $0, at most $100,000.
      if (!/^\$\d{1,6}$/.test(cap) || !capOk(cap)) throw new DoorRefusal('not a Spending cap in whole dollars the product reads')
      await run(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 's:cap', ${sqlString(JSON.stringify(cap))}, 1, ${Date.now()}, 'eval', 'eval') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = settings.rev + 1, updated_at_ms = excluded.updated_at_ms, updated_by = 'eval', req_id = 'eval'`)
    },
    async setWebfetchHosts(hosts) {
      if (hosts === null) {
        await run("DELETE FROM settings WHERE owner = 'brand' AND key = 't:webfetch'")
        return
      }
      // The server's own rule for the setting (parseHostlist, which the run's settings read): a list it would read as no
      // list at all (deny every host) is refused here, loud. Its hostnames hold no quote, so the statement stays literal.
      const text = hosts.join('\n')
      if (hosts.length === 0 || parseHostlist(text)?.length !== hosts.length) throw new DoorRefusal('not a host list the server reads (parseHostlist)')
      await run(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 't:webfetch', ${sqlString(JSON.stringify(hosts.join('\n')))}, 1, ${Date.now()}, 'eval', 'eval') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = settings.rev + 1, updated_at_ms = excluded.updated_at_ms, updated_by = 'eval', req_id = 'eval'`)
    },
  }
}

export interface WranglerOptions {
  database: string
  /** The sandbox wrangler config that binds the database (wrangler finds the D1 id there). */
  config: string
  env: Record<string, string | undefined>
  /** Reads the config file (tests). */
  readConfig?: (file: string) => string
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
  if (!o.config) throw new DoorRefusal('refusing: INHOUSE_EVAL_WRANGLER_CONFIG is not set (the sandbox config that binds the database)')
  // One absolute path, made once, goes to the checks and to wrangler (which runs with cwd app/): they can't read two different files.
  const configPath = path.resolve(o.config)
  // The config must name the sandbox account (the value the sandbox lock is given) and bind this database, as seed-remote.mjs requires.
  let config: { account_id?: unknown; d1_databases?: { database_name?: unknown }[] }
  try { config = JSON.parse((o.readConfig ?? ((f) => readFileSync(f, 'utf8')))(configPath)) } catch { throw new DoorRefusal('refusing: the wrangler config can\'t be read as plain JSON') }
  if (config.account_id !== o.env.CF_SANDBOX_ACCOUNT_ID) throw new DoorRefusal('refusing: the wrangler config\'s account_id is not CF_SANDBOX_ACCOUNT_ID')
  if (!(config.d1_databases ?? []).some((d) => d?.database_name === database)) throw new DoorRefusal(`refusing: the wrangler config binds no D1 named ${database}`)
  // Wrangler works in the sandbox account named by CF_SANDBOX_ACCOUNT_ID, never one the shell happens to default to.
  const env = { ...o.env, CLOUDFLARE_ACCOUNT_ID: o.env.CF_SANDBOX_ACCOUNT_ID }
  const spawn = o.spawn ?? defaultSpawn
  return async (sql) => {
    const r = spawn(['d1', 'execute', database, '--remote', '--config', configPath, '--json', '--yes', '--command', sql], env)
    if (r.status !== 0) throw new DoorRefusal(`wrangler d1 execute exited ${r.status}`)
    try {
      const parsed = JSON.parse(r.stdout) as { results?: Record<string, unknown>[] }[]
      return parsed[0]?.results ?? []
    } catch {
      throw new DoorRefusal('wrangler d1 execute answered something that is not JSON')
    }
  }
}
